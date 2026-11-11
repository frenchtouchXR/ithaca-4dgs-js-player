// SPDX-License-Identifier: MIT
// Copyright (c) 2026 French Touch Factory / ITHACA
//
// Ithaca4DGS: an ITHACA 4D Gaussian Splatting video as a three.js object. Add it to any scene (VR, AR or flat), move,
// rotate and scale it like any Object3D; it plays by itself while it is rendered.
//
//   const v = new Ithaca4DGS({ src: "video.4dgs", loop: true, autoplay: true, listener });   // listener: THREE.AudioListener
//   scene.add(v);
//   v.play(); v.pause(); v.currentTime = 1.5; v.duration; v.addEventListener("ready", …);
//
// Events: "load" (index read), "ready" (first sequence on screen), "waiting" / "playing" (buffering), "ended",
// "error" ({ error }), "progress" ({ loaded, total } sequences).
// Speed first: decoding and sorting run in workers, the render loop never waits for them; the next sequence is
// fetched, decoded, uploaded to the GPU (one texture per frame) and pre-sorted before it is needed.
import * as THREE from "three";
import { SplatMesh } from "./render/SplatMesh.js";
import { open4dgs, fetchRange, is4dgs } from "./format/container4dgs.js";
import { ITHACA_SERVER, shareToken, resolveShare } from "./ithaca.js";

const SOUND_ORDER = ["audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/aac"];
const AHEAD_S = 1.0;            // the next sequence is uploaded and pre-sorted this long before its first frame

/** Browsers refuse a worker script from another origin (player loaded from a CDN): a same-origin stub (blob) then
    imports it, cross-origin module imports being allowed (with CORS, as CDNs serve them). */
const sameOrigin = (url) => typeof location === "undefined" || url.origin === location.origin || /^(blob|data):$/.test(url.protocol);
function stubWorker(url) {
  const stub = URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: "text/javascript" }));
  return new Worker(stub, { type: "module" });
}

/** Rotation R = Rz · Ry · Rx (degrees), as the ITHACA platform framing. */
function framingRotation([ax, ay, az]) {
  const e = new THREE.Euler(THREE.MathUtils.degToRad(ax), THREE.MathUtils.degToRad(ay), THREE.MathUtils.degToRad(az), "ZYX");
  return new THREE.Matrix4().makeRotationFromEuler(e);   // three "ZYX" = Rz · Ry · Rx applied to column vectors
}

