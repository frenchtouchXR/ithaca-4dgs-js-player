// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// Binary little-endian PLY reader for 4DGS models: float properties only (as written by the ITHACA pipeline and by
// the .ftgsz decoder). Returns the same shape as decodeFtgsz: { header, fields, count, data }.

export function parsePlyHeader(text) {
  const comments = {};
  for (const m of text.matchAll(/^comment (\S+)\s*(.*)$/gm)) comments[m[1]] = m[2].trim();
  const fields = [...text.matchAll(/^property (\S+) (\S+)$/gm)].map((m) => {
    if (m[1] !== "float") throw new Error(`PLY property ${m[2]}: type ${m[1]} not supported (float only)`);
    return m[2];
  });
  const count = Number((/^element vertex (\d+)$/m.exec(text) || [])[1]);
  return { comments, fields, count };
}

export function readPly(buffer) {
  const head = new TextDecoder("latin1").decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1 << 16)));
  const end = head.indexOf("end_header\n");
  if (!head.startsWith("ply") || end < 0) throw new Error("Not a PLY file");
  if (!/format binary_little_endian 1\.0/.test(head)) throw new Error("PLY: binary little-endian expected");
  const header = head.slice(0, end + 11);
  const { fields, count } = parsePlyHeader(header);
  const start = header.length;
  const data = start % 4 === 0
    ? new Float32Array(buffer, start, count * fields.length)
    : new Float32Array(buffer.slice(start, start + count * fields.length * 4));
  return { header, fields, count, data };
}
