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

**Design goal:** work on *most* boards and stones with only *slight* colour/lighting variation — never hardcode or "learn" one specific board. Reliable invariants the algorithm may exploit: stones are round, the board is square, the grid is regular. All colour thresholds are derived *relative to the wood measured live in the current frame*, so there are no fixed colour constants.

**Colour classification, not brightness-vs-baseline (HSV).** A stone is *achromatic* (low saturation); wood is a *saturated warm colour*. So saturation `S` separates wood from stones and value `V` separates black from white — and, crucially, **no empty-board baseline is needed** (mid-game start works; no baseline contamination). Each frame the warped board is converted to HSV (`_classifyBoardHSV`); for each of the 361 intersections a disk is sampled and its **median** S and V taken (`sampleMedianSV`) — median ignores the small specular highlight on a glossy stone.

**Wood-relative thresholds (method A — current).** Earlier we tried 1-D k-means to split wood/stone, but on *sparse* boards k-means splits the large wood cluster (wide grain spread) instead of isolating the few stones → stones missed. Instead, anchor on the wood: wood is the high-saturation material, so estimate `woodS`,`woodV` = median S,V of the top-saturation cells (cells with `S ≥ P60`, which are wood at any stone density up to ~60%). Then per cell:
- **black** if `V < 0.60·woodV` **and** `S < 0.70·woodS` (dark, and not a saturated shadowed-wood cell);
- **white** if `S < 0.50·woodS` **and** `V > 0.60·woodV` (much less saturated than wood, and bright);
- else **empty** (wood).
These are physical ratios (black is much darker than wood; white is much less saturated), so they generalize across boards; the absolute anchors `woodS`/`woodV` are re-measured every frame. An empty board yields no stones (nothing clears the ratios).

**Planned backups (not yet built):**
- **(B) Pre-game calibration stones.** At setup, place a known black + white stone at designated points; the app measures the *actual* (S,V) of black, white, and wood for the current board/lighting and sets the split thresholds at the measured midpoints. This is per-session measurement (a white-balance card), NOT overfitting to one board — it's the most robust option for unusual boards (dark wood, tinted stones) where the fixed ratios in A might not hold. A overrides → B measured values when available.
- **(C) Round-shape check.** Verify an accepted stone cell is a stone-sized *circle* (coverage of low-S/dark pixels within the disk, and/or circularity `4πA/P²`) to reject non-round false positives (glare, wood knots, hand edges); optionally snap sampling to the detected circle centre to correct minor grid misalignment. Add only if residual false positives / alignment errors appear in testing.

**Motion & occlusion gating (not a fixed timer):** sampling is fast (`SAMPLE_INTERVAL=400`ms) but frames are filtered. `_motion` = fraction of pixels that changed since the last frame; above `MOTION_THRESH` the scene is moving (a hand placing a stone) and the frame is skipped. `_computeOcclusion` flags a large border-touching blob (an arm reaching in) and invalidates the frame. A move is committed `QUIET_FRAMES` settled frames after the hand withdraws.

**Tentative-confirm model:** a detected move stays *tentative* until the opponent's reply confirms it (`_resolveTentative`). `boardState` is the live DISPLAY (confirmed + one provisional move); `_confirmed` is only what's emitted to the SGF. Competing same-colour candidates for one turn are held until one survives or the opponent forces a pick (`_mostStoneLike`, chosen by closeness in value `V` to confirmed same-colour stones). Go capture/suicide rules are applied throughout.

**False-disappearance recovery:** a stone leaves only by capture. A mature stone (`_age >= AGE_PROTECT`) that reads empty but whose group still has a liberty was not captured (shadow/partial occlusion) and is restored; a young vanished stone is let go (self-heals a transient false positive).

**Manual fix + mid-game start:** `setBoardState(board, nextTurn, calibrate)` replaces the confirmed position wholesale (used by the 修正 Fix overlay and by undo). The corrected board becomes the SGF/broadcast start (Approach A: prior per-move history is dropped; see `sgf.js` setup stones and `viewer.html` `stateAt` seeding). Mid-game start also works *without* a fix now, because HSV classification needs no empty baseline. (The `calibrate` flag and the legacy `_recalibrate`/`_fixupBaseline` it triggers are dormant no-ops under the HSV path, kept pending cleanup.)

**Legacy (dormant, pending removal):** the old brightness-delta classifier — `_captureBaseline`, `_baseline`, `_ambient`, `_deltaGrid`, `_classifyIntersection`, `_whiteDelta`/`_blackDelta`, `_recalibrate`, `_fixupBaseline` — is no longer on the code path (guards make it no-op). Remove after the HSV path is confirmed stable on device.

## Live broadcast (live.js + viewer.html)

`app.js` publishes the game (info + moves + optional `setup`; tentative stones flagged `prov:1`) to Firebase RTDB via `livePublish(id, game)` REST PUT. `viewer.html?id=<gameId>` polls `liveFetch` every `POLL_MS=3000`, replays with capture rules, and auto-plays newly-arrived moves when the viewer is at the latest position. The viewer also supports a scratch "试下" variation branch and SGF export.

## Key constants (detector.js)

```js
SAMPLE_INTERVAL = 400   // ms between sampled frames (fast; motion gating filters)
QUIET_FRAMES    = 2     // settled frames of a stable new state before committing
MOTION_THRESH   = 0.03  // fraction of changed pixels above which the frame is "moving"
WARP_SIZE       = 760   // px for the perspective-corrected board image
AGE_PROTECT     = 4     // valid frames a stone must survive to be capture-protected
```

HSV classification (method A) uses no fixed colour constants — thresholds are ratios of the live-measured `woodS`/`woodV` (see above): black `V<0.60·woodV & S<0.70·woodS`, white `S<0.50·woodS & V>0.60·woodV`, wood reference from cells with `S ≥ P60`. (`WHITE_DELTA`/`BLACK_DELTA` remain only in the dormant legacy classifier.)

## SGF coordinates

Column/row integers map to SGF letters `a–s` via `SGF_LETTERS[col] + SGF_LETTERS[row]`. Manual-fix setup stones are emitted as root-node `AB`/`AW` properties.

## Deployment

GitHub Pages (static hosting, free HTTPS — required for camera on iPhone Safari). Push to `main`; Pages redeploys automatically.
