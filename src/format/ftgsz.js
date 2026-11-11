// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// ITHACA compressed 4DGS sequences (.ftgsz v2). A file is "FTGSZ002", the JSON header length (uint32 LE), the JSON
// header, then the streams (gzip when flagged, decompressed by the browser). Gaussians are stored in blocks (Morton
// order); each stream is decoded back to the float fields of the original PLY (same names, same header).
// Reference encoder: ftgsz.py (ITHACA pipeline). Same decoding as the ITHACA Unity package (FtgszFileReader.cs).

const C0 = 0.28209479177387814;

async function degzip(octets) {
  const flux = new Blob([octets]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(flux).arrayBuffer());
}

function float16(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/** Entiers de chaque composante (Float64Array) d'un flux empaqueté (mots ≤ 48 bits : exacts en double). */
function deballer(octets, n, bits, m) {
  const sorties = bits.map(() => new Float64Array(n));
  const puissances = bits.map((_, j) => 2 ** bits.slice(0, j).reduce((a, b) => a + b, 0)), modules = bits.map((b) => 2 ** b);
  for (let i = 0; i < n; i++) {
    let mot = 0;
    for (let k = m - 1; k >= 0; k--) mot = mot * 256 + octets[k * n + i];
    for (let j = 0; j < bits.length; j++) sorties[j][i] = Math.floor(mot / puissances[j]) % modules[j];
  }
  return sorties;
}

const pause = () => new Promise((ok) => setTimeout(ok));

/** Decodes a .ftgsz (ArrayBuffer) into { header (PLY header text), fields, count, data (Float32Array, count × fields) }. */
export async function decodeFtgsz(tampon, { signal, onProgress = () => {} } = {}) {
  const octets = new Uint8Array(tampon);
  if (new TextDecoder().decode(octets.subarray(0, 8)) !== "FTGSZ002") throw new Error("Not a .ftgsz file (version 2).");
  const lg = new DataView(tampon).getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(octets.subarray(12, 12 + lg)));
  const n = h.gaussiennes, bl = h.bloc;
  const champs = [...h.ply.matchAll(/property float (\S+)/g)].map((m) => m[1]), nc = champs.length;
  const indice = Object.fromEntries(champs.map((c, i) => [c, i]));
  const donnees = {};
  let pos = 12 + lg;
  for (const f of h.flux) {
    signal?.throwIfAborted();
    const brut = octets.subarray(pos, pos + f.octets);
    donnees[f.nom] = f.gzip ? await degzip(brut) : brut;
    pos += f.octets;
  }
  const sortie = new Float32Array(n * nc);   // copié après l'en-tête à la fin (longueur de l'en-tête quelconque)
  const ecrire = (i, c, v) => { sortie[i * nc + c] = v; };
  for (const [nf, f] of h.flux.entries()) {
    signal?.throwIfAborted();
    onProgress(nf / h.flux.length);
    await pause();
    if (f.codage === "bloc") {
      const k = f.champs.length, d = donnees[f.nom + "_bornes"];
      const bornes = new Float32Array(d.slice().buffer);
      const ent = deballer(donnees[f.nom], n, f.bits, f.octets_mot);
      f.champs.forEach((champ, j) => {
        const c = indice[champ], max = 2 ** f.bits[j] - 1, tr = (f.transfo || [])[j] || "";
        for (let i = 0; i < n; i++) {
          const b = Math.floor(i / bl) * 2 * k, mn = bornes[b + j], mx = bornes[b + k + j];
          let v = mn + (ent[j][i] / max) * (mx - mn);
          if (tr === "couleur") v = (v - 0.5) / C0;
          else if (tr === "sigmoide") { v = Math.min(Math.max(v, 1e-7), 1 - 1e-7); v = Math.log(v / (1 - v)); }
          ecrire(i, c, v);
        }
      });
    } else if (f.codage === "quat") {
      const bq = f.bits[0], m = 2 ** bq - 1, s2 = Math.SQRT1_2, c = f.champs.map((x) => indice[x]);
      const [a0, a1, a2, im] = deballer(donnees[f.nom], n, [bq, bq, bq, 2], f.octets_mot), q = [0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        let a = 0, s = 0;
        for (let j = 0; j < 4; j++) {
          if (j === im[i]) continue;
          q[j] = ([a0, a1, a2][a][i] / m) * 2 * s2 - s2; s += q[j] * q[j]; a++;
        }
        q[im[i]] = Math.sqrt(Math.max(0, 1 - s));
        for (let j = 0; j < 4; j++) ecrire(i, c[j], q[j]);
      }
    } else if (f.codage === "palette" || f.codage === "table") {
      const k = f.champs.length, c = f.champs.map((x) => indice[x]);
      let t;
      if (f.codage === "palette") {
        const p = donnees[f.nom + "_palette"], vue = new DataView(p.buffer, p.byteOffset, p.byteLength);
        t = new Float32Array(p.byteLength / 2);
        for (let i = 0; i < t.length; i++) t[i] = float16(vue.getUint16(2 * i, true));
      } else t = new Float32Array(donnees[f.nom + "_table"].slice().buffer);
      const idx = f.bits[0] > 0 ? deballer(donnees[f.nom], n, f.bits, f.octets_mot)[0] : new Float64Array(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) ecrire(i, c[j], t[idx[i] * k + j]);
    }
    // « zero » : déjà à 0 ; « donnees » : bornes, palettes, tables (lues ci-dessus)
  }
  onProgress(1);
  return { header: h.ply, fields: champs, count: n, data: sortie };
}
