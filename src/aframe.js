// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// A-Frame component:  <a-entity ithaca-4dgs="src: video.4dgs; loop: true; autoplay: true; sound: true"></a-entity>
// src: any source of Ithaca4DGS (.4dgs, .ftgsz, .ply, manifest.json, ITHACA share link or token); frames: lone Low Quality sequence.
// Import after A-Frame. The entity's position / rotation / scale place the video like any other object.
import { Ithaca4DGS } from "./Ithaca4DGS.js";

export function registerIthaca4DGS(AFRAME = globalThis.AFRAME) {
  if (!AFRAME || AFRAME.components["ithaca-4dgs"]) return;
  AFRAME.registerComponent("ithaca-4dgs", {
    schema: { src: { type: "string" }, loop: { default: true }, autoplay: { default: true }, sound: { default: true }, frames: { default: 0 } },
    init() { this._build(); },
    update(old) { if (old && old.src !== undefined && old.src !== this.data.src) this._build(); },
    _build() {
      this.remove();
      if (!this.data.src) return;
      const scene = this.el.sceneEl;
      let listener = null;
      if (this.data.sound && scene.camera) {
        listener = scene.camera.children.find((c) => c.isAudioListener) || new AFRAME.THREE.AudioListener();
        if (!listener.parent) scene.camera.add(listener);
      }
      this.video = new Ithaca4DGS({ src: this.data.src, loop: this.data.loop, autoplay: this.data.autoplay, listener,
                                    frames: this.data.frames || null });
      for (const t of ["load", "ready", "waiting", "playing", "ended", "error", "progress"])
        this.video.addEventListener(t, (e) => this.el.emit("ithaca-4dgs-" + t, e, false));
      this.el.setObject3D("ithaca4dgs", this.video);
    },
    play() { this.video?.play(); },
    pause() { this.video?.pause(); },
    remove() { if (this.video) { this.el.removeObject3D("ithaca4dgs"); this.video.dispose(); this.video = null; } },
  });
}

registerIthaca4DGS();