export class Ithaca4DGS extends THREE.Object3D {
  constructor({ src, autoplay = true, loop = true, listener = null, fps = 30, applyFraming = true, fetchFn,
                server = ITHACA_SERVER, frames = null, format = null } = {}) {
    super();
    this.server = server;               // ITHACA site that resolves share links
    this.share = null;                  // description of the ITHACA share being played (share links only)
    this.type = "Ithaca4DGS";
    this.src = src;
    this.loop = loop;
    this.autoplay = autoplay;
    this.listener = listener;
    this.applyFraming = applyFraming;
    this.fps = fps;
    this.index = null;
    this.sequences = [];
    this.totalFrames = 0;               // frames of the whole video (time normalization)
    this._range = [0, 0];               // frames played [first, end) : the whole video, or one sequence's window
    this.playing = false;
    this.ready = false;
    this.waiting = false;
    this._time = 0;
    this._fetch = fetchFn || ((...a) => fetch(...a));
    this._entries = new Map();          // sequence k → { state, handle, promise }
    this._active = -1;
    this._lastFrameId = -1;
    this._lastNow = 0;
    this._abort = new AbortController();
    this._req = 0;
    this._sorting = false;
    // timings (ms): last sort and decode in the workers, main-thread time of the last frame
    this.stats = { sortMs: 0, sortsPerSecond: 0, decodeMs: 0, packMs: 0, fetchMs: 0, mainMs: 0, visible: 0, gaussians: 0 };
    this._sortCount = 0;
    this._sortWindow = performance.now();

    // ITHACA renders are in the OpenCV frame (x right, y down, z forward); the framed scene has its floor at y = 0.
    // three.js is y up: a 180° rotation about Z (a true rotation, no mirror) stands the video up, its front towards +z
    // (glTF / three.js convention: a viewer on the +z side sees the performer's face).
    this.stage = new THREE.Object3D();
    this.stage.rotation.z = Math.PI;
    this.add(this.stage);
    this.framing = new THREE.Object3D();
    this.framing.matrixAutoUpdate = false;
    this.stage.add(this.framing);
    this.mesh = new SplatMesh();
    this.mesh.onRender = (renderer, camera) => this._onRender(renderer, camera);
    this.framing.add(this.mesh);

    // literal new Worker(new URL(…, import.meta.url)) forms: bundlers (Vite, webpack 5) bundle the workers from them
    const dec = new URL("./workers/decode.worker.js", import.meta.url), srt = new URL("./workers/sort.worker.js", import.meta.url);
    this._decoder = sameOrigin(dec) ? new Worker(new URL("./workers/decode.worker.js", import.meta.url), { type: "module" }) : stubWorker(dec);
    this._sorter = sameOrigin(srt) ? new Worker(new URL("./workers/sort.worker.js", import.meta.url), { type: "module" }) : stubWorker(srt);
    this._pending = new Map();
    this._nextId = 1;
    this._decoder.onmessage = ({ data }) => {
      const p = this._pending.get(data.id);
      if (!p) return;
      this._pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.packed);
    };
    this._sorter.onmessage = ({ data }) => this._onSorted(data);

