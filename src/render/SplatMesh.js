// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// Renderer of one 4DGS sequence at a time, behind a small interface so that it can be swapped for another splat
// engine later:   setData(packed) → handle ; useData(handle) ; setOrder(handle, order, visible) ; setTime(t) ;
//                 setFade(opacity, window) ; setBox(mode, center, half, toScene) ; disposeData(handle) ; dispose()
import * as THREE from "three";
import { vertexShader, fragmentShader } from "./shaders.js";

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
        uOpacity: { value: 1 }, uWinOn: { value: 0 }, uWin: { value: new THREE.Vector2() },
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

  /** Creates the GPU textures of a packed sequence (uploaded lazily, or ahead with upload()). */
  setData(packed) {
    const { width: w, height: h, textures: t } = packed;
    return { count: packed.count, shScale: packed.shScale, uploaded: 0,
             tex: [texture(t.A, w, h, true), texture(t.B, w, h, false), texture(t.C, w, h, false), texture(t.D, w, h, false)],
             order: null, visible: 0 };
  }

  /** Uploads one more texture of handle (call once per frame ahead of a switch: no hitch at the switch). */
  upload(handle, renderer) {
    if (handle.uploaded >= handle.tex.length) return true;
    renderer.initTexture(handle.tex[handle.uploaded++]);
    return handle.uploaded >= handle.tex.length;
  }

  useData(handle) {
    const u = this.material.uniforms;
    this.current = handle;
    [u.uA.value, u.uB.value, u.uC.value, u.uD.value] = handle ? handle.tex : [null, null, null, null];
    u.uShScale.value = handle ? handle.shScale : 0;
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

  /** Transitions between sequences: opacity weight of the sequence drawn, and its time window [w0, w1) (its
      training frames) instead of the one stored with each gaussian (its core); window null: the stored one. */
  setFade(opacity, window) {
    const u = this.material.uniforms;
    u.uOpacity.value = opacity;
    u.uWinOn.value = window ? 1 : 0;
    if (window) u.uWin.value.set(window[0], window[1]);
  }

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
  }

  disposeData(handle) {
    if (!handle) return;
    for (const t of handle.tex) t.dispose();
    if (this.current === handle) this.useData(null);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
