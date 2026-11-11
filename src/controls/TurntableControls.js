// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// TurntableControls: optional camera manipulator for flat-screen pages (host scenes usually bring their own).
// A level turntable around a target, never any roll:
//   left drag / one finger ......... orbit (0.006 rad per pixel; pitch limited to ±1.5 rad, yaw free)
//   right or middle drag, Shift+drag  pan, "grab the scene", speed proportional to the orbit distance
//   wheel / two-finger pinch ....... zoom towards the target, exponential, within [0.02 R, 100 R]
//   two fingers moving ............. pan (midpoint of the fingers)
//   W A S D Q E (canvas focused) ... fly: forward / left / back / right / down / up, target carried along;
//                                     speed = orbit distance within [0.01 R, R] per second, ×4 with Shift
// No inertia: the camera stops when the pointer is released. R = radius of what is framed (fit()).
//
//   const controls = new TurntableControls(camera, renderer.domElement);
//   video.addEventListener("ready", () => controls.fit(video.boundingSphere()));
//   in the render loop: controls.update();
import * as THREE from "three";

const ORBIT = 0.006, PITCH_MAX = 1.5, ZOOM = 0.001, FOV = 45;
const KEYS = { KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0], KeyQ: [0, -1, 0], KeyE: [0, 1, 0] };

export class TurntableControls {
  constructor(camera, element) {
    this.camera = camera;
    this.element = element;
    this.target = new THREE.Vector3();
    this.distance = 3;
    this.yaw = 0.45;
    this.pitch = 0.12;
    this.radius = 1;
    this.enabled = true;
    this._pointers = new Map();
    this._keys = new Set();
    this._shift = false;
    this._last = 0;
    camera.up.set(0, 1, 0);
    camera.fov = FOV;
    camera.updateProjectionMatrix();
    if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
    element.style.touchAction = "none";
    element.style.outline = "none";

    const on = (t, f, o) => { element.addEventListener(t, f, o); return () => element.removeEventListener(t, f, o); };
    const onWin = (t, f) => { addEventListener(t, f); return () => removeEventListener(t, f); };
    const stop = () => this._keys.clear();
    this._off = [
      on("contextmenu", (e) => e.preventDefault()),
      on("pointerdown", (e) => this._down(e)),
      on("pointermove", (e) => this._move(e)),
      on("pointerup", (e) => this._up(e)),
      on("pointercancel", (e) => this._up(e)),
      on("wheel", (e) => this._wheel(e), { passive: false }),
      on("keydown", (e) => this._key(e, true)),
      on("keyup", (e) => this._key(e, false)),
      on("blur", stop),
      onWin("blur", stop),
      (() => { const f = () => { if (document.hidden) stop(); }; document.addEventListener("visibilitychange", f);
               return () => document.removeEventListener("visibilitychange", f); })(),
    ];
    this.update();
  }

  /** Frames a sphere ({ center, radius }, e.g. video.boundingSphere()): three-quarter view, slightly from above. */
  fit({ center, radius }) {
    this.radius = Math.max(radius, 0.01);
    this.target.copy(center);
    const aspect = Math.max(this.camera.aspect || 1, 0.1);
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * Math.min(1, aspect));
    this.distance = (this.radius / Math.sin(half)) * 1.1;
    this.yaw = 0.45;
    this.pitch = 0.12;
    this.camera.fov = FOV;
    this.camera.near = Math.max(1e-6, this.radius * 1e-4);
    this.camera.far = this.radius * 1e4;
    this.camera.updateProjectionMatrix();
    this._keys.clear();
    this.update();
  }

  // ── pointer ─────────────────────────────────────────────────────────────────────────────────────────────────
  _down(e) {
    if (!this.enabled) return;
    this.element.focus({ preventScroll: true });
    this.element.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  _move(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (this._pointers.size === 2) {
      const [a, b] = [...this._pointers.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const before = Math.hypot(p.x - other.x, p.y - other.y), after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0 && after > 0) this._zoomBy(before / after);
      this._pan(dx * 0.5, dy * 0.5);
    } else {
      const pan = e.pointerType === "mouse" && (e.buttons === 2 || e.buttons === 4 || e.shiftKey);
      pan ? this._pan(dx, dy) : this._orbit(dx, dy);
    }
    p.x = e.clientX; p.y = e.clientY;
  }

  _up(e) {
    this._pointers.delete(e.pointerId);
    this.element.releasePointerCapture?.(e.pointerId);
  }

  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;   // lines, pages → px
    this._zoomBy(Math.exp(dy * ZOOM));
  }

  _orbit(dx, dy) {
    this.yaw -= dx * ORBIT;                                       // drag right: the model turns right (grabbed)
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * ORBIT, -PITCH_MAX, PITCH_MAX);   // drag down: see more of the top
  }

  _pan(dx, dy) {
    const s = this.distance / Math.max(this.element.clientHeight, 1);
    const m = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(m[0], m[1], m[2]), up = new THREE.Vector3(m[4], m[5], m[6]);
    this.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);   // the content follows the cursor
  }

  _zoomBy(f) {
    this.distance = THREE.MathUtils.clamp(this.distance * f, 0.02 * this.radius, 100 * this.radius);
  }

  // ── keyboard flight ─────────────────────────────────────────────────────────────────────────────────────────
  _key(e, down) {
    this._shift = e.shiftKey;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) { this._keys.clear(); return; }
    if (!(e.code in KEYS)) return;
    if (down) {
      if (e.repeat && !this._keys.has(e.code)) return;            // auto-repeat after a blur: needs a fresh press
      this._keys.add(e.code);
    } else this._keys.delete(e.code);
    e.preventDefault();
  }

  _fly(dt) {
    if (!this._keys.size) return;
    const v = [0, 0, 0];
    for (const k of this._keys) KEYS[k].forEach((c, i) => { v[i] += c; });
    const m = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(m[0], m[1], m[2]);
    const back = new THREE.Vector3(m[8], m[9], m[10]);             // forward = −back, vertical part included
    const move = new THREE.Vector3().addScaledVector(right, v[0]).addScaledVector(back, v[2]).add(new THREE.Vector3(0, v[1], 0));
    if (move.lengthSq() === 0) return;
    const speed = THREE.MathUtils.clamp(this.distance, 0.01 * this.radius, this.radius) * (this._shift ? 4 : 1);
    this.target.addScaledVector(move.normalize(), speed * dt);
  }

  /** Call once per frame (before rendering). */
  update() {
    const now = performance.now();
    const dt = this._last ? Math.min((now - this._last) / 1000, 0.1) : 0;
    this._last = now;
    if (this.enabled) this._fly(dt);
    const h = this.distance * Math.cos(this.pitch);
    this.camera.position.set(this.target.x + Math.sin(this.yaw) * h, this.target.y + Math.sin(this.pitch) * this.distance,
                             this.target.z + Math.cos(this.yaw) * h);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  dispose() {
    for (const off of this._off) off();
    this._pointers.clear();
    this._keys.clear();
  }
}
