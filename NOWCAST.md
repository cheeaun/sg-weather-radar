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
   `Date.now() - latest70 <= 10 min` (no stale feed). Only the newest run of
   **consecutive** 5-min slots is used (stops at the first gap); all deltas,
   growth and dense offsets assume one 5-min step per pair, so a missing frame
   would otherwise double the velocity. Fewer than 3 consecutive → no nowcast.
2. **Cell detection**: `analyzeRainCells(canvas, true)` — full-frame mode.
   Flood fill over the whole 480×480 frame (sea + Johor included) so
   approaching weather outside Singapore is tracked. Cells get `area: -1`;
   summaries/votes stay Singapore-only via `SG_RAIN_PIXEL_DATA` lookups.
   `rainMembers` buffer is sized to the full frame (a squall can exceed the
   SG land-pixel count — do not shrink it back).
3. **Edge cells**: `analyzeRainCells` flags cells within 2 px of the frame
   (`edge`); `pairCells` marks pairs involving one. Edge pairs are excluded
   from deltas (median/d1/d2 and the rolling-fit validation), and lineages
   touching the edge get growth 0 — the centroid of a cell entering/leaving
   view shifts with no real motion (it once dragged an east-edge cell west).
   **Tracking**: `trackCells(lineageCells)` links each current cell backwards
   through every consecutive frame pair (`pairCells` on each pair). Each cell
   gets: median delta over up to 4 samples, `sigma` = max deviation from that
   median, and `growth` = clamped (±0.3) exponential mass rate per 5-min step
   over the lineage. (The d1/d2 single-pair members were removed: 14–20 pts
   under persistence at every lead over 22 frames on 23 Sep.)
4. **Dense flow**: `estimateDenseFlow(canvases, generation)` —
   12-px block matching on the 240px downsample, averaged over the last two
   frame pairs. Blocks with no texture (all dry, or one uniform level) are
   **unknown**, not zero motion; they are filled by normalized convolution
   from textured blocks within `DENSE_FILL_RADIUS` (3 blocks), else the
   global mean. Upsampling is aligned to block centres (12·b + 6). Search offsets are ordered
   smallest-magnitude first (`DENSE_OFFSETS`) with an early exit on score 0;
   see "tie-break bug" below. Async, yields every 8 block rows, checks
   `nowcastGeneration` after each yield.
5. **Members** (per forecast step 1–3, each an `advectForward` output):
   - `median` — lineage median delta × step; large/erratic/unmatched cells
     ("sheet" cells) use dense flow instead.
   - `wind` — `windDisplacement` (m/s → px via meters-per-degree over the
     70km box; **seconds, not milliseconds** — see bugs below).
   - `dense` — dense flow × step.
   Fade is per-cell: `(0.92 · e^growth)` clamped to [0.3, 1.2], raised to
   `step`; plus a ±1 level shift when |growth| > 0.25. Growing cells stop
   fading; dying cells fade faster.
6. **Output**: the `lookback` member (see below) renders on the map and
   drives ticks + `summarizeRain` via `entry.summaryLevels`. (`maxBlend`
   over the members was removed: 8–10 pts under persistence, over-predicts.)
   Entries stored in `nowcastCanvases` keyed by slot ms; sentinel frames
   `nowcast:<slot>:<seed>` (seed = shortHash of median deltas) go into
   `framesMap[70]` so the timeline/slider treat them like frames.
7. **Async safety**: every recompute bumps `nowcastGeneration`; after each
   `await` the compute checks it and bails before writing anything. clear()
   runs synchronously at call time, so a superseded run can never write into
   the new generation's maps.

## Verification

Metric: pooled Jaccard (`jaccardRain`). Both fields max-pooled by
`NOWCAST_FIT_POOL` (4 px ≈ 1.2 km; the 70km canvas is ~290 m/px) before
scoring. Was 10 px (≈2.9 km, not 1.5 km as previously documented) — wider
than a typical 5-min displacement, so no-motion persistence scored about as
well as advection. A pair is skipped (null) only when **both** forecast and
actual have < `NOWCAST_FIT_MIN_PIXELS` (50) rain pixels; a forecast that paints
rain on a dry frame scores 0 (false alarm).

