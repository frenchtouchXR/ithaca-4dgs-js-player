// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// ITHACA HD model (PLY fields) → compact GPU layout, 64 bytes per gaussian in four RGBA textures of width TEX_WIDTH:
//
//   A  RGBA32F   x, y, z, time                                    (full precision: position and time)
//   B  RGBA32UI  half(vx, vy), half(vz, duration), f32(w0), f32(w1) (sequence window kept exact)
//   C  RGBA32UI  half(sx, sy), half(sz, opacity), rotation: « smallest three » quaternion components on 16 bits each
//                + index of the largest (2 bits) — ≈ 2·10⁻⁵ rad: thin, very long splats keep their thickness (with 8 bits,
//                a 0.5° error turned a 5000 px × 1 px splat into a 40 px wide veil)
//   D  RGBA32UI  half(r, g), half(b) + SH degree 1 on 9 × 8 bits (scaled by shScale)
//
// HD gaussians: position(t) = position + velocity · (t − time); opacity(t) = opacity · exp(−½ ((t − time) / duration)²),
// zero outside the sequence window [w0, w1). Time is normalized over the whole video: t = frame / (frames − 1).
// Activations as in the ITHACA Unity package: scale = exp(scale_i), opacity = sigmoid(opacity),
// colour = 0.5 + C0 · f_dc, duration = max(exp(log_duration), min_duration).
// Also returns the arrays the sort worker needs and the robust bounds (1st and 99th percentiles of the positions).

import { parsePlyHeader } from "./ply.js";

export const TEX_WIDTH = 2048;
const C0 = 0.28209479177387814;

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);

/** float → IEEE half (round to nearest), as a 16-bit integer. */
function toHalf(v) {
  f32[0] = v;
  const x = u32[0], s = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e >= 31) return s | 0x7c00;                       // overflow → infinity (does not happen for these fields)
  if (e <= 0) {                                         // subnormal or zero
    if (e < -10) return s;
    m = (m | 0x800000) >> (1 - e);
    return s | ((m + 0x1000) >> 13);
  }
  return s | ((e << 10) + ((m + 0x1000) >> 13));      // + (not |): the rounding carry may bump the exponent
}
const half2 = (a, b) => (toHalf(a) | (toHalf(b) << 16)) >>> 0;
const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 127 + 128)));   // [−1, 1] → offset 8 bits
const S2 = Math.SQRT1_2;
/** Unit quaternion (x, y, z, w) → [c0 | c1 << 16, c2 | index << 16]: three smallest components on 16 bits. */
function quat16(q) {
  let im = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[im])) im = i;
  const sg = q[im] < 0 ? -1 : 1, c = [];
  for (let i = 0; i < 4; i++) if (i !== im) c.push(Math.max(0, Math.min(65535, Math.round(((sg * q[i] + S2) / (2 * S2)) * 65535))));
  return [(c[0] | (c[1] << 16)) >>> 0, (c[2] | (im << 16)) >>> 0];
}

