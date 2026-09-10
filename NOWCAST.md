# 70km Nowcast — Implementation Notes & Roadmap

Everything learned while building and debugging the client-side nowcast
ensemble in `main.js`. Read this before changing any `NOWCAST_*` code.
AGENTS.md has the one-paragraph summary; this file has the detail.

## What it is

Opt-in toggle (`sgwr-nowcast` localStorage key) that extends the timeline
three slots into the future (+5/+10/+15 min) using a client-side ensemble of
advection members. No Worker/API changes; everything runs on the main thread
over canvases already in `frameImageCache`.

## Pipeline (in recomputeNowcast)

1. **Input**: last `NOWCAST_FRAMES` (5) live 70km frames, oldest → newest.
   The 70km feed publishes early, so the feature is gated on
   `latest70 === latestGlobal` (all ranges caught up) and
   `Date.now() - latest70 <= 10 min` (no stale feed).
2. **Cell detection**: `analyzeRainCells(canvas, true)` — full-frame mode.
   Flood fill over the whole 480×480 frame (sea + Johor included) so
   approaching weather outside Singapore is tracked. Cells get `area: -1`;
   summaries/votes stay Singapore-only via `SG_RAIN_PIXEL_DATA` lookups.
   `rainMembers` buffer is sized to the full frame (a squall can exceed the
   SG land-pixel count — do not shrink it back).
3. **Tracking**: `trackCells(lineageCells)` links each current cell backwards
   through every consecutive frame pair (`pairCells` on each pair). Each cell
   gets: median delta over up to 4 samples, `sigma` = max deviation from that
   median, and `growth` = clamped (±0.3) exponential mass rate per 5-min step
   over the lineage. d1/d2 (last two single-pair deltas) are kept as separate
   ensemble members for diversity.
4. **Dense flow**: `estimateDenseFlow(canvasB, canvasC, generation)` —
   12-px block matching on the 240px downsample. Search offsets are ordered
   smallest-magnitude first (`DENSE_OFFSETS`) with an early exit on score 0;
   see "tie-break bug" below. Async, yields every 8 block rows, checks
   `nowcastGeneration` after each yield.
5. **Members** (per forecast step 1–3, each an `advectForward` output):
   - `median` — lineage median delta × step; large/erratic/unmatched cells
     ("sheet" cells) use dense flow instead.
   - `d1`, `d2` — the two most recent single-pair deltas.
   - `wind` — `windDisplacement` (m/s → px via meters-per-degree over the
     70km box; **seconds, not milliseconds** — see bugs below).
   - `dense` — dense flow × step.
   Fade is per-cell: `(0.92 · e^growth)` clamped to [0.3, 1.2], raised to
   `step`; plus a ±1 level shift when |growth| > 0.25. Growing cells stop
   fading; dying cells fade faster.
6. **Blend**: `maxBlend` (per-pixel max level) is what renders on the map;
   `areaVotes` (≥2 of 5 members) + `summarizeRain` produce the summary text.
   Entries stored in `nowcastCanvases` keyed by slot ms; sentinel frames
   `nowcast:<slot>:<seed>` (seed = shortHash of median deltas) go into
   `framesMap[70]` so the timeline/slider treat them like frames.
7. **Async safety**: every recompute bumps `nowcastGeneration`; after each
   `await` the compute checks it and bails before writing anything. clear()
   runs synchronously at call time, so a superseded run can never write into
   the new generation's maps.

## Verification

- **Rolling fit** (button tooltip, "model fit N% (rolling 1 h)"): one-step
  validation — advect frame[-2] by the velocity that brought its cells in,
  then `jaccardRain(validation, actual)`. Samples are `{t, j}` pruned past
  `NOWCAST_FIT_MAX_AGE` (1 h), cap `NOWCAST_FIT_MAX_SAMPLES`.
- **`jaccardRain` is neighborhood-pooled**: both fields max-pooled by
  `NOWCAST_FIT_POOL` (10 px ≈ 1.5 km) before scoring. Pixel-exact Jaccard
  zeroed out on small advection errors (a shifted 20-px cell = 0%).
- **Support floor**: `NOWCAST_FIT_MIN_PIXELS` (50). Frames with less actual
  rain return `null` and are skipped — otherwise "no rain anywhere" pairs
  scored a perfect 1.0 and inflated the average. During dry spells the fit
  just stops updating ("pending").
- **Per-member scoring**: each entry stores `members` (level arrays). When a
  forecast slot becomes live, `scoreMembers` pooled-scores all 5 members'
  +5 min output against the actual frame and logs
  `nowcast members @+5min: median=N% d1=N% d2=N% wind=N% dense=N%`.
  This is the A/B experiment loop — no separate deploys needed to compare
  member changes. Results so far: wind member often leads during steady
  flow (after being literally blank pre-units-fix).

## Bugs found & fixed (do not regress)

- **windDisplacement units**: wind speed is m/s; elapsed time must be
  `steps * 5 * 60` seconds. An earlier draft multiplied by `5 * 60 * 1000`
  (ms) → ~1000× overshoot → every wind-advected pixel off-canvas → wind
  member blank, unmatched cells vanished from d1/d2 members.
