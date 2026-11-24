# Changelog

## 0.4.0 — 2026-11-24

Smooth playback of long and heavy videos, true crossfade, smooth sound clock, light mode on phones and headsets.
Ported from the ITHACA site viewer (same engine at the origin, MIT). **No change needed in existing code**: every 0.3
option and method keeps its meaning; the new options have safe automatic defaults.

### Playback without long frames
- A window of sequences ahead is kept loaded (memory budget of the device, see `memoryBudgetMB`), fetched one at a time
  and decoded by several workers in parallel (`decoders`).
- GPU uploads by bands of rows within a byte budget per frame (≈ 4 ms, set on the measured cost), earliest needed first,
  instead of one whole texture (up to ≈ 100 MB) per frame; a sequence needed at once and not yet on the GPU is finished
  in one go as a last resort (`stats.forcedUploads`, should stay 0).
- Desktop: textures of released sequences are reused by the next ones (reserve of up to 15 % of the budget, 1 200 MB at
  most, shared by the videos of one renderer and given back when the last one is disposed).
- Arrays already copied to the GPU are released in the sort worker, not on the display thread (freeing ≈ 300 MB there
  took 20 to 50 ms).
- Finishing work spread over frames (memory check, then the sort worker), never all in one frame.
- Faster decoding, same bytes: packed words read with integer operations, block bounds read once per block, HD 4DGS
  fields looked up once (HD 4DGS sequence of 1 M gaussians: 2.5 → 1.5 s in one worker; outputs checked identical).
- Colour streams above the SH degree drawn are neither decompressed nor decoded.

### Crossfade (videos rendered with a transition)
- Junction models: during the overlap of two sequences both are drawn as one model, sorted as a whole (right depth order
  between them). HD 4DGS: only the gaussians visible during the overlap (≈ 1.2 M instead of 2 M on a 16-sequence test
  video). Sides extracted in the decode workers, merged in a junction worker, transferred without copies.
- Continuous weights over the whole overlap (1 → 0 and 0 → 1, fractional frame), opacity mixed at constant density
  (α' = 1 − (1 − α)^w): no more "pumping". The junction is kept to the end of its overlap.
- `crossfade` now defaults to `"auto"`: on, except in light mode (`true` forces it). `fadeMesh` (0.3 internal) stays as
  an empty hidden object.

### Sound clock
- Time never goes back while playing; soft catch-up of the sound (speed ±25 %, proportional) up to 1 s of drift; hard
  jump only at start, loop, pause / seek or beyond 1 s; a frame more than 1 s ahead waits for the sound.
- With spatial sound (Web Audio), the output latency is measured with `getOutputTimestamp()`; `currentTime` updated by
  packets is prolonged between its changes. The sound is re-seeked only on demand or beyond 2 s of desync.
- `stats.hardSyncs`, `stats.softSyncFrames`.

### Light mode
- `light: "auto"` (phones, tablets, headsets): colours up to SH degree 1 (HD 4DGS degree-1 colours in the compact 8-bit
  layout of texture D, no texture F), no gaussian removed: HD 4DGS ≈ 25 % less memory per sequence.

### New options and stats
- Options `light`, `decoders`, `memoryBudgetMB` (all `"auto"` by default), `crossfade: "auto"`; A-Frame schema `light`,
  `crossfade`, `decoders`.
- `stats.uploadMB`, `uploadMs`, `forcedUploads`, `hardSyncs`, `softSyncFrames`, `junctions`, `decoders`, `capacity`,
  `sequenceMB`, `light`.
- `SplatMesh`: `upload(handle, renderer, maxBytes)` (without `maxBytes`: one texture per call as before),
  `releaseData(handle)`, `setSideWeights(w1, w2)`.

## 0.3.2 — 2026-11-22
HD 4DGS with transitions: each `.trgz` sequence decoded on its training window, crossfade at the junction.

## 0.3.1 — 2026-11-21
HD (FreeTimeGS) sequences with SH degree 2–3 rendered with full colours.

## 0.3.0 — 2026-11-21
HD 4DGS sequences (`.trgz`): screw motion with a Bézier rate, SH up to degree 3.

## 0.2.0 — 2026-11-12
Crossfade between sequences of videos rendered with a transition.

## 0.1.2 — 2026-11-11
Playback with spatial sound before any user gesture, no error on cancelled loads.

## 0.1.1 — 2026-11-11
`.4dgs` index read when the page may not read `Content-Range`.

## 0.1.0 — 2026-11-11
First version.