/** Packs a decoded model ({ header, fields, count, data }) for the renderer. */
export function packHD(model, { direct = false } = {}) {
  // direct (converted Low Quality model): duration_lin, scale_lin_i are linear and win_0 / win_1 give the window explicitly
  const { comments } = parsePlyHeader(model.header);
  const { fields, count: n, data } = model, nf = fields.length;
  const at = Object.fromEntries(fields.map((f, i) => [f, i]));
  for (const f of direct ? ["x", "y", "z", "f_dc_0", "opacity", "scale_lin_0", "rot_0", "time", "duration_lin", "win_0"]
                        : ["x", "y", "z", "f_dc_0", "opacity", "scale_0", "rot_0", "time", "log_duration"])
    if (!(f in at)) throw new Error(`Not an ITHACA HD model: field ${f} missing`);
  if ((comments.time_units || "normalized") !== "normalized") throw new Error("ITHACA HD model: normalized time expected");
  const frames = Number(comments.n_frames) || 0;
  const frameDt = 1 / Math.max(frames - 1, 1);
  const minDuration = Math.max(Number(comments.min_duration) || 0, 1e-6);
  const useVelocity = comments.use_velocity !== "0" && "velocity_0" in at;
  const hasWindow = !direct && "seg_start" in at && "seg_end" in at;
  const rest = fields.filter((f) => f.startsWith("f_rest_")).length, K = rest / 3;     // coefficients per channel
  const hasSH = K >= 3;
  const sh = hasSH ? [0, 1, 2, K, K + 1, K + 2, 2 * K, 2 * K + 1, 2 * K + 2].map((k) => at["f_rest_" + k]) : [];

  // SH scale: largest |coefficient| (8-bit quantization over [−shScale, shScale])
  let shScale = 0;
  for (let i = 0; i < n && hasSH; i++) for (const c of sh) shScale = Math.max(shScale, Math.abs(data[i * nf + c]));
  shScale = shScale || 1;

  const H = Math.max(1, Math.ceil(n / TEX_WIDTH)), texels = TEX_WIDTH * H * 4;
  const A = new Float32Array(texels), B = new Uint32Array(texels), C = new Uint32Array(texels), D = new Uint32Array(texels);
  const sortPos = new Float32Array(n * 4), sortVel = new Float32Array(n * 4), sortOpa = new Float32Array(n * 3);
  const [ix, iy, iz, it, ild] = [at.x, at.y, at.z, at.time, direct ? at.duration_lin : at.log_duration];
  const [iv0, iv1, iv2] = useVelocity ? [at.velocity_0, at.velocity_1, at.velocity_2] : [-1, -1, -1];
  const [is0, is1, is2, io] = direct ? [at.scale_lin_0, at.scale_lin_1, at.scale_lin_2, at.opacity]
                                     : [at.scale_0, at.scale_1, at.scale_2, at.opacity];
  const sc = direct ? (v) => v : Math.exp;
  const [ir0, ir1, ir2, ir3] = [at.rot_0, at.rot_1, at.rot_2, at.rot_3];
  const [id0, id1, id2] = [at.f_dc_0, at.f_dc_1, at.f_dc_2];
  const iw0 = at.seg_start, iw1 = at.seg_end;
  const fw = new Float32Array(2), uw = new Uint32Array(fw.buffer);
  let wmin = Infinity, wmax = -Infinity;                // sequence window (single-file playback)

  for (let i = 0; i < n; i++) {
    const o = i * nf, p = i * 4;
    const x = data[o + ix], y = data[o + iy], z = data[o + iz], t = data[o + it];
    const vx = useVelocity ? data[o + iv0] : 0, vy = useVelocity ? data[o + iv1] : 0, vz = useVelocity ? data[o + iv2] : 0;
    const dur = direct ? data[o + ild] : Math.max(Math.exp(data[o + ild]), minDuration);
    if (hasWindow) { wmin = Math.min(wmin, data[o + iw0]); wmax = Math.max(wmax, data[o + iw1]); }
    // frame f lasts until f + 1 (ITHACA rule: sequences meet 1 % of a frame before the next one's first frame, where
    // the player switches). Here each window also overlaps that switch point a little (0.5 % / 1 % of a frame) so that
    // float rounding (CPU choice of sequence vs GPU culling) can never leave a frame with neither sequence: only the
    // active sequence is drawn, so the overlap itself is never visible.
    fw[0] = direct ? data[o + at.win_0] : hasWindow ? data[o + iw0] - 0.02 * frameDt : -1e30;
    fw[1] = direct ? data[o + at.win_1] : hasWindow ? data[o + iw1] + 0.995 * frameDt : 1e30;
    const opacity = 1 / (1 + Math.exp(-data[o + io]));
    // quaternion: PLY (w, x, y, z) → normalized (x, y, z, w)
    let qw = data[o + ir0], qx = data[o + ir1], qy = data[o + ir2], qz = data[o + ir3];
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    A[p] = x; A[p + 1] = y; A[p + 2] = z; A[p + 3] = t;
    B[p] = half2(vx, vy); B[p + 1] = half2(vz, dur); B[p + 2] = uw[0]; B[p + 3] = uw[1];
    C[p] = half2(sc(data[o + is0]), sc(data[o + is1]));
    C[p + 1] = half2(sc(data[o + is2]), opacity);
    [C[p + 2], C[p + 3]] = quat16([qx, qy, qz, qw]);
    const q = hasSH ? sh.map((c) => byte(data[o + c] / shScale)) : [128, 128, 128, 128, 128, 128, 128, 128, 128];
    D[p] = half2(0.5 + C0 * data[o + id0], 0.5 + C0 * data[o + id1]);
    D[p + 1] = (toHalf(0.5 + C0 * data[o + id2]) | (q[0] << 16) | (q[1] << 24)) >>> 0;
    D[p + 2] = (q[2] | (q[3] << 8) | (q[4] << 16) | (q[5] << 24)) >>> 0;
    D[p + 3] = (q[6] | (q[7] << 8) | (q[8] << 16)) >>> 0;
    sortPos[p] = x; sortPos[p + 1] = y; sortPos[p + 2] = z; sortPos[p + 3] = t;
    sortVel[p] = vx; sortVel[p + 1] = vy; sortVel[p + 2] = vz; sortVel[p + 3] = dur;
    sortOpa[i * 3] = opacity; sortOpa[i * 3 + 1] = fw[0]; sortOpa[i * 3 + 2] = fw[1];
  }

  // robust bounds: 1st / 99th percentiles of the positions, on ≈ 8192 samples (as the ITHACA site and Unity package)
  const step = Math.max(1, Math.floor(n / 8192)), m = Math.ceil(n / step), lo = [0, 0, 0], hi = [0, 0, 0];
  const v = new Float32Array(m);
  for (let a = 0; a < 3 && n > 0; a++) {
    for (let i = 0, k = 0; i < n; i += step, k++) v[k] = data[i * nf + [ix, iy, iz][a]];
    v.sort();
    lo[a] = v[Math.floor((m - 1) * 0.01)];
    hi[a] = v[Math.ceil((m - 1) * 0.99)];
  }

  return {
    count: n, width: TEX_WIDTH, height: H, shScale: hasSH ? shScale : 0, frames,
    // frames of the video this sequence covers (null: the whole video)
    window: hasWindow && n > 0 && frames > 1
      ? { first: Math.round(wmin * (frames - 1)), count: Math.round(wmax * (frames - 1)) - Math.round(wmin * (frames - 1)) + 1 }
      : null,
    textures: { A, B, C, D }, sort: { pos: sortPos, vel: sortVel, opa: sortOpa }, bounds: { min: lo, max: hi },
  };
}

