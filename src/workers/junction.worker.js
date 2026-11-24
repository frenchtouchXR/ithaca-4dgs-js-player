// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
// Junction worker (0.4.0): receives the sides of each decoded sequence (extracted by the decode workers, transferred
// without a copy), merges two neighbours as soon as both are there (format/junction.js) and sends the junction model back
// (transferred). Each side is used once, then released. Nothing of this runs on the display thread.
//   in : { type: "config", N, seqs: [{ trainFirst, trainFrames }], zones: [{ a, start, end }] }
//        { type: "sides", k, gen, left, right }   (left: side of junction k − 1, right: of junction k)
//        { type: "forget", k, gen }               (sequence released)
//   out: { type: "junction", a, genA, genB, packed }  or  { type: "none", a, genA, genB, error? }
import { compatible, mergeJunction, packedBuffers } from "../format/junction.js";

let N = 2, seqs = [], zones = [];
const held = new Map();                                     // k → { gen, left, right }

function attempt(a) {
  const z = zones.find((x) => x.a === a), A = held.get(a), B = held.get(a + 1);
  if (!z || !A?.right || !B?.left) return;
  const sA = A.right, sB = B.left;
  A.right = null; B.left = null;
  try {
    if (!compatible(sA, sB)) { self.postMessage({ type: "none", a, genA: A.gen, genB: B.gen }); return; }
    const packed = mergeJunction(sA, sB, z, seqs[a], seqs[a + 1], N);
    self.postMessage({ type: "junction", a, genA: A.gen, genB: B.gen, packed }, packedBuffers(packed));
  } catch (e) {                                             // e.g. out of memory: hard cut at this junction
    self.postMessage({ type: "none", a, genA: A.gen, genB: B.gen, error: String(e?.message || e) });
  }
}

self.onmessage = ({ data: m }) => {
  if (m.type === "config") ({ N, seqs, zones } = m);
  else if (m.type === "sides") {
    held.set(m.k, { gen: m.gen, left: m.left || null, right: m.right || null });
    attempt(m.k - 1);
    attempt(m.k);
  } else if (m.type === "forget") {
    if (held.get(m.k)?.gen === m.gen) held.delete(m.k);
  }
};
