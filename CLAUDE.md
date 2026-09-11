# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LiveGo — a pure client-side web app that uses a phone's rear camera to watch a 19×19 Go game, detect stone placements via OpenCV.js (WebAssembly), and export an SGF file. No backend, no build step.

## Running locally

```bash
python3 -m http.server 8080
# then open http://localhost:8080 on desktop
# on iPhone: open http://<your-mac-ip>:8080 (camera requires HTTPS or localhost;
#   for iPhone testing use a tunnel like: npx localtunnel --port 8080)
```

Camera access on iPhone Safari requires HTTPS. For local dev use `localtunnel` or `ngrok`.

## File layout

| File | Role |
|---|---|
| `index.html` | Two-screen layout: setup (corner picking) and recording |
| `style.css` | Mobile-first UI, dark theme, iOS safe-area aware |
| `corners.js` | `CornerPicker` class — tap-to-pick 4 board corners, draws overlay polygon |
| `detector.js` | `BoardDetector` class — perspective warp + per-intersection stone classification |
| `sgf.js` | `SGFRecorder` class — move list, undo/redo, SGF string generation, file download |
| `app.js` | Boot, screen transitions, wires all modules together |

## Architecture

**No framework, no bundler.** Plain ES2020 modules loaded via `<script src>`. OpenCV.js is loaded from the official CDN via `<script async>` with an `onload` callback.

**Two-screen flow:**
1. **Setup screen** (`#screen-setup`): Camera stream + canvas overlay for corner picking. `CornerPicker` handles tap events and draws the polygon. After 4 corners + game info, transitions to screen 2.
2. **Recording screen** (`#screen-record`): Same camera stream (both `<video>` elements share the same `MediaStream`). `BoardDetector` polls at `SAMPLE_INTERVAL` ms, warps the frame with `cv.warpPerspective`, samples grayscale brightness at each intersection, diffs against the last known state, and calls `onMove` after `CONFIRM_FRAMES` consecutive identical states.

**Perspective correction:** Display-space corner coordinates are scaled to video-pixel coordinates before being passed to `cv.getPerspectiveTransform`. Output is always `WARP_SIZE × WARP_SIZE` px.

**Stone classification:** For each intersection, `sampleCircleMean` averages grayscale pixels within a circular region. Thresholds (`_blackThresh`, `_whiteThresh`) are re-derived each frame from the four board corners (assumed empty wood).

**Move confirmation:** A candidate new state must appear in `CONFIRM_FRAMES` (3) consecutive samples before it is committed. This suppresses false positives from hands passing over the board.

**SGF coordinates:** Column/row integers map to SGF letters `a–s` via `SGF_LETTERS[col] + SGF_LETTERS[row]`.

## Key constants (detector.js)

```js
SAMPLE_INTERVAL = 1500  // ms between detection frames
CONFIRM_FRAMES  = 3     // stable frames before recording a move
WARP_SIZE       = 760   // px for the perspective-corrected board image
```

Increase `SAMPLE_INTERVAL` to reduce CPU use; increase `CONFIRM_FRAMES` if false moves appear.

## Deployment

GitHub Pages (static hosting, free HTTPS — required for camera on iPhone Safari).