// ── Low Quality ITHACA renders (4D gaussians) ──────────────────────────────────────────────────────────────────────────
// A 4D gaussian (x, y, z, t; four log-scales; 4D rotation from a left and a right quaternion) seen at time t is
// exactly an HD gaussian: its centre moves in a straight line (velocity = Σxt / Σtt), its 3D shape is constant
// (Σxx − Σxt Σxtᵀ / Σtt), its opacity is a bell around its central time (σ = √Σtt): the 4D rotation (left and right
// quaternions), 4D scaling and conditional (marginal) covariance in time, as in the ITHACA site reader. A Low Quality
// sequence has its own time over [0, 10) (frame k of n at t = 10 k / n): converted to the time of the whole video,
// u = (first + t · n / 10) / (total − 1). A gaussian is dropped when its temporal weight falls under 0.05: window
// [u0 − 2.4477 σ, u0 + 2.4477 σ). Only gaussians useful during the sequence are kept (never a cap on their number).
// The 3D covariance is stored as rotation + scales (eigen-decomposition), so that both qualities share the same GPU
// layout, shader and sort.

export const CUT_LQ = Math.sqrt(-2 * Math.log(0.05));

function rotation4d(l, r) {
  const nl = Math.hypot(...l) || 1, nr = Math.hypot(...r) || 1;
  const [a, b, c, d] = l.map((v) => v / nl), [p, q, s0, s] = r.map((v) => v / nr);
  const Ml = [[a, -b, -c, -d], [b, a, -d, c], [c, d, a, -b], [d, -c, b, a]];
  const Mr = [[p, q, s0, s], [-q, p, -s, s0], [-s0, s, p, -q], [-s, -s0, q, p]];
  const A = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => Ml[i][0] * Mr[0][j] + Ml[i][1] * Mr[1][j] + Ml[i][2] * Mr[2][j] + Ml[i][3] * Mr[3][j]));
  return [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => A[3 - i][3 - j]));
}

function covariance4d(logScales, l, r) {
  const R = rotation4d(l, r), s = logScales.map(Math.exp);
  const L = R.map((row) => row.map((v, j) => v * s[j]));
  return [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => L[i][0] * L[j][0] + L[i][1] * L[j][1] + L[i][2] * L[j][2] + L[i][3] * L[j][3]));
}

