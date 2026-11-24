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

/** Entiers de chaque composante (Float64Array) d'un flux empaqueté (mots ≤ 48 bits : exacts en double).
    0.4.0 : 32 bits de poids faible lus en entier (décalages et masques) ; seule une composante à cheval sur le bit 32
    passe par la division en double d'avant — mêmes entiers, ≈ 3 fois plus rapide. */
function deballer(octets, n, bits, m) {
  const sorties = bits.map(() => new Float64Array(n));
  const decalages = bits.map((_, j) => bits.slice(0, j).reduce((a, b) => a + b, 0));
  const masques = bits.map((b) => (b >= 32 ? 0xffffffff : 2 ** b - 1));
  const o0 = 0, o1 = n, o2 = 2 * n, o3 = 3 * n, m4 = Math.min(m, 4);
  for (let j = 0; j < bits.length; j++) {
    const s = decalages[j], b = bits[j], sortie = sorties[j], masque = masques[j];
    if (s + b <= 32) {                                         // dans les 4 octets de poids faible
      for (let i = 0; i < n; i++) {
        const bas = (m4 > 0 ? octets[o0 + i] : 0) | (m4 > 1 ? octets[o1 + i] << 8 : 0) | (m4 > 2 ? octets[o2 + i] << 16 : 0)
                  | (m4 > 3 ? octets[o3 + i] << 24 : 0);
        sortie[i] = b >= 32 ? bas >>> 0 : (bas >>> s) & masque;
      }
    } else {                                                   // au-delà du bit 32 (mots de 5 ou 6 octets)
      const p = 2 ** s, mod = 2 ** b;
      for (let i = 0; i < n; i++) {
        let mot = 0;
        for (let k = m - 1; k >= 0; k--) mot = mot * 256 + octets[k * n + i];
        sortie[i] = Math.floor(mot / p) % mod;
      }
    }
  }
  return sorties;
}

const pause = () => new Promise((ok) => setTimeout(ok));

/** f_rest_j of a layout with K coefficients per channel (all red, then green, then blue) is useful up to SH degree d. */
export const restUseful = (K, d) => (field) => !field.startsWith("f_rest_") || (Number(field.slice(7)) % Math.max(1, K)) < (d + 1) ** 2 - 1;

/** Decodes a .ftgsz (ArrayBuffer) into { header (PLY header text), fields, count, data (Float32Array, count × fields) }.
    options.shDegreeMax (0.4.0, light mode): colours above this degree are skipped (left at 0). */
export async function decodeFtgsz(tampon, options = {}) {
  const octets = new Uint8Array(tampon);
  if (new TextDecoder().decode(octets.subarray(0, 8)) !== "FTGSZ002") throw new Error("Not a .ftgsz file (version 2).");
  const lg = new DataView(tampon).getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(octets.subarray(12, 12 + lg)));
  const champs = [...h.ply.matchAll(/property float (\S+)/g)].map((m) => m[1]);
  const K = champs.filter((c) => c.startsWith("f_rest_")).length / 3;
  const useful = options.shDegreeMax >= 0 && K > 0 ? restUseful(K, options.shDegreeMax) : null;
  return { header: h.ply, ...(await decodeStreams(octets, h, 12 + lg, champs, { ...options, useful })) };
}

/** Streams of a .ftgsz-like container (header h, first stream at pos) → { fields, count, data } (also used by the HD
    4DGS .trgz files, format/trgz.js). */
export async function decodeStreams(octets, h, pos, champs, { signal, onProgress = () => {}, useful = null } = {}) {
  const n = h.gaussiennes, bl = h.bloc, nc = champs.length;
  const indice = Object.fromEntries(champs.map((c, i) => [c, i]));
  // useful(field) (0.4.0): a stream none of whose fields is useful is neither decompressed nor decoded, nor are its
  // bounds / palette / table (e.g. colours above the SH degree drawn); its fields stay 0 in the output
  const serves = (f) => !useful || !f.champs?.length || f.champs.some((c) => indice[c] !== undefined && useful(c));
  const skipped = new Set(h.flux.filter((f) => f.champs?.length && !serves(f)).flatMap((f) => [f.nom, f.nom + "_bornes", f.nom + "_palette", f.nom + "_table"]));
  const donnees = {};
  for (const f of h.flux) {
    signal?.throwIfAborted();
    const brut = octets.subarray(pos, pos + f.octets);
    if (!skipped.has(f.nom)) donnees[f.nom] = f.gzip ? await degzip(brut) : brut;
    pos += f.octets;
  }
  const sortie = new Float32Array(n * nc);   // copié après l'en-tête à la fin (longueur de l'en-tête quelconque)
  const ecrire = (i, c, v) => { sortie[i * nc + c] = v; };
  for (const [nf, f] of h.flux.entries()) {
    signal?.throwIfAborted();
    onProgress(nf / h.flux.length);
    if (skipped.has(f.nom)) continue;
    await pause();
    if (f.codage === "bloc") {
      const k = f.champs.length, d = donnees[f.nom + "_bornes"];
      const bornes = new Float32Array(d.slice().buffer);
      const ent = deballer(donnees[f.nom], n, f.bits, f.octets_mot);
      f.champs.forEach((champ, j) => {
        const c = indice[champ];
        if (c === undefined || (useful && !useful(champ))) return;
        const max = 2 ** f.bits[j] - 1, tr = (f.transfo || [])[j] || "", e = ent[j];
        const mode = tr === "couleur" ? 1 : tr === "sigmoide" ? 2 : 0;
        // bornes lues une fois par bloc (0.4.0) ; même calcul en double, mêmes valeurs float32
        for (let i0 = 0, blk = 0; i0 < n; i0 += bl, blk++) {
          const b = blk * 2 * k, mn = bornes[b + j], mx = bornes[b + k + j], fin = Math.min(n, i0 + bl);
          for (let i = i0; i < fin; i++) {
            let v = mn + (e[i] / max) * (mx - mn);
            if (mode === 1) v = (v - 0.5) / C0;
            else if (mode === 2) { v = Math.min(Math.max(v, 1e-7), 1 - 1e-7); v = Math.log(v / (1 - v)); }
            sortie[i * nc + c] = v;
          }
        }
      });
    } else if (f.codage === "quat") {
      const bq = f.bits[0], m = 2 ** bq - 1, s2 = Math.SQRT1_2, c = f.champs.map((x) => indice[x]);
      const [a0, a1, a2, im] = deballer(donnees[f.nom], n, [bq, bq, bq, 2], f.octets_mot), q = [0, 0, 0, 0], comp = [a0, a1, a2];
      for (let i = 0; i < n; i++) {
        let a = 0, s = 0;
        const g = im[i];
        for (let j = 0; j < 4; j++) {
          if (j === g) continue;
          q[j] = (comp[a][i] / m) * 2 * s2 - s2; s += q[j] * q[j]; a++;
        }
        q[g] = Math.sqrt(Math.max(0, 1 - s));
        const o = i * nc;
        sortie[o + c[0]] = q[0]; sortie[o + c[1]] = q[1]; sortie[o + c[2]] = q[2]; sortie[o + c[3]] = q[3];
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
  return { fields: champs, count: n, data: sortie };
}