- **Rolling fit** (button tooltip, "model fit N% vs M% no-motion (K frames,
  rolling 1 h)"): one-step validation — advect frame[-2] by the velocity that
  brought its cells in, score vs the actual; baseline = frame[-2] unmoved.
  Samples are `{slot, model, persistence}`, **one per live slot**
  (`recordFitSample` replaces by slot — recompute also runs on repeat polls,
  wind loads and toggles). Model below no-motion = advection is hurting.
- **Per-member verification** (`nowcastPending` → `verifyPendingNowcasts`):
  every run registers each step's member levels keyed `${targetSlot}:${lead}`:
  `median wind dense` + `display` (old forward-splat map output) + `lookback`
  (what the map and summary show) + `lookbackNoDecay` (same motion, no level
  decay / small-cell drop — isolates decay error) + `persistence` (latest
  frame unmoved). When a target
  slot goes live, all leads (+5/+10/+15) aimed at it are scored against it,
  logged (`nowcast members @+Nmin: …`) and persisted to localStorage
  `sgwr-nowcast-scores` (`{slot, lead, pool, s:{member: j}}`, deduped by
  slot+lead, capped at `NOWCAST_SCORES_MAX`). Pending entries at or before the
  live slot are dropped; the map is cleared when the toggle is off.
- **Persistence across reloads**: pending forecasts are saved to localStorage
  `sgwr-nowcast-pending` (levels run-length encoded, base64 Uint16 pairs;
  shared arrays such as `persistence` encoded once; entries older than 30 min
  dropped on load) and fit samples to `sgwr-nowcast-fit`, so dev reloads no
  longer lose +10/+15 scores. Quota errors fall back to in-memory only.
- **Score versions**: records carry `v` (`NOWCAST_SCORE_VERSION`, now 2;
  missing = 1). Bump it whenever forecast logic changes; `nowcastScores()`
  shows the current version by default (`nowcastScores({ v: 1 })` for older).
- **`nowcastScores()`** in the console: `console.table` of mean score per
  lead × member over the persisted history, plus mean points vs persistence.
  This is the A/B loop — no deploys needed to compare member changes. Filter
  by `{pool}` if the pool radius changes.

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
- **Raw dense on the map**: dense's 12-px block grid tears sheet cells into
  axis-aligned rectangles (sharp voids showing the basemap). Display must
  use wind IDW (or low-pass dense), never raw dense. A few Gaussian passes
  are not enough — 4× box-average + bilinear upsample is.
- **Naive 3×3 mode filter / canvas blur on display**: mode eats interiors
  into white holes; blur thins alpha so the basemap shows through as pale
  rectangles. Fills must be rain-preserving (delete only isolated speckles).
- **Uniform-color hole fill**: stamping one max-level neighbor's RGBA into a
  multi-pixel hole paints a flat rectangle. Use IDW rim colors.
- **Full 4-corner bilinear splat**: every pixel becomes a 2×2 stamp → light
  rain over-populates on +5. Splat the dominant corner; extra corners only
  when weight ≥ 0.4.
- **Stale nowcast cache**: `frameImageKey` includes `nowcast:slot:seed`; a
  recompute with unchanged median deltas re-served the old bitmap. Nowcast
  frames bypass `frameImageCache`.

## Transport & blend cleanup

Transport is bilinear splat of the **dominant** corner at full fade alpha;
extra corners only when weight ≥ 0.4 (bridges shear without turning every
pixel into a 2×2 stamp — full-footprint splat made light rain over-populate
on +5). Spatial fills require a moderate-or-heavier neighbor (`maxL >= 2`)
so light fringes don't bloat. Dense flow is low-passed (4× box + bilinear).

**Map display** uses a dedicated `createDisplayField`: small cells follow
their median track; sheets follow the **wind IDW** (smooth shear, no block
grid) topped up by low-pass dense × `(1 − mask)`. Station wind u/v are
pre-multiplied by the coverage mask (→ 0 ~24 km beyond the stations), so
without the top-up far sheets (Strait, Johor) stalled. Wind missing (API 429)
→ mask 0 → pure **low-pass dense** (4× box average + bilinear upsample) — never raw dense, which
re-tears into axis-aligned rectangles. Raw dense stays in the ensemble for
votes. Pipeline: `advectForward(displayField)` → `spatialCoherence` →
`fillHoles` → `fillEnclosedHoles`. Nowcast frames bypass `frameImageCache`.

