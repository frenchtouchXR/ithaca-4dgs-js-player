// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
// Decode worker: .ftgsz or PLY bytes → packed GPU layout (pack.js), off the main thread.
import { decodeFtgsz } from "../format/ftgsz.js";
import { readPly } from "../format/ply.js";
import { packHD, packLQ } from "../format/pack.js";

self.onmessage = async ({ data: { id, buffer, seq } }) => {
  try {
    const t0 = performance.now();
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
    const model = head === "FTGSZ002" ? await decodeFtgsz(buffer) : readPly(buffer);
    const t1 = performance.now();
    const p = model.fields.includes("scale_t") ? packLQ(model, seq) : packHD(model);   // Low Quality or HD
    p.ms = { decode: t1 - t0, pack: performance.now() - t1 };
    const t = p.textures, s = p.sort;
    self.postMessage({ id, packed: p }, [t.A.buffer, t.B.buffer, t.C.buffer, t.D.buffer, s.pos.buffer, s.vel.buffer, s.opa.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
