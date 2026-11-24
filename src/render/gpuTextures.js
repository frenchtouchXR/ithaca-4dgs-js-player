// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// GPU textures of the packed sequences, uploaded by bands of rows (0.4.0).
// three.js uploads a DataTexture in one texImage2D when it first draws it: ≈ 100 MB in one call for a HD 4DGS
// sequence of one million gaussians, a frozen screen for a few hundred milliseconds at every sequence. Here each texture
// is only reserved (texStorage2D), then filled by bands of rows (texSubImage2D) spread over the rendered frames within a
// byte budget per frame (Ithaca4DGS). The WebGL texture is handed to three.js as the one of a placeholder THREE.Texture
// that three never uploads itself (version 0: three only binds it).
// Reserve (desktop): reserving or deleting ≈ 400 MB of textures stalls the browser's GPU process for about one frame;
// textures of released sequences are kept (up to `reserveBytes` per renderer) and reused by the next sequence of the
// same width and a large enough height (rows beyond the gaussians keep stale values, never read). With a reserve, new
// textures get 3 % more rows so that they are reused more often.
import * as THREE from "three";

const pools = new WeakMap();                     // renderer → { list, bytes, max }

/** Reserve of released textures of a renderer (bytes: 0 = textures deleted at once). */
export function texturePool(renderer) {
  let p = pools.get(renderer);
  if (!p) pools.set(renderer, (p = { list: [], bytes: 0, max: 0 }));
  return p;
}

/** A player using the reserve of renderer (bytes it asks for); releasePool() when it is disposed: the reserve is
    given back to the GPU when its last user goes. */
export function retainPool(renderer, bytes) {
  const p = texturePool(renderer);
  p.users = (p.users || 0) + 1;
  p.max = Math.max(p.max, bytes);                // several videos on one renderer: the largest request
}

export function releasePool(renderer) {
  const p = pools.get(renderer);
  if (!p) return;
  p.users = Math.max(0, (p.users || 0) - 1);
  if (!p.users) { p.max = 0; emptyReserve(renderer); }
}

export function emptyReserve(renderer) {
  const p = pools.get(renderer);
  if (!p) return;
  const gl = renderer.getContext();
  for (const x of p.list) gl.deleteTexture(x.t);
  p.list = [];
  p.bytes = 0;
}

/** Placeholder of a texture uploaded here (bound by three.js, never uploaded by it). */
export function placeholder(w, h) {
  const t = new THREE.DataTexture(null, w, h);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;                                      // version 0: three.js binds properties.__webglTexture as it is
}

function allocate(renderer, w, h, float) {
  const gl = renderer.getContext(), pool = texturePool(renderer);
  if (pool.max > 0) {
    const k = pool.list.findIndex((x) => x.float === float && x.w === w && x.h >= h && x.h <= Math.ceil(1.1 * h) + 16);
    if (k >= 0) {
      const x = pool.list.splice(k, 1)[0];
      pool.bytes -= x.w * x.h * 16;
      return x;
    }
  }
  const hR = pool.max > 0 ? h + Math.ceil(0.03 * h) : h;
  const t = gl.createTexture();
  renderer.state.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA32F : gl.RGBA32UI, w, hR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { t, w, h: hR, float };
}

/** Texture (from upload()) given back: kept in the renderer's reserve, or deleted. */
export function release(renderer, x) {
  if (!x) return;
  const gl = renderer.getContext(), pool = texturePool(renderer);
  if (pool.max > 0) { pool.list.push(x); pool.bytes += x.w * x.h * 16; }
  else gl.deleteTexture(x.t);
  while (pool.bytes > pool.max && pool.list.length) {              // oldest first
    const y = pool.list.shift();
    pool.bytes -= y.w * y.h * 16;
    gl.deleteTexture(y.t);
  }
}

/** Job of one texture: { data (Float32Array | Uint32Array, w × h × 4), w, h, tex (placeholder), gl: null, row: 0 }. */
export function textureJob(data, w, h) {
  return { data, w, h, float: data instanceof Float32Array, tex: placeholder(w, h), gl: null, row: 0 };
}

/** Uploads at most ≈ maxBytes of the jobs (whole rows, at least one), in order; returns the bytes sent. */
export function uploadJobs(renderer, jobs, maxBytes = Infinity) {
  const gl = renderer.getContext();
  let done = 0;
  for (const j of jobs) {
    if (done >= maxBytes) break;
    if (j.row >= j.h) continue;
    if (!j.gl) {
      j.gl = allocate(renderer, j.w, j.h, j.float);
      renderer.properties.get(j.tex).__webglTexture = j.gl.t;
    }
    const rowBytes = j.w * 16, n = Math.max(1, Math.min(j.h - j.row, Math.floor((maxBytes - done) / rowBytes)));
    renderer.state.bindTexture(gl.TEXTURE_2D, j.gl.t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, j.row, j.w, n, j.float ? gl.RGBA : gl.RGBA_INTEGER, j.float ? gl.FLOAT : gl.UNSIGNED_INT,
                     j.data.subarray(j.row * j.w * 4, (j.row + n) * j.w * 4));
    j.row += n;
    done += n * rowBytes;
  }
  return done;
}
