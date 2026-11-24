// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
// Decode worker: .ftgsz, .trgz or PLY bytes → packed GPU layout (pack.js), off the main thread; arrays transferred.
// 0.4.0: several of these run in parallel (Ithaca4DGS `decoders`); light mode (colours up to SH degree 1, streams above
// neither decompressed nor decoded); sequence window widened to the training frames here (transitions); sides of the
// junction models with the neighbour sequences extracted here (format/junction.js), not copied by the display thread.
//   in : { id, buffer, seq, light, win: [w0, w1] | null, junctions: { N, left, right } | null }
//   out: { id, packed, left, right }  or  { id, error }
import { decodeFtgsz } from "../format/ftgsz.js";
import { readPly } from "../format/ply.js";
import { packHD, packLQ, packTrigs } from "../format/pack.js";
import { decodeTrgz, isTrgz } from "../format/trgz.js";
import { extractSide, packedBuffers } from "../format/junction.js";

self.onmessage = async ({ data: { id, buffer, seq, light = false, win = null, junctions = null } }) => {
  try {
    const t0 = performance.now();
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
    const trigs = isTrgz(buffer);                                 // HD 4DGS (.trgz)
    const shDegreeMax = light ? 1 : 3;
    const model = trigs ? await decodeTrgz(buffer, { shDegreeMax }) : head === "FTGSZ002" ? await decodeFtgsz(buffer, { shDegreeMax }) : readPly(buffer);
    const t1 = performance.now();
    const p = trigs ? packTrigs(model, seq, { light }) : model.fields.includes("scale_t") ? packLQ(model, seq, { light }) : packHD(model, { light });
    if (win) {                                                    // transitions: every gaussian kept over the training frames
      const B = p.textures.B, opa = p.sort.opa, f = new Float32Array(win), u = new Uint32Array(f.buffer);
      for (let i = 0; i < p.count; i++) { B[i * 4 + 2] = u[0]; B[i * 4 + 3] = u[1]; opa[i * 3 + 1] = win[0]; opa[i * 3 + 2] = win[1]; }
    }
    const t2 = performance.now();
    let left = null, right = null;
    if (junctions) {
      const { N, left: zl, right: zr } = junctions;
      // other formats: one whole copy serves both sides
      if (!p.trigs && zl && zr) left = right = extractSide(p, zr, N);
      else { left = zl ? extractSide(p, zl, N) : null; right = zr ? extractSide(p, zr, N) : null; }
    }
    p.ms = { decode: t1 - t0, pack: t2 - t1, junction: performance.now() - t2 };
    const moves = new Set([...packedBuffers(p), ...(left ? packedBuffers(left) : []), ...(right ? packedBuffers(right) : [])]);
    self.postMessage({ id, packed: p, left, right }, [...moves]);
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
