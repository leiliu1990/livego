# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Keep this file in sync with the code. The detection algorithm has evolved
> considerably (per-intersection baselines, motion gating, a tentative-confirm
> model, adaptive thresholds); update the relevant section when you change it.

## What this is

LiveGo — a pure client-side web app that uses a phone's rear camera to watch a 19×19 Go game, detect stone placements via OpenCV.js (WebAssembly), export an SGF file, and optionally broadcast the game live to remote viewers. No backend of our own, no build step.

## Running locally

```bash
python3 -m http.server 8080
# then open http://localhost:8080 on desktop
# on iPhone: open http://<your-mac-ip>:8080 (camera requires HTTPS or localhost;
#   for iPhone testing use a tunnel like: npx localtunnel --port 8080)
```

Camera access on iPhone Safari requires HTTPS. For local dev use `localtunnel` or `ngrok`.

**Camera tip:** use the normal 1× rear lens, board head-on and filling the frame. The ultra-wide (0.5×) lens adds barrel distortion that the (linear) perspective warp cannot correct — grid lines bow at the edges and sampling misaligns, causing false/edge stones.

## File layout

| File | Role |
|---|---|
| `index.html` | Two-screen layout: setup (corner picking) and recording, plus the manual-fix overlay |
| `style.css` | Mobile-first UI, dark theme, iOS safe-area aware |
| `corners.js` | `CornerPicker` class — tap near a crossing, then nudge with ↑↓←→ arrows in a magnifier to the exact spot |
| `detector.js` | `BoardDetector` class — perspective warp + per-intersection delta classification, motion/occlusion gating, tentative-confirm resolver |
| `sgf.js` | `SGFRecorder` class — move list, undo/redo, setup stones (AB/AW), SGF string generation, file download |
| `live.js` | `livePublish` / `liveFetch` — Firebase Realtime Database REST transport for live broadcast |
| `app.js` | Boot, screen transitions, manual-fix UI, live wiring; ties all modules together |
| `viewer.html` | Standalone remote viewer — polls the live feed, replays with capture rules, try-variation ("试下") mode, SGF export |
| `opencv.js` | Vendored OpenCV.js (WASM), loaded locally (not from a CDN) |
| `test.html` | Manual test/scratch page |

## Architecture

**No framework, no bundler.** Plain ES2020 files loaded via `<script src>` (shared global scope — mind name collisions across files). OpenCV.js is vendored as a local `opencv.js`.

Cache-busting: `index.html`/`viewer.html` load assets with a `?v=N` query string; bump `N` on every asset change (currently v31).

**Two-screen flow:**
1. **Setup screen** (`#screen-setup`): Camera stream + canvas overlay for corner picking. Tap near each of the 4 outer grid crossings; a magnifier opens and you nudge to the exact spot with arrow buttons, then Confirm. After 4 corners + game info, transitions to screen 2.
2. **Recording screen** (`#screen-record`): Same camera stream (both `<video>` elements share one `MediaStream`). `BoardDetector` samples every `SAMPLE_INTERVAL` ms and emits confirmed moves via `onMove`.

**Perspective correction:** Display-space corner coordinates are converted to video-pixel coordinates (accounting for `object-fit: cover` crop) before `cv.getPerspectiveTransform`. The 4 corners are the outermost grid crossings, mapped to a rectangle inset by one cell (`WARP_MARGIN`) so edge stones stay inside the `WARP_SIZE × WARP_SIZE` output. A rigid uniform grid (single offset + spacing per axis) is then fit to the real dark lines so sampling lands on the true crossings.

## Detection algorithm (detector.js)

**Per-intersection empty baseline — the board is NOT assumed uniform.** On the first good frame (assumed empty), each of the 361 crossings' brightness is sampled and stored in `_baseline[r][c]` (`_captureBaseline`). The full empty-board gray image is also kept as `_baselineGray` (used only for occlusion). Every crossing is thus referenced to *its own* empty appearance, so wood grain / a grid line through the cell cancels out.

