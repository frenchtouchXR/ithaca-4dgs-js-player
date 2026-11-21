// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// ITHACA HD 4DGS sequences (.trgz v1). The model keeps its own motion: each gaussian moves by a rigid screw motion
// (rotation + translation) whose rate follows a quadratic Bézier curve inside its life window, so its centre AND its
// orientation change over time. Written from the published equations of the model; no third-party code.
//
// File: "TRGSZ001", JSON header length (uint32 LE), JSON header, streams as in .ftgsz v2 (format/ftgsz.js). Fields:
// x y z, rot_0..3 (w x y z), scale_0..2 (log), f_dc_0..2, opacity (logit), f_rest_* (all red, then green, then blue,
// sh_source coefficients per channel), mu, log_sigma (seconds, model time), anchor_0..2, p0_0..5, p1_0..5, p2_0..5
// (Bézier control points: 0..2 translation rate ν, 3..5 rotation rate ω). Header: fps_modele, coupure, sh_degree.
//
// At model time t (s), Δt = t − μ, σ = e^log_sigma:
//   τ = clamp((Δt + 2σ) / 4σ, 0, 1);  [ν, ω] = (1−τ)² P0 + 2(1−τ)τ P1 + τ² P2
//   |ω|² ≥ 1e-8: a⊥ = a − (a·ω/|ω|²) ω, ν∥ = (ν·ω/|ω|²) ω ; otherwise a⊥ = a, ν∥ = ν
//   φ = ω Δt, ρ = ν∥ Δt, θ = |φ|: q = (cos θ/2, φ sin(θ/2)/θ); p = ρ + B φ×ρ + C φ×(φ×ρ), B = (1 − cos θ)/θ²,
//   C = (θ − sin θ)/θ³ (series when θ² < 1e-8); centre = R(q)(x − a⊥) + a⊥ + p; orientation = q ⊗ rot
//   opacity = α γ, γ = e^(−½(Δt/σ)²), soft cut c: γ = max((γ − c)/(1 − c), 0).
// Video time u (normalized over the whole video, u = frame / (total − 1)) → model time of a sequence starting at
// frame `first`: t = (u (total − 1) − first) / fps_modele.

import { decodeStreams } from "./ftgsz.js";

export const isTrgz = (buffer) => buffer.byteLength >= 8 && new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) === "TRGSZ001";

/** Decodes a .trgz (ArrayBuffer) into { trgz: header, fields, count, data (Float32Array, count × fields) }. */
export async function decodeTrgz(buffer, options = {}) {
  const octets = new Uint8Array(buffer);
  if (!isTrgz(buffer)) throw new Error("Not a .trgz file (HD 4DGS, version 1).");
  const lg = new DataView(buffer).getUint32(8, true);
  const h = JSON.parse(new TextDecoder().decode(octets.subarray(12, 12 + lg)));
  if (h.format !== "trgz" || h.version !== 1) throw new Error(`HD 4DGS: format ${h.format} v${h.version} not supported`);
  const fields = [];
  for (const f of h.flux) for (const c of f.champs || []) if (!fields.includes(c)) fields.push(c);
  return { trgz: h, ...(await decodeStreams(octets, h, 12 + lg, fields, options)) };
}

/** Centre of one gaussian at model time offset dt (s) from its central time → out[0..2]. m: motion row (anchor xyz,
    σ, P0 (6), P1 (6), P2 (6)), x: its position at the central time. Same calculation as the vertex shader. */
export function screwCentre(x, m, dt, out) {
  const s = m[3], tau = Math.min(Math.max((dt + 2 * s) / (4 * s), 0), 1);
  const b0 = (1 - tau) * (1 - tau), b1 = 2 * (1 - tau) * tau, b2 = tau * tau;
  const r = (j) => b0 * m[4 + j] + b1 * m[10 + j] + b2 * m[16 + j];
  let nx = r(0), ny = r(1), nz = r(2);
  const wx = r(3), wy = r(4), wz = r(5), w2 = wx * wx + wy * wy + wz * wz;
  let ax = m[0], ay = m[1], az = m[2];
  if (w2 >= 1e-8) {
    const d = Math.max(w2, 1e-10), ka = (ax * wx + ay * wy + az * wz) / d, kn = (nx * wx + ny * wy + nz * wz) / d;
    ax -= ka * wx; ay -= ka * wy; az -= ka * wz; nx = kn * wx; ny = kn * wy; nz = kn * wz;
  }
  const fx = wx * dt, fy = wy * dt, fz = wz * dt, rx = nx * dt, ry = ny * dt, rz = nz * dt;
  const t2 = fx * fx + fy * fy + fz * fz, th = Math.sqrt(t2);
  let qw, qs, B, C;
  if (t2 < 1e-8) { qw = 1 - t2 / 8; qs = 0.5 - t2 / 48; B = 0.5 - t2 / 24; C = 1 / 6 - t2 / 120; }
  else { qw = Math.cos(0.5 * th); qs = Math.sin(0.5 * th) / th; B = (1 - Math.cos(th)) / t2; C = (th - Math.sin(th)) / (t2 * th); }
  let qx = fx * qs, qy = fy * qs, qz = fz * qs;
  const ql = Math.hypot(qw, qx, qy, qz) || 1; qw /= ql; qx /= ql; qy /= ql; qz /= ql;
  const cx = fy * rz - fz * ry, cy = fz * rx - fx * rz, cz = fx * ry - fy * rx;
  const ex = fy * cz - fz * cy, ey = fz * cx - fx * cz, ez = fx * cy - fy * cx;
  const px = rx + B * cx + C * ex, py = ry + B * cy + C * ey, pz = rz + B * cz + C * ez;
  const vx = x[0] - ax, vy = x[1] - ay, vz = x[2] - az;
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty) + ax + px;
  out[1] = vy + qw * ty + (qz * tx - qx * tz) + ay + py;
  out[2] = vz + qw * tz + (qx * ty - qy * tx) + az + pz;
  return out;
}
