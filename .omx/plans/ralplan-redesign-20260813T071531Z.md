# Ralplan Consensus: 편제 변경 이력 화면 개편

## Verdict

APPROVED after Planner draft, Architect ITERATE, Critic REJECT, revision, Architect APPROVE, Critic APPROVE.

## Requirements Summary

Implement `REDESIGN_PLAN.md` as a read-only redesign of `index.html`.

The work preserves the existing all-types graph behavior: yearly snapshots, sorting, department grouping, carry edges, relation edges, search, and lineage highlight. It intentionally removes CSV upload UI and change-type filtered graph views. Input forms, SQLite, mutation APIs, and CRUD workflows remain deferred.

## RALPLAN-DR

### Principles

- Preserve existing all-types snapshot, ordering, grouping, carry-edge, relation-edge, search, and lineage-highlight behavior.
- Keep this phase read-only.
- Extract layout constants before changing visual density.
- Avoid new dependencies and keep the first implementation pass in `index.html`.
- Keep tooltip and detail-panel state independent from coordinate calculation.

### Decision Drivers

- Minimize regression risk to graph geometry and edge paths.
- Improve readability and information density for long year ranges.
- Keep changes small, reviewable, and reversible in the current single-file app.

### Options

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| Constants-first single-file redesign | Lowest regression risk; matches brownfield constraints | Leaves `index.html` large | Chosen |
| DOM/CSS-first redesign | Faster visible progress | High geometry drift risk | Rejected |
| Split CSS/JS during redesign | Better long-term boundaries | Expands scope and complicates regression review | Defer |

## Implementation Plan

1. Capture baseline for the current all-types view: year-by-year node code order, edge counts, carry edge count, and representative SVG path strings.
2. Extract `LAYOUT` constants in `index.html` for node dimensions, offsets, vertical spacing, dept-box padding, canvas padding, column step, and edge anchors. First use current values and verify no behavior changes.
3. Remove deferred controls atomically: CSV upload markup, DOM refs/listeners, `updateLoad()` dependency, `FileReader` fallback, `typeFilter`, `fillSelect(typeFilter, ...)`, `selectedType`, and the type relation filter branch.
4. Restructure header/filter/year-header layout. Put the sticky year header in the same horizontal scroll context as the canvas, mirror canvas width, render labels from `xByYear`, and separate header cleanup from canvas cleanup.
5. Apply compact visual design: card-only organization name, one-line ellipsis, reduced node height/spacing, lighter dept boxes, calmer edges and labels.
6. Add universal tooltips from node metadata plus related `validUntil` when present.
7. Add detail panel using existing `state.nodes`, `state.edges`, and `state.units`; add `state.nodeMap` only if useful. Opening/closing the panel must not call `render()`.
8. Verify search, selection, reset, year filters, scroll alignment, responsive panel behavior, CSV loading, and console cleanliness.

## Acceptance Criteria

- HTTP page load automatically fetches `dim_org_unit.csv` and `org_unit_relation.csv`.
- CSV upload inputs, draw button, and change-type filter are gone.
- Controls are limited to start year, end year, organization search, and reset.
- Year header remains visible on vertical scroll and aligns with columns on horizontal scroll.
- All-types graph preserves node order, grouping, relation edges, and carry edges.
- Cards show organization name only; full metadata is available via tooltip/detail panel.
- Node selection opens detail panel and lineage highlighting still works.
- Panel open/close does not move graph coordinates.
- Search, year range changes, reset, select, and deselect work without console errors.

## Verification

- Serve locally over HTTP, e.g. `python -m http.server 8000`.
- Compare baseline and post-change all-types node order, edge count, carry edge count, and representative SVG path strings after constants extraction.
- Search by organization name and code.
- Select representative carry, split, merge, renewal, created, and closed relationships.
- Scroll vertically and horizontally to verify sticky header alignment.
- Resize to desktop and narrow widths to verify right panel and bottom drawer.
- Test CSV fetch failure and confirm the page explains that HTTP serving is required.
- Inspect browser console for JavaScript errors.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Geometry drift after density changes | Extract constants first and verify unchanged output before changing values |
| Change-type filter removal mistaken as regression | Document parity applies only to all-types view |
| Sticky header misalignment | Same scroll container, same width, same `xByYear` |
| Stale detail data | Reuse render-owned `state.nodes` and current `state.edges` |
| Panel causes layout shift | Use fixed overlay/drawer and avoid `render()` on panel state changes |
| CSV failure confusion | Provide explicit HTTP-server guidance |

## ADR

Decision: implement a conservative constants-first, single-file redesign of `index.html`.

Drivers: preserve graph behavior, improve density, keep this phase read-only and reversible.

Alternatives considered: DOM/CSS-first redesign, immediate JS/CSS extraction, keeping upload fallback, separate scroll-synced header, duplicated panel state.

Why chosen: the constants-first approach best protects the current graph geometry while allowing meaningful UI cleanup.

Consequences: `index.html` remains monolithic for now, but internal sections should be kept clean enough for a later no-behavior-change extraction.

Follow-ups: input forms, SQLite, APIs, CSV import/export, and optional CSS/JS file extraction.

## Agent Handoff Guidance

Available roles: `executor`, `verifier`, `designer`, `test-engineer`, `architect`, `critic`.

Recommended `$ralph` path: one `executor` implements sequentially using this plan and `REDESIGN_PLAN.md`, then `verifier` validates baseline and browser behavior.

Recommended `$team` path: use only if speed matters. Assign `executor` to `index.html` implementation, `designer` to visual QA guidance, and `verifier` or `test-engineer` to browser verification. Keep write ownership centralized in one implementation lane to avoid conflicts in the single HTML file.

Launch hints:

```text
$ralph implement .omx/plans/ralplan-redesign-20260813T071531Z.md
$team implement .omx/plans/ralplan-redesign-20260813T071531Z.md
```

Team verification path: implementation worker proves no console errors and feature behavior; verifier confirms baseline parity, sticky alignment, search/selection, detail panel, responsive behavior, and CSV failure messaging before shutdown.
