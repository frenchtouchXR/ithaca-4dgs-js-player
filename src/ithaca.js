// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// ITHACA platform sources: share links of 4D videos and the Featured 4DGS gallery (public JSON of www.ithaca.eu, the
// same data as the ITHACA headset app). Nothing private: no account, no key.
//
//   shareToken("https://www.ithaca.eu/?ithaca_partage=AbC…")  → "AbC…"   (also "ithaca:AbC…" or the bare token)
//   await resolveShare("AbC…")   → { title, fps, frames, framing, soundOffset, file, sequences, sounds, … }
//   await listFeatured({ sort: "popular", perPage: 20 })   → { total, page, perPage, categories, types, videos: [...] }

export const ITHACA_SERVER = "https://www.ithaca.eu";
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** Token of an ITHACA share link ("…?ithaca_partage=<token>", "ithaca:<token>" or the bare token), else null. */
export function shareToken(src) {
  if (typeof src !== "string") return null;
  const s = src.trim();
  if (s.startsWith("ithaca:")) return TOKEN.test(s.slice(7)) ? s.slice(7) : null;
  if (TOKEN.test(s) && !/\.(4dgs|ftgsz|ply|json)$/i.test(s)) return s;
  try {
    const t = new URL(s, globalThis.location?.href).searchParams.get("ithaca_partage");
    return t && TOKEN.test(t) ? t : null;
  } catch { return null; }
}

/** Public share page of a token. */
export const shareUrl = (token, server = ITHACA_SERVER) => `${server}/?ithaca_partage=${encodeURIComponent(token)}`;

async function getJson(url, { signal, fetchFn = (...a) => fetch(...a) } = {}) {
  const r = await fetchFn(url, { signal, credentials: "omit" });
  const text = (await r.text()).replace(/^﻿/, "");
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error((body && body.erreur) || `HTTP ${r.status} for ${url}`);
  if (!body) throw new Error(`Invalid answer from ${url}`);
  return body;
}

const ajax = (server, params) => `${server}/wp-admin/admin-ajax.php?${new URLSearchParams(params)}`;

/** Description of a shared 4D video (each call counts one view, like opening the share page). Sequence and sound
    links are signed and expire after a while: call again to refresh them. */
export async function resolveShare(token, { server = ITHACA_SERVER, signal, fetchFn } = {}) {
  if (!TOKEN.test(String(token))) throw new Error("Not an ITHACA share token.");
  const d = await getJson(ajax(server, { action: "ithaca_app_partage", j: token }), { signal, fetchFn });
  const file = d.fichier && d.fichier.url && String(d.fichier.format || "").toLowerCase() === "4dgs" ? d.fichier.url : null;
  return {
    token, title: d.titre || "", fps: Number(d.fps) || 30, frames: Number(d.total) || 0,
    framing: d.cadrage || null, soundOffset: Number(d.decalage_son) || 0, version: d.version || "",
    file,                                                     // single .4dgs file of the video, when there is one
    sequences: (d.sequences || []).map((s) => ({ url: s.url, format: s.format || "", first: Number(s.premiere) || 0, frames: Number(s.images) || 0 })),
    sounds: [...(d.sons || []), ...(d.sons_ogg || [])].filter((u) => typeof u === "string"),
    effects: d.effets || null,                                // scene effects of the ITHACA viewer (not rendered here)
    pageUrl: shareUrl(token, server),
  };
}

const SORTS = { recent: "recent", popular: "populaire", name: "nom" };

/** One page of the Featured 4DGS gallery of ITHACA. */
export async function listFeatured({ query = "", sort = "recent", perPage = 20, page = 1, category = "", type = "",
                                     headset = false, server = ITHACA_SERVER, signal, fetchFn } = {}) {
  const d = await getJson(ajax(server, { action: "ithaca_app_vitrine", q: query, tri: SORTS[sort] || "recent",
                                         par: perPage > 20 ? 50 : 20, page, cat: category, type, casque: headset ? 1 : 0 }),
                          { signal, fetchFn });
  return {
    total: Number(d.total) || 0, page: Number(d.page) || page, perPage: Number(d.par) || perPage,
    categories: d.categories || {}, types: d.types || {},
    videos: (d.partages || []).map((x) => ({
      token: x.jeton, title: x.titre || "", creator: x.createur || "", views: Number(x.vues) || 0,
      category: x.categorie || "", type: x.type || "", headset: Boolean(x.casque), download: Boolean(x.telechargement),
      duration: Number(x.duree_s) || 0, gaussians: Number(x.gaussiennes) || 0, bytes: Number(x.octets) || 0,
      thumbnail: x.vignette || "", animatedThumbnail: x.anim || "", pageUrl: shareUrl(x.jeton, server),
    })),
  };
}