- **Dense-flow tie-break**: block matching kept the FIRST offset on ties and
  searched from (-12,-12) outward. Texture-less block interiors scored 0 at
  every offset → matched at max phantom motion (-24 px/step full-res) while
  textured edges matched realistically → after 3 steps, 72-px tears: cells
  shredded into grid-periodic combs/stripes (visible in the Johor cells).
  Fixed by ordering `DENSE_OFFSETS` smallest-magnitude first (ties → zero
  motion) + early exit on perfect score.
- **Dropped loop line**: that same patch once swallowed the
  `for (let bx…)` line → `ReferenceError: bx is not defined` on every
  recompute, caught by recomputeNowcast's catch → silent "no nowcasts".
  Lesson: `agent-browser errors` does NOT show caught `console.error`
  rejections — always check the full `console` log when the nowcast is
  silently absent.
- **Pooled-metric inflation**: see support floor above.

## Remaining jaggedness (known, accepted)

Transport is nearest-neighbor (`round(x + dx)` per pixel). Where the
displacement field has a real gradient, rows stretch into dotted edges or
compress. Only visible at genuine rain edges; fix would be bilinear splat
weights. Only do it if it's visibly offensive in heavy rain.

## Tuning constants (main.js, NOWCAST_* block)

| Constant | Value | Role |
|---|---|---|
| NOWCAST_FRAMES | 5 | lineage depth (more = stabler velocity, more CPU) |
| NOWCAST_DECAY | 0.92 | neutral per-step fade before growth adjustment |
| NOWCAST_GROWTH_MAX | 0.3 | clamp on per-step exponential mass rate |
| NOWCAST_MATCH_DISTANCE | 40 | max centroid jump (px) for a cell pair |
| NOWCAST_MATCH_OVERLAP | 0.3 | min pixel overlap for a pair (unless ≤12px away) |
| NOWCAST_SHEET_PIXELS | 4000 | cells bigger than this prefer dense flow |
| NOWCAST_SHEET_SIGMA | 8 | median delta distrust threshold (px) |
| NOWCAST_FIT_POOL | 10 | metric max-pool radius (px; ~1.5 km) |
| NOWCAST_FIT_MIN_PIXELS | 50 | min actual rain pixels to score a frame |
| NOWCAST_FIT_MAX_AGE / _SAMPLES | 1 h / 120 | rolling window |

## TODO — candidate improvements, in the order worth trying

1. **Watch the member scores across a few rain events.** The
   `nowcast members @+5min` log is the evidence base. If a member
   consistently scores worst, consider dropping or re-weighting it
   (maxBlend is max-based so a bad member mostly pollutes via votes).
2. **Use the lineage median in createField's sheet fallback for growth** —
   growth is only applied via fade/level-shift; footprint dilation/erosion
   (grow/shrink the cell mask by the rate) would show intensity change
   spatially, not just as alpha.
3. **Cell splitting/merging handling** — pairCells is one-to-one; a squall
   line that splits between frames currently breaks tracking for both
   children. Allow one-to-many for large sources (area-weighted).
4. **Score at +10/+15 min too**, not just +5 (scoreMembers only fires when a
   slot first goes live; later steps could be scored when *their* slot
   arrives by reusing the stored member canvases per step).
5. **Adaptive vote threshold** — `votes >= 2` of 5 was picked blind; with the
   metric in place, sweep 1..4 on a rainy day and read the pooled scores.
6. **Precompute frames for the validation member** — validation advects
   frame[-2]; if it used the lineage median instead of raw d1, the rolling
   fit would reflect what the median member actually does.
7. **Deep learning (last resort)** — rationale: DL nowcasting models
   (DGMR, NowcastNet, MetNet) beat optical flow mainly beyond ~30–60 min and
   for convective initiation/decay; at this app's +15 min horizon with
   5 input frames the classical ceiling is close, and the runtime is
   client-side CPU with a single-radar input, which rules out DGMR-class
   models (30M+ params, satellite/sounding inputs). The verification signal
   is also too noisy to train against until the pooled metric accrues real
   rain-event history. If ever attempted, the only sane shape here:
   small (1–5M param) spatiotemporal U-Net trained offline in Python on the
   historical 70km archive (the API serves historical dates, so the dataset
   is scriptable), exported to ONNX, quantized, lazy-loaded only when
   nowcast is enabled, WebGPU/WASM inference in a worker. Cheaper wins first:
   TODO items 1–5 plus a longer frame history and a per-cell decay term.

## Debugging cheatsheet

- No nowcast slots at all → check full console for `Nowcast error`
  (recomputeNowcast's catch); check the gate: `latest70 !== latestGlobal`
  or stale feed (both logged nowhere — add a console.log temporarily).
- "model fit pending" forever → rain below `NOWCAST_FIT_MIN_PIXELS`, or
  fewer than 3 live frames (timeline needs 5-min-aligned history).
- Fit stuck at a number but no member logs → `scoreMembers` only fires when
  a previously-forecast slot becomes live (5-min cadence).
- Check state in page: `document.querySelector('.nowcast-icon').closest('button').title`
  (tooltip = fit), `document.querySelectorAll('.tick-shape.nowcast').length`.