    // a load cancelled by dispose() (AbortError) is not an error of the video
    if (src) this.load(src, { frames, format }).catch((error) => { if (error?.name !== "AbortError") this._fail(error); });
  }

  get duration() { return (this._range[1] - this._range[0]) / this.fps; }
  get currentTime() { return this._time - this._range[0] / this.fps; }
  set currentTime(s) {
    this._time = this._range[0] / this.fps + Math.max(0, Math.min(s, Math.max(this.duration - 1e-6, 0)));
    this._syncSound(true);
  }

  play() {
    this.playing = true;
    this._lastNow = 0;
    this._syncSound(true);
  }

  pause() {
    this.playing = false;
    if (this._sound) this._sound.el.pause();
  }

  /** Loads a 4D video. src: a .4dgs file; a single sequence (.ftgsz or .ply, HD or Low Quality); an ITHACA
      manifest.json (sequences next to it); an ITHACA share link or token; or a local File / Blob of these formats.
      options.frames: frame count of a lone Low Quality sequence (its file does not say); options.format: "4dgs", "ftgsz",
      "ply" or "manifest" when the name does not tell. */
  async load(src, { frames = null, format = null } = {}) {
    const signal = this._abort.signal;
    const name = String((src && src.name) || (typeof src === "string" ? src : "")).toLowerCase().replace(/[?#].*$/, "");
    const token = typeof src === "string" ? shareToken(src) : null;
    if (token) return this._loadShare(token);
    if (format === "4dgs" || (!format && is4dgs(src))) {
      await this._load4dgs(src);
    } else if (format === "manifest" || (!format && /\.json$/.test(name))) {
      const base = new URL(String(src), globalThis.location?.href);
      const r = await this._fetch(String(src), { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${src}`);
      const m = JSON.parse((await r.text()).replace(/^\uFEFF/, ""));
      if (!Array.isArray(m.segments)) throw new Error("Not an ITHACA manifest (segments missing)");
      this.fps = Number(m.fps) || this.fps;
      const first = Number(m.first_frame) || 0;
      this.totalFrames = Number(m.n_frames) || m.segments.reduce((a, x) => Math.max(a, x.first_frame + x.n_frames), 0);
      this._range = [first, first + this.totalFrames];
      this.index = { manifest: m };
      this.sequences = m.segments.map((x) => ({ first: x.first_frame, frames: x.n_frames, url: new URL(x.file, base).href, range: null }));
    } else {
      // single sequence; a lone Low Quality sequence needs its frame count (HD sequences carry it in their header)
      this.sequences = [{ first: frames ? 0 : null, frames: frames || null, url: src, range: null }];
      if (frames) { this.totalFrames = frames; this._range = [0, frames]; }
    }
    this.dispatchEvent({ type: "load", index: this.index });
    await this._ensure(0);
  }

  async _load4dgs(src, framing) {
    const index = await open4dgs(src, { signal: this._abort.signal, fetchFn: this._fetch });
    this.index = framing === undefined ? index : { ...index, cadrage: framing };
    this.fps = index.fps || this.fps;
    this.totalFrames = index.images;
    this._range = [0, index.images];
    this.sequences = index.sequences.map((s) => ({ first: s.premiere, frames: s.images, url: src, range: [s.offset, s.octets] }));
    this._setupSound(src, index.sons || []);
  }

  /** ITHACA share link: its .4dgs file when there is one, else its sequences and sound (signed links). The framing
      set by the owner on the platform is the share's. */
  async _loadShare(token) {
    const d = await resolveShare(token, { server: this.server, signal: this._abort.signal, fetchFn: this._fetch });
    this.share = d;
    if (d.file) {
      await this._load4dgs(d.file, d.framing);
      this.index.decalage_son = this.index.decalage_son ?? d.soundOffset;
    } else {
      if (!d.sequences.length) throw new Error("This 4D video has no sequence to play.");
      this.fps = d.fps || this.fps;
      this.totalFrames = d.frames || d.sequences.reduce((a, x) => Math.max(a, x.first + x.frames), 0);
      this._range = [0, this.totalFrames];
      this.index = { cadrage: d.framing, decalage_son: d.soundOffset, titre: d.title };
      this.sequences = d.sequences.map((x) => ({ first: x.first, frames: x.frames, url: x.url, range: null }));
      this._setupSoundUrls(d.sounds);
    }
    this.dispatchEvent({ type: "load", index: this.index, share: d });
    await this._ensure(0);
  }

  /** Signed share links expire: asks the ITHACA site for fresh ones (at most once a minute). */
  async _refreshShare() {
    if (!this.share || Date.now() - (this._refreshed || 0) < 60000) return false;
    this._refreshed = Date.now();
    const d = await resolveShare(this.share.token, { server: this.server, signal: this._abort.signal, fetchFn: this._fetch });
    this.share = d;
    if (d.file) for (const s of this.sequences) s.url = d.file;
    else d.sequences.forEach((x, k) => { if (this.sequences[k]) this.sequences[k].url = x.url; });
    return true;
  }

  // ── sequences ───────────────────────────────────────────────────────────────────────────────────────────────
  _decode(buffer, seq) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._decoder.postMessage({ id, buffer, seq }, [buffer]);
    });
  }

  async _fetchSequence(s) {
    const signal = this._abort.signal;
    if (s.range) {
      const [o, n] = s.range;
      const get = () => fetchRange(s.url, o, o + n - 1, { signal, fetchFn: this._fetch });
      const { bytes } = await get().catch(async (e) => {
        if (/HTTP 40[03]/.test(e.message) && await this._refreshShare()) return get();   // expired signed link
        throw e;
      });
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    }
    if (typeof Blob !== "undefined" && s.url instanceof Blob) return s.url.arrayBuffer();   // local file
    let r = await this._fetch(s.url, { signal });
    if ((r.status === 403 || r.status === 400) && await this._refreshShare()) r = await this._fetch(s.url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${s.url}`);
    return r.arrayBuffer();
  }

  _ensure(k) {
    if (k < 0 || k >= this.sequences.length) return Promise.resolve(null);
    let e = this._entries.get(k);
    if (e) return e.promise;
    e = { state: "loading", handle: null, id: k + 1 };
    e.promise = (async () => {
      const tf = performance.now();
      const bytes = await this._fetchSequence(this.sequences[k]);
      this.stats.fetchMs = performance.now() - tf;
      const sq = this.sequences[k];
      // Low Quality needs the place of the sequence in the video (its time is local): known from the .4dgs index
      const packed = await this._decode(bytes, { first: sq.first, frames: sq.frames, total: this.totalFrames });
      this.stats.decodeMs = packed.ms.decode;
      this.stats.packMs = packed.ms.pack;
      const s = this.sequences[k];
      if (s.frames == null) {                         // single sequence: its window of the video (header + bounds)
        this.totalFrames = packed.frames || 1;
        const w = packed.window || { first: 0, count: this.totalFrames };
        s.first = w.first;
        s.frames = w.count;
        this._range = [w.first, w.first + w.count];
        this._time = w.first / this.fps;
      }
      if (this._entries.get(k) !== e) return null;    // evicted meanwhile
      if (k === 0 || !this._framed) this._frame(packed.bounds);
      const { pos, vel, opa } = packed.sort;
      this._sorter.postMessage({ type: "add", id: e.id, count: packed.count, pos, vel, opa }, [pos.buffer, vel.buffer, opa.buffer]);
      e.handle = this.mesh.setData(packed);
      e.state = "ready";
      this.dispatchEvent({ type: "progress", loaded: [...this._entries.values()].filter((x) => x.state === "ready").length,
                           total: this.sequences.length });
      return e;
    })().catch((error) => {
      this._entries.delete(k);
      if (error.name !== "AbortError") this._fail(error);
      return null;
    });
    this._entries.set(k, e);
    return e.promise;
  }

  _evict(keep) {
    for (const [k, e] of this._entries) {
      if (keep.has(k)) continue;
      if (e.handle) this.mesh.disposeData(e.handle);
      this._sorter.postMessage({ type: "remove", id: e.id });
      this._entries.delete(k);
    }
  }

  /** Sequence shown at video position `frame` (continuous, in frames). The switch happens exactly where the windows
      meet: a sequence fades out 1 % of a frame before its next one starts (pack.js), so the active sequence must
      change there too, not at the integer frame (else one blank frame at each junction). */
  _sequenceAt(frame) {
    const s = this.sequences;
    for (let k = 0; k < s.length; k++) if (frame < s[k].first + (s[k].frames ?? Infinity) - 0.01) return k;
    return s.length - 1;
  }

  // ── framing (platform « cadrage ») ───────────────────────────────────────────────────────────────────────────
  _frame(bounds) {
    this._framed = true;
    const pivot = new THREE.Vector3().fromArray(bounds.min).add(new THREE.Vector3().fromArray(bounds.max)).multiplyScalar(0.5);
    const lo = new THREE.Vector3().fromArray(bounds.min), hi = new THREE.Vector3().fromArray(bounds.max);
    this._sphere = { pivot, radius: Math.max(0.5 * lo.distanceTo(hi), 0.01), box: null };
    const c = this.applyFraming && this.index && this.index.cadrage;
    const m = new THREE.Matrix4();
    if (c) {
      // x → e·R·(x − pivot) + pivot + position ; the framed scene has its floor at y = 0
      const e = c.echelle > 0 ? c.echelle : 1;
      const R = framingRotation(c.rotation || [0, 0, 0]);
      m.makeTranslation(pivot.x + (c.position?.[0] || 0), pivot.y + (c.position?.[1] || 0), pivot.z + (c.position?.[2] || 0))
        .multiply(R).multiply(new THREE.Matrix4().makeScale(e, e, e))
        .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      const b = c.boite;
      const mode = b && b.mode === "interieur" ? 1 : b && b.mode === "exterieur" ? 2 : 0;
      this.mesh.setBox(mode, b && b.centre, b && (b.demi || []).map(Math.abs), m);
      if (mode === 1 && Array.isArray(b.centre) && Array.isArray(b.demi))
        this._sphere.box = { center: new THREE.Vector3().fromArray(b.centre),
                             radius: Math.max(Math.hypot(...b.demi), 1e-3) };
    this._placeSound();
    } else {
      m.makeTranslation(-pivot.x, -pivot.y, -pivot.z);  // no framing: model centred on the object
    }
    this.framing.matrix.copy(m);
    this.framing.matrixWorldNeedsUpdate = true;
    this._placeSound();
  }

  /** Spatial sound: the source sits at the centre of the performer (robust centre, framing included). */
  _placeSound() {
    const node = this._sound && this._sound.node, s = this._sphere;
    if (!node || !s) return;
    this.stage.updateMatrix();                   // (framing.matrix is set directly: never recomputed from TRS)
    const local = s.box ? s.box.center.clone().applyMatrix4(this.stage.matrix)
                        : s.pivot.clone().applyMatrix4(this.framing.matrix).applyMatrix4(this.stage.matrix);
    node.position.copy(local);
  }

  /** Bounding sphere of the video in world space (robust: 1st–99th percentiles), framing and box included, for camera
      framing: { center: Vector3, radius }. Null before the first sequence is loaded. */
  boundingSphere() {
    const s = this._sphere;
    if (!s) return null;
    this.updateWorldMatrix(true, true);
    if (s.box) {                                  // the clip box keeps its inside: frame the box (scene space = stage)
      const center = this.stage.localToWorld(s.box.center.clone());
      return { center, radius: s.box.radius * this.stage.matrixWorld.getMaxScaleOnAxis() };
    }
    const center = this.mesh.localToWorld(s.pivot.clone());
    return { center, radius: s.radius * this.mesh.matrixWorld.getMaxScaleOnAxis() };
  }

  // ── per frame ────────────────────────────────────────────────────────────────────────────────────────────────
  // The per-frame update (time, sequence switch, order of the splats) must run BEFORE three.js uploads the buffers of
  // the frame: renderer.render() calls scene.updateMatrixWorld() first, then uploads the geometries, then calls
  // onBeforeRender just before drawing. Done in onBeforeRender, a new order reached the GPU one frame late: at a
  // sequence switch the new textures were drawn with the previous sequence's indices (one broken frame).
  updateMatrixWorld(force) {
    super.updateMatrixWorld(force);
    if (this._renderer) this._update(this._renderer, this._camera);
  }

  _update(renderer, camera) {
    const t0 = performance.now();
    this._tick(renderer, camera);
    this._ticked = true;
    this.stats.mainMs = performance.now() - t0;
  }

  // onBeforeRender of the splat mesh: remembers the renderer and the camera (used by the next update: sort, uploads).
  // Fallback when the host scene does not auto-update matrices: update here (one frame of latency on switches).
  _onRender(renderer, camera) {
    const first = !this._renderer;
    this._renderer = renderer;
    this._camera = camera;
    const frameId = renderer.info.render.frame;
    if (frameId === this._lastFrameId) return;      // once per frame (XR draws the object once per eye)
    this._lastFrameId = frameId;
    if (!this._ticked || first) this._update(renderer, camera);
    this._ticked = false;
  }

  _normalized(timeS) {
    return this.totalFrames > 1 ? Math.min((timeS * this.fps) / (this.totalFrames - 1), 1) : 0;
  }

  _tick(renderer, camera) {
    const now = performance.now();
    const dt = this._lastNow ? Math.min((now - this._lastNow) / 1000, 0.1) : 0;
    this._lastNow = now;
    if (!this.sequences.length || !this.totalFrames) return;

    const n = this.sequences.length;
    let frame = this._time * this.fps;
    let k = this._sequenceAt(frame);
    const cur = this._entries.get(k);
    const ok = cur && cur.state === "ready";
    if (!ok) {
      this._ensure(k);
      if (!this.waiting && this.ready) { this.waiting = true; this.dispatchEvent({ type: "waiting" }); }
    } else {
      if (this.waiting) { this.waiting = false; this.dispatchEvent({ type: "playing" }); }
      if (this.playing && (this.ready || this._active === k)) {
        // clock: the sound track when it is playing (audio never re-seeked, the video follows it and skips frames on
        // a slow device instead of drifting); otherwise the frame time
        const s = this._sound, el = s && s.el;
        // only a sound really heard is the clock: spatial sound (THREE.AudioListener) whose AudioContext is still
        // suspended (no user gesture yet) keeps the element "playing" at a frozen time; the frame clock runs meanwhile
        // and the sound is re-synced as soon as the context runs
        const audible = !(s && s.node) || s.node.context.state === "running";
        if (s && audible !== s.audible) { s.audible = audible; if (audible) this._syncSound(true); }
        if (el && audible && !el.paused && !el.seeking && el.readyState >= 2 && !s.blocked) this._time = el.currentTime - s.offset;
        else this._time += dt;
        const t0 = this._range[0] / this.fps, t1 = this._range[1] / this.fps;
        if (this._time >= t1) {
          if (this.loop) { this._time = t0 + ((this._time - t0) % (t1 - t0)); this._syncSound(true); }
          else { this._time = t1 - 1e-6; this.pause(); this.dispatchEvent({ type: "ended" }); }
        }
        frame = this._time * this.fps;
        k = this._sequenceAt(frame);
      }
    }

    // keep the current and the next sequence; fetch / decode / upload / pre-sort the next ahead of time
    const next = k + 1 < n ? k + 1 : this.loop && n > 1 ? 0 : -1;
    this._evict(new Set([k, next]));
    this._ensure(k);
    if (next >= 0) this._ensure(next);
    const e = this._entries.get(k);
    if (e && e.state === "ready") {
      if (this._active !== k || this.mesh.current !== e.handle) {
        this.mesh.upload(e.handle, renderer);
        this.mesh.useData(e.handle);
        this._active = k;
      }
      if (!this.ready && e.order) {
        this.ready = true;
        this.dispatchEvent({ type: "ready" });
        if (this.autoplay && !this.playing) this.play();
      }
    }
    const t = this._normalized(this._time);
    this.mesh.setTime(t);
    this._syncSound(false);

    // sort: current sequence; within AHEAD_S of the next one, alternate with a pre-sort of the next at its start
    const ne = next >= 0 ? this._entries.get(next) : null;
    const startNext = next >= 0 ? this.sequences[next].first / this.fps : 0;
    const untilNext = next > k ? startNext - this._time : next === 0 ? this._range[1] / this.fps - this._time : Infinity;
    if (ne && ne.state === "ready" && untilNext < AHEAD_S) {
      this.mesh.upload(ne.handle, renderer);       // one texture per frame: no hitch at the switch
      if (!this._sorting && (this._req & 1)) return this._sort(ne, this._normalized(startNext), camera, true);
    }
    if (!this._sorting && e && e.state === "ready") this._sort(e, t, camera, false);
    else if (!this._sorting) this._req++;
  }

  _sort(entry, t, camera, ahead) {
    const mv = this._mv || (this._mv = new THREE.Matrix4());
    mv.multiplyMatrices(camera.matrixWorldInverse, this.mesh.matrixWorld);
    const m = mv.elements;
    this._sorting = true;
    this._req++;
    // keep what fades in during the next 2 video frames (the order is used for the coming frames)
    const lookahead = this.totalFrames > 1 ? 2 / (this.totalFrames - 1) : 0;
    this._sorter.postMessage({ type: "sort", id: entry.id, req: this._req, time: t, ahead: lookahead, row: [m[2], m[6], m[10], m[14]] });
  }

  _onSorted({ id, order, visible, ms }) {
    this._sorting = false;
    this.stats.sortMs = ms;
    this._sortCount++;
    const now = performance.now();
    if (now - this._sortWindow > 1000) {
      this.stats.sortsPerSecond = (this._sortCount * 1000) / (now - this._sortWindow);
      this._sortCount = 0; this._sortWindow = now;
    }
    for (const e of this._entries.values()) if (e.id === id && e.handle) {
      this.mesh.setOrder(e.handle, order, visible);
      e.order = true;
      if (e.handle === this.mesh.current) { this.stats.visible = visible; this.stats.gaussians = e.handle.count; }
    }
  }

  // ── sound ────────────────────────────────────────────────────────────────────────────────────────────────────
  async _setupSound(url, sounds) {
    if (!sounds.length || typeof Audio === "undefined") return;
    const probe = new Audio();
    const byName = new Map();
    for (const s of sounds) (byName.get(s.nom) || byName.set(s.nom, []).get(s.nom)).push(s);
    const track = [...byName.values()][0]
      .filter((s) => probe.canPlayType(s.type))
      .sort((a, b) => SOUND_ORDER.indexOf(a.type) - SOUND_ORDER.indexOf(b.type))[0];
    if (!track) return;
    try {
      const { bytes } = await fetchRange(url, track.offset, track.offset + track.octets - 1, { signal: this._abort.signal, fetchFn: this._fetch });
      this._startSound(new Blob([bytes], { type: track.type }));
    } catch (e) { /* no sound: the video still plays */ }
  }

  /** Sound of a share: separate files (signed links), the first one this browser plays. */
  async _setupSoundUrls(urls) {
    if (!urls.length || typeof Audio === "undefined") return;
    const probe = new Audio();
    const typeOf = (u) => { const e = (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(u) || [])[1]?.toLowerCase();
                            return { m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" }[e] || ""; };
    for (const u of urls) {
      const type = typeOf(u);
      if (type && !probe.canPlayType(type)) continue;
      try {
        const r = await this._fetch(u, { signal: this._abort.signal });
        if (!r.ok) continue;
        this._startSound(new Blob([await r.arrayBuffer()], { type: type || r.headers.get("Content-Type") || "" }));
        return;
      } catch (e) { if (e.name === "AbortError") return; }
    }
  }

  _startSound(blob) {
    const el = new Audio(URL.createObjectURL(blob));
    el.preload = "auto";
    el.loop = false;
    let node = null;
    if (this.listener) {                           // spatial sound attached to the object
      node = new THREE.PositionalAudio(this.listener);
      node.setMediaElementSource(el);
      this.add(node);
    }
    this._sound = { el, node, offset: (this.index && this.index.decalage_son) || 0 };
    this._placeSound();
    this._syncSound(true);
  }

  _syncSound(force) {
    const s = this._sound;
    if (!s) return;
    const target = s.offset + this._time;
    if (!this.playing || this.waiting) { if (!s.el.paused) s.el.pause(); return; }
    // re-seek only on demand (play, seek, loop) or after a real desync (e.g. the sound ended before the video)
    if (force || Math.abs(s.el.currentTime - target) > 0.25) s.el.currentTime = target;
    // autoplay policies: a blocked play() is retried only on play() / seek, not every frame
    if (s.el.paused && (force || !s.blocked)) s.el.play().then(() => { s.blocked = false; }, () => { s.blocked = true; });
  }

  // ── end ──────────────────────────────────────────────────────────────────────────────────────────────────────
  _fail(error) {
    this.dispatchEvent({ type: "error", error });
    if (typeof console !== "undefined") console.error("Ithaca4DGS:", error);
  }

  dispose() {
    this._abort.abort();
    this.pause();
    this._evict(new Set());
    this._decoder.terminate();
    this._sorter.terminate();
    this.mesh.dispose();
    if (this._sound) { this._sound.el.src = ""; if (this._sound.node) this.remove(this._sound.node); }
    this.removeFromParent();
  }
}
