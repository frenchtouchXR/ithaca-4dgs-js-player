// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
// Device classes used for the automatic settings of Ithaca4DGS (0.4.0): light mode, parallel decodes, memory budget.

const nav = () => (typeof navigator !== "undefined" ? navigator : {});

/** Phone, tablet or headset: mobile user agent (Meta Quest included), iPad seen as a Mac, or less than 4 GB of memory. */
export function isMobile() {
  const n = nav(), ua = n.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile|Quest/i.test(ua) || (n.maxTouchPoints > 1 && /Macintosh/.test(ua))
    || !!(n.deviceMemory && n.deviceMemory < 4);
}

/** Decodes run in parallel: desktop one per 4 cores, 2 to 8 (4 at most under 8 GB declared, 2 under 4 GB); phones of
    10 cores and 8 GB 4, of 8 cores and 8 GB 3, else 2 (each running decode holds ≈ 250 MB or more). */
export function decoderCount(mobile = isMobile()) {
  const n = nav(), cores = n.hardwareConcurrency || 4;
  if (!mobile) {
    const mem = n.deviceMemory || 8;
    return Math.min(mem >= 8 ? 8 : mem >= 4 ? 4 : 2, Math.max(2, Math.floor(cores / 4)));
  }
  const mem = n.deviceMemory || 4;
  return cores >= 10 && mem >= 8 ? 4 : cores >= 8 && mem >= 8 ? 3 : 2;
}

/** Memory granted to the sequences kept loaded (MB): phones 1 800; desktop with a dedicated GPU (NVIDIA, AMD Radeon
    RX / Pro, Intel Arc) 8 000; Apple (shared memory) 4 000; other computers 3 000. */
export function memoryBudgetMB(gl, mobile = isMobile()) {
  if (mobile) return 1800;
  let name = "";
  try {
    name = String(gl.getParameter(gl.RENDERER) || "");
    if (!/NVIDIA|GeForce|Quadro|RTX|Radeon|Intel|Apple|Arc/i.test(name)) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || name);
    }
  } catch (e) { /* unknown GPU */ }
  if (/NVIDIA|GeForce|Quadro|RTX|Radeon (RX|Pro)|Intel\(R\) Arc|Arc A\d/i.test(name)) return 8000;
  if (/Apple/i.test(name)) return 4000;
  return 3000;
}
