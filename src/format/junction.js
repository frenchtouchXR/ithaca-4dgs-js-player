// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// Junction models of the crossfade between two neighbour sequences (videos rendered with a transition, 0.4.0).
// During the overlap of sequences a and a + 1 (frames start…end), both are drawn as ONE model sorted as a whole, so that
// their gaussians blend in the right depth order; each gaussian carries its side (1: a, 2: a + 1) in the free top byte
// of texture D (bits 24–25) and the shader weighs its opacity by the side's crossfade weight at constant density:
// α' = 1 − (1 − α)^w (format/pack.js, render/shaders.js).
//   extractSide(p, zone, N): side of a packed sequence for a junction — HD 4DGS: only the gaussians visible during the
//     overlap (α·γ ≥ 1/255 somewhere on its frames, as the ITHACA encoder computes it); other formats: a whole copy.
//     Done in the decode worker as soon as the sequence is decoded (no copy on the display thread).
//   mergeJunction(A, B, zone, seqA, seqB, N): both sides in one packed model (junction worker).
// zone: { a, start, end } (frames of the overlap); seqA, seqB: { trainFirst, trainFrames }; N: frames of the video.
import { TEX_WIDTH, TRIGS_E, TRIGS_F } from "./pack.js";

const ROW = 4;                                     // u32 per gaussian in textures A–D
const SORT = { pos: 4, vel: 4, opa: 3, mot: 22 };

/** HD 4DGS: indices of the gaussians visible during the overlap (soft temporal cut included). */
export function aliveInZone(p, z, N) {
  const n = p.count, A = p.textures.A, opa = p.sort.opa, mot = p.sort.mot, ts = p.trigs.tScale, c = p.trigs.cut || 0;
  const den = Math.max(1, N - 1), u0 = (z.start - 0.5) / den, u1 = (z.end + 0.5) / den, keep = [];
  for (let i = 0; i < n; i++) {
    const thr = c + (1 - c) / (255 * Math.max(opa[i * 3], 1e-12));
    if (thr >= 1) continue;
    const h = (Math.sqrt(-2 * Math.log(Math.max(thr, 1e-12))) * mot[i * 22 + 3]) / ts, mu = A[i * 4 + 3];
    if (mu + h >= u0 && mu - h <= u1) keep.push(i);
  }
  return keep;
}

/** Bit-exact copy of rows `idx` (or all rows) of `src`, `per` 32-bit words per row. */
function rows(src, per, idx, n) {
  const m = idx ? idx.length : n, out = new src.constructor(m * per);
  const s = new Uint32Array(src.buffer, src.byteOffset, src.length), t = new Uint32Array(out.buffer);
  if (!idx) { t.set(s.subarray(0, m * per)); return out; }
  for (let j = 0, q = 0; j < m; j++) for (let k = idx[j] * per, e = k + per; k < e;) t[q++] = s[k++];
  return out;
}

/** Side of packed sequence p for zone z: compact rows (no texture padding), every array its own (transferable). */
export function extractSide(p, z, N) {
  const idx = p.trigs ? aliveInZone(p, z, N) : null, n = idx ? idx.length : p.count, t = p.textures;
  const fStride = p.trigs ? TRIGS_F : 6;
  const tex = { A: rows(t.A, ROW, idx, p.count), B: rows(t.B, ROW, idx, p.count), C: rows(t.C, ROW, idx, p.count),
                D: rows(t.D, ROW, idx, p.count) };
  if (t.E) tex.E = rows(t.E, TRIGS_E * 4, idx, p.count);
  if (t.F) tex.F = rows(t.F, fStride * 4, idx, p.count);
  const sort = {};
  for (const [k, per] of Object.entries(SORT)) if (p.sort[k] && !(p.trigs && k === "vel")) sort[k] = rows(p.sort[k], per, idx, p.count);   // HD 4DGS: no velocity
  return { count: n, shScale: p.shScale, trigs: p.trigs || null, shFull: p.shFull || null, frames: p.frames, bounds: p.bounds,
           textures: tex, sort, sortTrigs: p.sort.trigs || null };
}

/** Can two sides be merged into one model (same layout and shader settings)? */
export function compatible(a, b) {
  if (!a || !b || !!a.trigs !== !!b.trigs) return false;
  if (a.trigs && (Math.abs(a.trigs.tScale - b.trigs.tScale) > 1e-9 * a.trigs.tScale || a.trigs.cut !== b.trigs.cut
                  || a.trigs.shDegree !== b.trigs.shDegree || !!a.textures.F !== !!b.textures.F)) return false;
  if (!a.trigs && ((a.shFull?.shDegree || 0) !== (b.shFull?.shDegree || 0))) return false;
  return (a.shScale > 0) === (b.shScale > 0);
}