/** Symmetric 3 × 3 → eigenvalues and a rotation (columns = eigenvectors, det = +1), cyclic Jacobi. */
function eigenSym3(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30 * (a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 3; k++) {                       // A ← Jᵀ A J
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - sn * akq; a[k][q] = sn * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - sn * aqk; a[q][k] = sn * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {                       // V ← V J
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - sn * vkq; v[k][q] = sn * vkp + c * vkq;
      }
    }
  }
  const det = v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0])
            + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  return { values: [a[0][0], a[1][1], a[2][2]], rot: v };
}

/** Rotation matrix (rows) → quaternion (x, y, z, w). */
function quatFromMatrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s; }
  return [x, y, z, w];
}

/** Low Quality sequence → the equivalent HD model, then the same packing. seq: { first, frames, total }. */
export function packLQ(model, seq) {
  const { fields, count: n, data } = model, nf = fields.length;
  const at = Object.fromEntries(fields.map((f, i) => [f, i]));
  for (const f of ["x", "y", "z", "opacity", "t", "scale_t", "f_dc_0", "scale_0", "rot_0", "rot_r_0"])
    if (!(f in at)) throw new Error(`Not an ITHACA Low Quality model: field ${f} missing`);
  if (!seq || !seq.frames || !seq.total) throw new Error("Low Quality sequence: its frame count is not in the file; open the .4dgs or manifest.json of the video, or pass { frames } for a lone sequence");
  const N = Math.max(2, seq.total), kT = seq.frames / (10 * (N - 1)), u0 = seq.first / (N - 1);
  const rest = fields.filter((f) => f.startsWith("f_rest_")).length, K = rest / 3;
  const sh = K >= 3 ? [0, 1, 2, K, K + 1, K + 2, 2 * K, 2 * K + 1, 2 * K + 2].map((k) => "f_rest_" + k) : [];
  const out = [], g = (o, f) => data[o + at[f]];
  for (let i = 0; i < n; i++) {
    const o = i * nf;
    const opa = g(o, "opacity");
    if (1 / (1 + Math.exp(-opa)) < 1 / 255) continue;
    const S = covariance4d([g(o, "scale_0"), g(o, "scale_1"), g(o, "scale_2"), g(o, "scale_t")],
                           [g(o, "rot_0"), g(o, "rot_1"), g(o, "rot_2"), g(o, "rot_3")],
                           [g(o, "rot_r_0"), g(o, "rot_r_1"), g(o, "rot_r_2"), g(o, "rot_r_3")]);
    const tt = Math.max(S[3][3], 1e-12), xt = [S[0][3], S[1][3], S[2][3]], sigma = Math.sqrt(tt), t = g(o, "t");
    if (!Number.isFinite(sigma) || t + CUT_LQ * sigma < 0 || t - CUT_LQ * sigma >= 10) continue;   // never visible
    const cov = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]].map(([a, b]) => S[a][b] - (xt[a] * xt[b]) / tt);
    if (!cov.every(Number.isFinite)) continue;
    const { values, rot } = eigenSym3(cov);
    const [qx, qy, qz, qw] = quatFromMatrix(rot);
    const time = u0 + kT * t, dur = Math.max(1e-6, sigma * kT);
    out.push([g(o, "x"), g(o, "y"), g(o, "z"), time,
              xt[0] / tt / kT, xt[1] / tt / kT, xt[2] / tt / kT, dur,
              ...values.map((v) => Math.sqrt(Math.max(v, 1e-14))), opa, qw, qx, qy, qz,
              g(o, "f_dc_0"), g(o, "f_dc_1"), g(o, "f_dc_2"), ...sh.map((f) => g(o, f)),
              time - CUT_LQ * dur, time + CUT_LQ * dur]);
  }
  // HD-shaped model (linear scales and explicit window: see the fields below), then the common packing
  const F = ["x", "y", "z", "time", "velocity_0", "velocity_1", "velocity_2", "duration_lin", "scale_lin_0", "scale_lin_1",
             "scale_lin_2", "opacity", "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2",
             ...sh.map((_, k) => "f_rest_" + [0, 1, 2, 3, 4, 5, 6, 7, 8][k]), "win_0", "win_1"];
  const flat = new Float32Array(out.length * F.length);
  out.forEach((row, i) => flat.set(row, i * F.length));
  return packHD({ header: `ply\ncomment n_frames ${N}\nend_header\n`, fields: F, count: out.length, data: flat },
                        { direct: true });
}
