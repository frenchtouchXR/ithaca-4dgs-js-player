// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// Renderer of one 4DGS sequence at a time, behind a small interface so that it can be swapped for another splat
// engine later:   setData(packed) → handle ; upload(handle, renderer, maxBytes) ; useData(handle) ;
//                 setOrder(handle, order, visible) ; setTime(t) ; setFade(opacity) ; setSideWeights(w1, w2) ;
//                 setBox(mode, center, half, toScene) ; releaseData(handle) ; disposeData(handle) ; dispose()
// 0.4.0: textures uploaded by bands of rows within a byte budget (render/gpuTextures.js) instead of one texImage2D each;
// junction models of the crossfade (format/junction.js) drawn with the weights of their two sides.
import * as THREE from "three";
import { vertexShader, fragmentShader } from "./shaders.js";
import { textureJob, uploadJobs, release } from "./gpuTextures.js";

const QUAD = new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]);

/** Quad geometry with a per-instance splat index of `capacity` entries (0: none yet). */
function quadGeometry(capacity) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(QUAD, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  if (capacity > 0) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("splatIndex", a);
  }
  g.instanceCount = 0;
  return g;
}

function texture(data, w, h, float) {
  const t = new THREE.DataTexture(data, w, h, float ? THREE.RGBAFormat : THREE.RGBAIntegerFormat,
                                  float ? THREE.FloatType : THREE.UnsignedIntType);
  t.internalFormat = float ? "RGBA32F" : "RGBA32UI";
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

// neutral 1-texel textures bound to the HD 4DGS samplers for the other formats (an integer sampler must never see a
// float texture: the draw would fail)
let NEUTRAL = null;
const neutral = () => NEUTRAL || (NEUTRAL = { E: texture(new Float32Array(4), 1, 1, true), F: texture(new Uint32Array(4), 1, 1, false) });

export class SplatMesh extends THREE.Mesh {
  constructor() {
    const geometry = quadGeometry(0);
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader, fragmentShader, transparent: true, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide,                             // quad winding depends on the splat axes (and on mirrors)
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uA: { value: null }, uB: { value: null }, uC: { value: null }, uD: { value: null },
        uTime: { value: 0 }, uShScale: { value: 0 }, uViewport: { value: new THREE.Vector2(1, 1) },
        uCamPos: { value: new THREE.Vector3() }, uBoxMode: { value: 0 }, uToScene: { value: new THREE.Matrix4() },
        uBoxCenter: { value: new THREE.Vector3() }, uBoxHalf: { value: new THREE.Vector3(1, 1, 1) }, uMaxAxis: { value: 1e6 },   // no cap on the splat size (as the reference gaussian rasterizers)
        uOpacity: { value: 1 },
        uTrigs: { value: 0 }, uE: { value: neutral().E }, uF: { value: neutral().F }, uTScale: { value: 1 }, uTCut: { value: 0 },
        uShDeg: { value: 0 }, uSideW: { value: new THREE.Vector2(1, 1) },
      },
    });
    // attribute 0 must be the per-vertex one: ANGLE on Direct3D 11 (Chrome / Edge on Windows) otherwise repeats the
    // first instance of an instanced attribute bound to location 0 (one splat drawn instead of all)
    material.index0AttributeName = "position";
    super(geometry, material);
    this.frustumCulled = false;
    this.current = null;
    this._capacity = 0;
    this._vp = new THREE.Vector4();
    this._inv = new THREE.Matrix4();
    this.onRender = null;                                 // hook (renderer, camera) of the owner, once per draw
  }

  /** Prepares the GPU textures of a packed sequence (sent by upload(), ahead of use; else when first drawn). */
  setData(packed) {
    const { width: w, height: h, textures: t } = packed, tr = packed.trigs || null;
    const jobs = { A: textureJob(t.A, w, h), B: textureJob(t.B, w, h), C: textureJob(t.C, w, h), D: textureJob(t.D, w, h) };
    if (tr) jobs.E = textureJob(t.E, w, tr.heightE);                         // HD 4DGS motion
    if (tr && t.F) jobs.F = textureJob(t.F, w, tr.heightF);                  // HD 4DGS SH (none in light mode)
    const sf = !tr && packed.shFull ? packed.shFull : null;                    // SH degree 2–3 of the HD (FreeTimeGS) layout
    if (sf) jobs.F = textureJob(t.F, w, sf.heightF);
    const list = Object.values(jobs), bytes = list.reduce((a, j) => a + j.w * j.h * 16, 0);
    return { count: packed.count, shScale: packed.shScale, jobs, tex: list.map((j) => j.tex), trigs: tr, shFull: sf, order: null,
             visible: 0, bytes, remaining: bytes, renderer: null, junction: packed.junction ?? null };
  }

  /** Sends ≈ maxBytes more of handle's textures to the GPU (whole rows; default: up to the end of the next texture);
      true once all of them are there. Call it over the frames ahead of a switch: no hitch at the switch. */
  upload(handle, renderer, maxBytes) {
    if (!handle || handle.remaining <= 0) return true;
    handle.renderer = renderer;
    const list = Object.values(handle.jobs);
    if (maxBytes === undefined) {                                      // 0.3 behaviour: one texture per call
      const j = list.find((x) => x.row < x.h);
      maxBytes = j ? (j.h - j.row) * j.w * 16 : 0;
    }
    handle.remaining -= uploadJobs(renderer, list, maxBytes);
    if (handle.remaining < 0) handle.remaining = 0;
    return handle.remaining <= 0;
  }

  /** Once uploaded: the CPU arrays of the textures, handed over (e.g. transferred to a worker to be freed there). */
  releaseData(handle) {
    const out = [];
    if (!handle || handle.remaining > 0) return out;
    for (const j of Object.values(handle.jobs)) if (j.data) { out.push(j.data.buffer); j.data = null; }
    return out;
  }

  useData(handle) {
    const u = this.material.uniforms;
    this.current = handle;
    const J = handle ? handle.jobs : null;
    [u.uA.value, u.uB.value, u.uC.value, u.uD.value] = J ? [J.A.tex, J.B.tex, J.C.tex, J.D.tex] : [null, null, null, null];
    u.uShScale.value = handle ? handle.shScale : 0;
    const tr = handle && handle.trigs;
    u.uTrigs.value = tr ? 1 : 0;
    u.uE.value = tr ? J.E.tex : neutral().E;
    u.uF.value = J && J.F ? J.F.tex : neutral().F;
    u.uTScale.value = tr ? tr.tScale : 1;
    u.uTCut.value = tr ? tr.cut : 0;
    u.uShDeg.value = tr ? tr.shDegree : handle && handle.shFull ? handle.shFull.shDegree : 0;
    this._applyOrder();
  }

  setOrder(handle, order, visible) {
    handle.order = order;
    handle.visible = visible;
    if (handle === this.current) this._applyOrder();
  }

  _applyOrder() {
    const h = this.current, g = this.geometry;
    if (!h || !h.order) { g.instanceCount = 0; return; }
    let geo = g;
    if (h.count > this._capacity) {
      // never replace the instanced attribute in place (ANGLE / Direct3D 11 then leaves it disabled: one splat
      // drawn): a new geometry, 25 % larger than needed so that the next sequences fit
      this._capacity = Math.ceil(h.count * 1.25);
      geo = quadGeometry(this._capacity);
      this.geometry = geo;
      g.dispose();
    }
    const attr = geo.attributes.splatIndex;
    attr.array.set(h.order.subarray(0, h.visible));
    if (attr.clearUpdateRanges) { attr.clearUpdateRanges(); attr.addUpdateRange(0, h.visible); }
    attr.needsUpdate = true;
    geo.instanceCount = h.visible;
  }

  setTime(t) { this.material.uniforms.uTime.value = t; }

  /** Transitions between sequences: opacity weight of the sequence drawn (1 outside transitions). */
  setFade(opacity) { this.material.uniforms.uOpacity.value = opacity; }

  /** Junction model of a crossfade: weights of its two sides (previous, next), opacity mixed at constant density. */
  setSideWeights(w1, w2) { this.material.uniforms.uSideW.value.set(w1, w2); }

  raycast() {}                                          // splats are not pickable as a quad mesh

  setBox(mode, center, half, toScene) {
    const u = this.material.uniforms;
    u.uBoxMode.value = mode;
    if (center) u.uBoxCenter.value.fromArray(center);
    if (half) u.uBoxHalf.value.fromArray(half);
    if (toScene) u.uToScene.value.copy(toScene);
  }

  onBeforeRender(renderer, scene, camera) {
    const u = this.material.uniforms;
    renderer.getCurrentViewport(this._vp);
    u.uViewport.value.set(this._vp.z, this._vp.w);
    this._inv.copy(this.matrixWorld).invert();
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this._inv);
    if (this.onRender) this.onRender(renderer, camera);
    if (this.current && this.current.remaining > 0) this.upload(this.current, renderer, Infinity);   // not sent ahead: now
  }

  /** Frees the GPU textures of handle (kept in the renderer's reserve when there is one). */
  disposeData(handle) {
    if (!handle) return;
    for (const j of Object.values(handle.jobs || {})) {
      if (j.gl && handle.renderer) release(handle.renderer, j.gl);
      j.gl = null; j.data = null;
    }
    handle.remaining = 0;
    if (this.current === handle) this.useData(null);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
