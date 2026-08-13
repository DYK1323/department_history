# Context Snapshot: Admin Editor Next Phase

## Task Statement

User asked to update the admin redesign plan to match the current implementation state, then run a ralplan-style consensus pass and keep the final planning artifacts committed on `redesign-org-flow-ui`.

## Desired Outcome

- `ADMIN_EDITOR_PLAN.md` reflects what is already implemented versus what remains.
- The next admin-editor milestone is narrowed to a realistic, ordered execution plan.
- The plan is explicit about UX, API, verification, and follow-up staffing.

## Known Facts / Evidence

- `admin.html` now uses a dedicated admin page instead of the old inline editor.
- Admin access is protected with Basic auth in `server/app.js`.
- `변경 학년도` is auto-available through `current year + 1`.
- `유지 학년도` lives visually on the `변경 전` side and defaults to `changeYear + 3`.
- Unit selection uses a custom search menu, leaf-only options, and active-unit filtering by year.
- `변경 전` search shows up to 100 results; `변경 후` search shows up to 12.
- Recent-entry cards are already compacted into a one-line relation summary plus a second metadata line.
- Missing capabilities are still relation edit mode, relation detail reload, and inline creation of new `변경 후` units.

## Constraints

- Preserve the static HTML + lightweight Node server shape.
- Keep SQLite as the write source of truth and CSV as compatibility/export output.
- Do not introduce unnecessary schema churn for features that can be solved in UI/API.
- Keep admin UX practical for staff entry work, not just technically complete.

## Unknowns / Open Questions

- Whether recent-entry editing should be inline replacement or explicit “edit mode” with a visible banner.
- Whether new `변경 후` unit creation needs immediate clause/ordinance linkage or can stay relation-only in the first pass.
- Whether the first edit milestone should include delete support, or defer delete entirely.

## Likely Codebase Touchpoints

- `ADMIN_EDITOR_PLAN.md`
- `admin.html`
- `server/app.js`
- `README.md`
- future optional artifacts under `.omx/plans/`
