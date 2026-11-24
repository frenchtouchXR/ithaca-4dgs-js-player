// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// A-Frame component:  <a-entity ithaca-4dgs="src: video.4dgs; loop: true; autoplay: true; sound: true"></a-entity>
// src: any source of Ithaca4DGS (.4dgs, .ftgsz, .ply, manifest.json, ITHACA share link or token); frames: lone Low Quality sequence.
// light, crossfade, decoders (0.4.0): "auto" (default) or true / false (a number for decoders), as the Ithaca4DGS options.
// Import after A-Frame. The entity's position / rotation / scale place the video like any other object.
import { Ithaca4DGS } from "./Ithaca4DGS.js";

export function registerIthaca4DGS(AFRAME = globalThis.AFRAME) {
  if (!AFRAME || AFRAME.components["ithaca-4dgs"]) return;
  AFRAME.registerComponent("ithaca-4dgs", {
    schema: { src: { type: "string" }, loop: { default: true }, autoplay: { default: true }, sound: { default: true }, frames: { default: 0 },
              light: { default: "auto" }, crossfade: { default: "auto" }, decoders: { default: "auto" } },
    init() { this._build(); },
    update(old) {
      if (old && old.src !== undefined && ["src", "light", "crossfade", "decoders"].some((k) => old[k] !== this.data[k])) this._build();
    },
    _build() {
      this.remove();
      if (!this.data.src) return;
      const scene = this.el.sceneEl;
      let listener = null;
      if (this.data.sound && scene.camera) {
        listener = scene.camera.children.find((c) => c.isAudioListener) || new AFRAME.THREE.AudioListener();
        if (!listener.parent) scene.camera.add(listener);
      }
      const opt = (v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : /^\d+$/.test(String(v)) ? Number(v) : "auto");
      this.video = new Ithaca4DGS({ src: this.data.src, loop: this.data.loop, autoplay: this.data.autoplay, listener,
                                    frames: this.data.frames || null, light: opt(this.data.light), crossfade: opt(this.data.crossfade),
                                    decoders: opt(this.data.decoders) });
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