/** Degree-1 colour bytes of texture D rescaled from scale `from` to scale `to` (≥ from). */
function rescaleD(D, n, from, to) {
  const f = from / to, b = (v) => Math.max(0, Math.min(255, Math.round(((v - 128) / 127) * f * 127 + 128)));
  for (let i = 0; i < n; i++) {
    const p = i * 4, d1 = D[p + 1], d2 = D[p + 2], d3 = D[p + 3];
    D[p + 1] = ((d1 & 0xffff) | (b((d1 >>> 16) & 255) << 16) | (b(d1 >>> 24) << 24)) >>> 0;
    D[p + 2] = (b(d2 & 255) | (b((d2 >>> 8) & 255) << 8) | (b((d2 >>> 16) & 255) << 16) | (b(d2 >>> 24) << 24)) >>> 0;
    D[p + 3] = ((d3 & 0xff000000) | b(d3 & 255) | (b((d3 >>> 8) & 255) << 8) | (b((d3 >>> 16) & 255) << 16)) >>> 0;
  }
}

/** Junction model: both sides in one packed sequence (same layout as format/pack.js), windows widened to the overlap,
    side of each gaussian in D (bits 24–25). */
export function mergeJunction(A, B, z, sA, sB, N) {
  const nA = A.count, n = nA + B.count, dt = 1 / Math.max(1, N - 1);
  const H = Math.max(1, Math.ceil(n / TEX_WIDTH)), texels = TEX_WIDTH * H * 4;
  const cat = (x, y, size) => { const o = new x.constructor(size); o.set(x); o.set(y, x.length); return o; };
  const tex = { A: cat(A.textures.A, B.textures.A, texels), B: cat(A.textures.B, B.textures.B, texels),
                C: cat(A.textures.C, B.textures.C, texels), D: cat(A.textures.D, B.textures.D, texels) };
  let HE = 0, HF = 0;
  if (A.textures.E) { HE = Math.max(1, Math.ceil((n * TRIGS_E) / TEX_WIDTH)); tex.E = cat(A.textures.E, B.textures.E, TEX_WIDTH * HE * 4); }
  if (A.textures.F) {
    const fs = A.trigs ? TRIGS_F : 6;
    HF = Math.max(1, Math.ceil((n * fs) / TEX_WIDTH));
    tex.F = cat(A.textures.F, B.textures.F, TEX_WIDTH * HF * 4);
  }
  // degree-1 colours of texture D: one scale for the model (the larger one; the other side's bytes rescaled)
  let shScale = A.shScale;
  if (A.shScale > 0 && B.shScale !== A.shScale) {
    shScale = Math.max(A.shScale, B.shScale);
    if (A.shScale < shScale) rescaleD(tex.D, nA, A.shScale, shScale);
    else rescaleD(tex.D.subarray(nA * 4), B.count, B.shScale, shScale);
  }
  const sort = {};
  for (const k of Object.keys(SORT)) if (A.sort[k] && B.sort[k]) sort[k] = cat(A.sort[k], B.sort[k], A.sort[k].length + B.sort[k].length);
  if (!sort.vel) sort.vel = new Float32Array(n * 4);
  // windows: each side from its own training start / up to its own training end, the other bound on the overlap (the
  // junction is drawn only inside it); same margins as format/pack.js
  const wA = new Float32Array([sA.trainFirst * dt - 0.02 * dt, z.end * dt + 0.995 * dt]);
  const wB = new Float32Array([z.start * dt - 0.02 * dt, (sB.trainFirst + sB.trainFrames - 1) * dt + 0.995 * dt]);
  const uA = new Uint32Array(wA.buffer), uB = new Uint32Array(wB.buffer);
  const Tb = tex.B, Td = tex.D, opa = sort.opa;
  for (let i = 0; i < n; i++) {
    const p = i * 4, side = i < nA ? 1 : 2, w = side === 1 ? wA : wB, u = side === 1 ? uA : uB;
    Tb[p + 2] = u[0]; Tb[p + 3] = u[1];
    Td[p + 3] = ((Td[p + 3] & 0x00ffffff) | (side << 24)) >>> 0;
    opa[i * 3 + 1] = w[0]; opa[i * 3 + 2] = w[1];
  }
  return {
    count: n, width: TEX_WIDTH, height: H, shScale, frames: A.frames, window: null, junction: z.a,
    shFull: A.shFull ? { ...A.shFull, heightF: HF } : null,
    trigs: A.trigs ? { ...A.trigs, heightE: HE, heightF: HF } : null,
    textures: tex, sort: { ...sort, ...(A.sortTrigs ? { trigs: A.sortTrigs } : {}) }, bounds: A.bounds,
  };
}

/** ArrayBuffers of a packed model (textures and sort arrays), to transfer it without a copy. */
export function packedBuffers(p) {
  const out = new Set();
  for (const v of [...Object.values(p.textures || {}), ...Object.values(p.sort || {})]) if (ArrayBuffer.isView(v)) out.add(v.buffer);
  return [...out];
}

/** Bytes of a packed model once loaded: GPU textures and the sort worker's copy (memory accounting). */
export function packedBytes(p) {
  let b = 0;
  for (const v of [...Object.values(p.textures || {}), ...Object.values(p.sort || {})]) if (ArrayBuffer.isView(v)) b += v.byteLength;
  return b;
}
