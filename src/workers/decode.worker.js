// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
// Decode worker: .ftgsz or PLY bytes → packed GPU layout (pack.js), off the main thread.
import { decodeFtgsz } from "../format/ftgsz.js";
import { readPly } from "../format/ply.js";
import { packHD, packLQ, packTrigs } from "../format/pack.js";
import { decodeTrgz, isTrgz } from "../format/trgz.js";

self.onmessage = async ({ data: { id, buffer, seq } }) => {
  try {
    const t0 = performance.now();
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
    const trigs = isTrgz(buffer);                                 // HD 4DGS (.trgz)
    const model = trigs ? await decodeTrgz(buffer) : head === "FTGSZ002" ? await decodeFtgsz(buffer) : readPly(buffer);
    const t1 = performance.now();
    const p = trigs ? packTrigs(model, seq) : model.fields.includes("scale_t") ? packLQ(model, seq) : packHD(model);   // HD 4DGS, Low Quality or HD
    p.ms = { decode: t1 - t0, pack: performance.now() - t1 };
    const t = p.textures, s = p.sort;
    const moves = [t.A.buffer, t.B.buffer, t.C.buffer, t.D.buffer, s.pos.buffer, s.vel.buffer, s.opa.buffer];
    if (trigs) moves.push(t.E.buffer, t.F.buffer, s.mot.buffer);
    else if (t.F) moves.push(t.F.buffer);                         // HD au degré 2–3 : couleurs complètes
    self.postMessage({ id, packed: p }, moves);
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
