// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
// Sort worker: exact back-to-front order of the gaussians visible at time t or a little later (inside their sequence
// window, opacity ≥ 1/255, in front of the camera), 16-bit counting sort on view depth at t. Never blocks rendering:
// the renderer keeps drawing with the last order received, for the next frames, while gaussians keep fading in;
// those visible up to `ahead` later are therefore kept too (the shader still culls at the exact time).
// 0.4.0: { type: "drop" } (or "add" with drop: [...]) hands over arrays already copied to the GPU only to be released
// here, off the display thread (freeing ≈ 300 MB there took 20 to 50 ms: one missed screen frame); sort answers carry the
// request number (req).
import { screwCentre } from "../format/trgz.js";

const sets = new Map();
const MIN_ALPHA = 1 / 255, BUCKETS = 65536;
const counts = new Uint32Array(BUCKETS);

self.onmessage = ({ data: m }) => {
  if (m.type === "add") {
    const n = m.count;
    sets.set(m.id, { n, pos: m.pos, vel: m.vel, opa: m.opa, mot: m.mot || null, trigs: m.trigs || null,
                     depth: new Float32Array(n), vis: new Uint32Array(n), keys: null });
  } else if (m.type === "remove") sets.delete(m.id);
  else if (m.type === "drop") { /* transferred buffers released with this message */ }
  else if (m.type === "sort") {
    const s = sets.get(m.id);
    if (!s) return;
    const t0 = performance.now();
    const { n, pos, vel, opa, depth, vis } = s, t = m.time, t2 = m.time + (m.ahead || 0), [a, b, c, d] = m.row;   // view z = a·x + b·y + c·z + d
    let k = 0;
    if (s.trigs) {                                            // HD 4DGS: screw motion (format/trgz.js), soft temporal cut
      const { tScale, cut } = s.trigs, mot = s.mot, x = [0, 0, 0], ctr = [0, 0, 0];
      const w = (i, tt) => {
        const sg = mot[i * 22 + 3], dd = (tt - pos[i * 4 + 3]) * tScale;
        let gm = Math.exp(-0.5 * (dd / sg) * (dd / sg));
        if (cut > 0) gm = Math.max((gm - cut) / (1 - cut), 0);
        return opa[i * 3] * gm;
      };
      for (let i = 0; i < n; i++) {
        const o3 = i * 3, p = i * 4, w0 = opa[o3 + 1], w1 = opa[o3 + 2];
        const now = t >= w0 && t < w1 && w(i, t) >= MIN_ALPHA;
        if (!now && (t2 < w0 || t2 >= w1 || w(i, t2) < MIN_ALPHA)) continue;
        x[0] = pos[p]; x[1] = pos[p + 1]; x[2] = pos[p + 2];
        screwCentre(x, mot.subarray(i * 22, i * 22 + 22), (t - pos[p + 3]) * tScale, ctr);
        const z = a * ctr[0] + b * ctr[1] + c * ctr[2] + d;
        if (z > -1e-3) continue;
        vis[k] = i; depth[k] = -z; k++;
      }
    } else for (let i = 0; i < n; i++) {
      const o3 = i * 3, p = i * 4, w0 = opa[o3 + 1], w1 = opa[o3 + 2], dt = t - pos[p + 3];
      const now = t >= w0 && t < w1 && opa[o3] * Math.exp(-0.5 * (dt / vel[p + 3]) ** 2) >= MIN_ALPHA;
      if (!now) {
        const dt2 = t2 - pos[p + 3];
        if (t2 < w0 || t2 >= w1 || opa[o3] * Math.exp(-0.5 * (dt2 / vel[p + 3]) ** 2) < MIN_ALPHA) continue;
      }
      const z = a * (pos[p] + vel[p] * dt) + b * (pos[p + 1] + vel[p + 1] * dt) + c * (pos[p + 2] + vel[p + 2] * dt) + d;
      if (z > -1e-3) continue;                                  // behind the camera (three.js looks down −z)
      const dist = -z;                                         // distance along the view axis (> 0)
      vis[k] = i; depth[k] = dist; k++;
    }
    // exact back-to-front order: LSD radix sort, two 16-bit passes over the float bits of the distance (positive
    // floats sort like their bit patterns); farthest first. ≈ 2 counting passes, exact to float precision.
    const order = new Float32Array(k);
    if (k > 0) {
      const keys = s.keys && s.keys.length >= k ? s.keys : (s.keys = new Uint32Array(n));
      const tmpI = s.tmpI && s.tmpI.length >= k ? s.tmpI : (s.tmpI = new Uint32Array(n));
      const tmpK = s.tmpK && s.tmpK.length >= k ? s.tmpK : (s.tmpK = new Uint32Array(n));
      const df = depth, du = s.depthBits || (s.depthBits = new Uint32Array(df.buffer));
      for (let j = 0; j < k; j++) keys[j] = 0xffffffff - du[j];        // descending distance
      counts.fill(0);
      for (let j = 0; j < k; j++) counts[keys[j] & 0xffff]++;
      for (let q = 1; q < BUCKETS; q++) counts[q] += counts[q - 1];
      for (let j = k - 1; j >= 0; j--) { const d = --counts[keys[j] & 0xffff]; tmpI[d] = vis[j]; tmpK[d] = keys[j]; }
      counts.fill(0);
      for (let j = 0; j < k; j++) counts[tmpK[j] >>> 16]++;
      for (let q = 1; q < BUCKETS; q++) counts[q] += counts[q - 1];
      for (let j = k - 1; j >= 0; j--) order[--counts[tmpK[j] >>> 16]] = tmpI[j];
    }
    self.postMessage({ id: m.id, req: m.req, order, visible: k, ms: performance.now() - t0 }, [order.buffer]);
  }
};
