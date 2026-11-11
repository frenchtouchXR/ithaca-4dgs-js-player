// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// .4dgs v2: a whole ITHACA 4D video in one file. Sequences (.ftgsz v2 blocks), sound tracks and a thumbnail back to
// back, a JSON index at the end, "ITHACA4D" at both ends:
//   ["ITHACA4D"][version uint16 = 2][6 reserved] blocks… [JSON index][index offset uint64][index length uint32]["ITHACA4D"]
// Only the end of the file is read when opening (HTTP Range); each sequence is then a byte range of the same file.

const MAGIC = "ITHACA4D", TAIL = 20, PROBE = 65536;
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

/** Bytes [start, end] (end included) of url; start < 0: the last −start bytes. */
export async function fetchRange(url, start, end, { signal, fetchFn = fetch } = {}) {
  if (typeof Blob !== "undefined" && url instanceof Blob) {      // local file (File / Blob): sliced directly
    signal?.throwIfAborted();
    const part = start < 0 ? url.slice(Math.max(0, url.size + start)) : url.slice(start, end + 1);
    return { bytes: new Uint8Array(await part.arrayBuffer()), total: url.size, whole: part.size === url.size };
  }
  const r = await fetchFn(url, { signal, headers: { Range: start < 0 ? `bytes=${start}` : `bytes=${start}-${end}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const total = Number((/\/(\d+)$/.exec(r.headers.get("Content-Range") || "") || [])[1]) || null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (r.status === 200 && start >= 0)                     // server ignored Range: cut the requested part
    return { bytes: bytes.subarray(start, end + 1), total: bytes.length, whole: false };
  return { bytes, total, whole: r.status === 200 };
}

/** A .4dgs address or local file (File: by its name). */
export const is4dgs = (src) => /\.4dgs($|[?#])/i.test(String((src && src.name) || src || ""));

/** Reads the index of a .4dgs file. */
export async function open4dgs(url, { signal, fetchFn } = {}) {
  let q = await fetchRange(url, -PROBE, null, { signal, fetchFn });
  let b = q.bytes;
  if (b.length < TAIL || ascii(b, b.length - 8, 8) !== MAGIC) throw new Error(".4dgs: end signature missing");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), k = b.length - TAIL;
  const at = Number(v.getBigUint64(k, true)), len = v.getUint32(k + 8, true);
  // file size: told by the server (Content-Range), or else deduced from the tail itself (the index ends TAIL bytes
  // before the end of the file) when the page may not read Content-Range (CORS rule exposing no header)
  const size = q.whole ? b.length : q.total || at + len + TAIL;
  let base = size - b.length;
  if (at + len !== size - TAIL || base < 0) throw new Error(".4dgs: inconsistent index position");
  if (at < base) {                                       // index longer than the probe: fetched on its own
    q = await fetchRange(url, at, at + len - 1, { signal, fetchFn });
    b = q.bytes; base = at;
  }
  const index = JSON.parse(new TextDecoder().decode(b.subarray(at - base, at - base + len)));
  if (index.format !== "4dgs" || index.version !== 2) throw new Error(`.4dgs: format ${index.format} v${index.version} not supported`);
  return index;
}