**Classification by delta, not absolute brightness:** each frame, `delta = sampleMean(cell) − _baseline[r][c] − _ambient`. `_ambient` is the median of all cells' deltas (most cells are empty, so the median is the global lighting shift; stones are outliers it ignores). Then: `delta < _blackDelta ⇒ black`, `delta > _whiteDelta ⇒ white`, else empty. This is essential because bright wood grain overlaps white-stone brightness in absolute terms.

**Adaptive thresholds:** `_whiteDelta`/`_blackDelta` start at `WHITE_DELTA`/`BLACK_DELTA` but adapt to the board after a manual fix (`_recalibrate`), using the corrected stones as ground-truth delta samples — this targets low-contrast white stones on pale (e.g. bamboo) boards. Guardrails: clean/settled frame only, drop near-zero contaminated samples, ≥3 samples per colour, require separation from the empty-noise band, clamp so thresholds never cross 0.

**Motion & occlusion gating (not a fixed timer):** sampling is fast (`SAMPLE_INTERVAL=400`ms) but frames are filtered. `_motion` = fraction of pixels that changed since the last frame; above `MOTION_THRESH` the scene is moving (a hand placing a stone) and the frame is skipped. `_computeOcclusion` flags a large border-touching blob (an arm reaching in) and invalidates the frame. A move is committed `QUIET_FRAMES` settled frames after the hand withdraws.

**Tentative-confirm model:** a detected move stays *tentative* until the opponent's reply confirms it (`_resolveTentative`). `boardState` is the live DISPLAY (confirmed + one provisional move); `_confirmed` is only what's emitted to the SGF. Competing same-colour candidates for one turn are held until one survives or the opponent forces a pick (`_mostStoneLike`, chosen by closeness to confirmed same-colour deltas). Go capture/suicide rules are applied throughout.

**False-disappearance recovery:** a stone leaves only by capture. A mature stone (`_age >= AGE_PROTECT`) that reads empty but whose group still has a liberty was not captured (shadow/partial occlusion) and is restored; a young vanished stone is let go (self-heals a transient false positive).

**Manual fix + mid-game start:** `setBoardState(board, nextTurn, calibrate)` replaces the confirmed position wholesale (used by the 修正 Fix overlay and by undo). With `calibrate` (a fix, where stones are ground truth) it also runs `_recalibrate` and `_fixupBaseline`. `_fixupBaseline` resets any occupied cell whose baseline is far from the wood level (median of empty cells) back to wood — this lets the same Fix flow **start a game mid-position**: the first-frame baseline captured stone brightness on those cells, which would otherwise phantom-white a black stone when it's later captured. The corrected board becomes the SGF/broadcast start (Approach A: prior per-move history is dropped; see `sgf.js` setup stones and `viewer.html` `stateAt` seeding).

## Live broadcast (live.js + viewer.html)

`app.js` publishes the game (info + moves + optional `setup`; tentative stones flagged `prov:1`) to Firebase RTDB via `livePublish(id, game)` REST PUT. `viewer.html?id=<gameId>` polls `liveFetch` every `POLL_MS=3000`, replays with capture rules, and auto-plays newly-arrived moves when the viewer is at the latest position. The viewer also supports a scratch "试下" variation branch and SGF export.

## Key constants (detector.js)

```js
SAMPLE_INTERVAL = 400   // ms between sampled frames (fast; motion gating filters)
QUIET_FRAMES    = 2     // settled frames of a stable new state before committing
MOTION_THRESH   = 0.03  // fraction of changed pixels above which the frame is "moving"
WARP_SIZE       = 760   // px for the perspective-corrected board image
WHITE_DELTA     = 18    // ≥ this brightening vs empty ⇒ white (default; adapts after fix)
BLACK_DELTA     = -70   // ≤ this darkening vs empty ⇒ black (default; adapts after fix)
AGE_PROTECT     = 4     // valid frames a stone must survive to be capture-protected
```

## SGF coordinates

Column/row integers map to SGF letters `a–s` via `SGF_LETTERS[col] + SGF_LETTERS[row]`. Manual-fix setup stones are emitted as root-node `AB`/`AW` properties.

## Deployment

GitHub Pages (static hosting, free HTTPS — required for camera on iPhone Safari). Push to `main`; Pages redeploys automatically.