## Look-back member (map default)

The map renders **`lookbackNoDecay`** (look-back motion, no decay), and
ticks/summaries use the same levels (`entry.summaryLevels`) so the text
matches what is drawn. `lookback` (same motion + level decay + small-cell
drop) was the map field briefly but made light rain visibly vanish at
+10/+15 (whole light fringes of weakening cells dropped at once, small cells
removed); it stays scored so decay can be judged on evidence. Switched
after it beat the old forward-splat `display` at +5/+10 on early scores and
removed its smeared/speckled look. There is no flag back to the old output;
`display` is still computed only so it keeps being scored.

- `buildLookbackField`: one smooth per-5-min motion field on a 60×60 grid
  (8 px cells) by normalized convolution — trusted cell median tracks (w 1/px,
  0.5 for sheets > `NOWCAST_SHEET_PIXELS`), low-pass dense at rain pixels
  (w 0.5), station wind × mask (w 0.2/px), 2× box blur radius 3, plus a weak
  global-mean prior so empty regions drift with the overall flow.
- `createLookback`: semi-Lagrangian — each output pixel traces back one step
  per lead along the field (incremental, bilinear field sample, nearest source
  pixel so palette colors stay exact). Traced outside the frame → dry.
- **Decay (the `lookback` member only; not on the map)** is in the levels, not alpha: per cell, cumulative log mass change
  `step · (ln NOWCAST_DECAY + growth)`, one level per halving (`round(Δ/ln 2)`,
  clamped to [-3, 0]); level ≤ 0 → dropped. Recolored within the new level's
  palette band (`recolorToLevel`, relative band position kept, checked against
  `rainLevelForColor`). **Never upgrades**: merges inflate lineage growth (a
  squall absorbing neighbours "doubles"), and +1 turned whole sheets heavier.
  Cells smaller than `LOOKBACK_MIN_CELL_PIXELS[step]` (0/6/12/24) are dropped.
- No forward splat → no holes → none of the fill passes; real dry gaps stay dry.
- Next: once +15 scores over a few rain events confirm it, delete the legacy
  path (`createDisplayField`, `spatialCoherence`, `fillHoles`,
  `fillEnclosedHoles`) and the `display` member.

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
| NOWCAST_FIT_POOL | 4 | metric max-pool radius (px; ~1.2 km at ~290 m/px) |
| NOWCAST_FIT_MIN_PIXELS | 50 | skip scoring when both sides have fewer rain pixels |
| NOWCAST_SCORES_MAX | 216 | persisted verification records (~6 h of scored frames, 3 leads each) |
| NOWCAST_FIT_MAX_AGE / _SAMPLES | 1 h / 120 | rolling window |

## TODO — candidate improvements, in the order worth trying

1. **Watch the member scores across a few rain events.** The
   `nowcastScores()` table (persisted per-lead scores vs persistence) is the evidence base. If a member
   consistently scores worst, consider dropping or re-weighting it
   First pass done (23 Sep): d1, d2 and blend removed. Open question:
   `lookback` at +15 had big losses (−6 to −10) while `median` stayed within
   −5 — compare `lookback` vs `lookbackNoDecay` to see if decay is the cause.
2. **Use the lineage median in createField's sheet fallback for growth** —
   growth is only applied via fade/level-shift; footprint dilation/erosion
   (grow/shrink the cell mask by the rate) would show intensity change
   spatially, not just as alpha.
3. **Cell splitting/merging handling** — pairCells is one-to-one; a squall
   line that splits between frames currently breaks tracking for both
   children. Allow one-to-many for large sources (area-weighted).
4. ~~Score at +10/+15 min too~~ — done (`nowcastPending`).
5. ~~Adaptive vote threshold~~ — obsolete: member votes no longer gate the
   summary (`areaVotes` removed).
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
- Fit stuck at a number but no member logs → `verifyPendingNowcasts` only
  scores when a previously-forecast slot becomes live (5-min cadence), and
  skips pairs where both sides are near-dry.
- Check state in page: `document.querySelector('.nowcast-icon').closest('button').title`
  (tooltip = fit), `document.querySelectorAll('.tick-shape.nowcast').length`.
