# forecast-assets

MSS weather icons + rain legend, fetched from weather.gov.sg (see ATTRIBUTION.md).

- `icons/<slug>.png` — 75px condition masters (`-sm`/`-small` on the site are scaled copies)
- `icons/wind/{sm,lg}/<DIR>.png` — 16-point compass arrows
- `icons/misc/` — rain-drop + thermometer stat icons
- `legends/rain-intensity.jpg` — Heavy→Light radar ramp
- `mappings.json` — `twoHrText` (2-hr forecast strings), `codes` (24-hr/4-day codes),
  `windDir`, `aliases` (legend labels with no exact file), `fallback`

Regenerate: `node scripts/fetch-forecast-assets.mjs`
