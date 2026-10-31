# ADR 0003 — MUI X only on the reports page

- **Status:** Accepted
- **Date:** 2026-10-30
- **Phase:** UPGRADE-PLAN 3.1

## Context

The owner's reports page needed three new things: waits by hour, no-show rate
by day and staff throughput, plus a per-queue table that owners want to sort,
filter and export. The rest of the web app is Tailwind with hand-written
components, and docs/BRAND.md sets strict rules (no ripple-style motion, no
gradients, colour for state).

## Decision

Use **MUI X DataGrid and MUI X Charts on `/dashboard/reports` only**, themed
from the same tokens as Tailwind (`apps/web/src/theme/tokens.ts` →
`tailwind.config.ts` and `src/theme/mui-theme.ts`). The Emotion cache and the
theme are provided by `dashboard/reports/layout.tsx`, not the root layout.

## Why

What the DataGrid gives for free, and what building it by hand would cost:

| Feature | DataGrid | By hand |
|---|---|---|
| Column sort, multi-type (number, date) | built in | a sort state, comparators per type |
| Column resize, hide, reorder | built in | days of pointer-event code |
| Quick filter and column filters | built in | a filter model and UI |
| CSV export of the visible rows | built in (toolbar) | already have a server CSV; the grid's is per view |
| Keyboard navigation, ARIA grid roles | built in, tested by MUI | easy to get wrong |
| Pagination | built in | simple, but one more thing |

MUI X Charts gives axes, two y-axes, legends and tooltips with SVG output.
The data here is small (24 hours, ≤ 400 days), so chart performance is not a
factor.

## Why not everywhere

- **Bundle size.** MUI + Emotion + X is large. The TV display runs on cheap
  Android sticks and the patient page on budget phones; neither needs a grid.
  Keeping MUI behind one route means only an owner opening reports pays for it
  (Next splits per route).
- **Two styling systems.** Tailwind for the app, Emotion for one page. The
  shared token module keeps the colours, radius, shadows and font identical;
  a test (`src/theme/mui-theme.spec.ts`) fails if they drift.
- **Brand rules.** MUI's defaults (ripple, elevation overlays, uppercase
  buttons, chart animations) break docs/BRAND.md. The theme turns off ripple and
  overlays, and the charts use `skipAnimation`.

## Consequences

- No `CssBaseline`: Tailwind's preflight already resets the page.
- MUI styles are inserted after Tailwind's, so MUI wins at equal specificity
  inside the grid and charts; Tailwind classes are not used inside MUI
  components.
- If a second page ever needs a grid, it reuses `theme/mui-theme.ts` and the
  same layout pattern. If several do, move the provider up a level.
