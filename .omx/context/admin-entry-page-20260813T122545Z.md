# Context Snapshot: Admin Entry Page

## Task Statement

User asked to create an implementation plan and validate it with `$ralplan` for moving the overly simple inline curriculum-change entry form into a separate admin page.

## Desired Outcome

- Main `index.html` returns to a focused read-only flow viewer.
- A new administrator page provides a richer curriculum-change entry workflow.
- Existing SQLite-backed server flow remains compatible with the current viewer.
- The plan is consensus-reviewed before implementation.

## Known Facts / Evidence

- Current branch: `redesign-org-flow-ui`.
- Latest implementation commit: `fc6eacc Add curriculum change entry modal and save API`.
- Existing viewer loads `dim_org_unit.csv` and `org_unit_relation.csv`.
- `server/app.js` currently serves those CSV paths from `department_history.sqlite` when present, falling back to static CSV files.
- `POST /api/relations` exists and inserts a relation into SQLite, then syncs CSV exports.
- `index.html` currently contains an inline modal editor added as a minimal proof of storage flow.
- `schema.sql` and `scripts/migrate_to_sqlite.js` exist.
- SQLite migration had previously validated exact legacy view parity with the source CSV.

## Constraints

- Keep the current viewer behavior stable.
- Do not hand-edit CSV as the source of truth for new admin entry.
- Avoid adding package dependencies unless there is a strong reason.
- Preserve the lightweight static/Node shape of the repo.
- Do not implement during ralplan; planning artifacts only.

## Unknowns / Open Questions

- Whether admin page should support editing/deleting existing relations in the first pass or only creation.
- Whether admin page should include org-unit creation in the first pass.
- Whether users need source law/rule text linked at event level in the first pass.
- Whether multiple relations under one event should be saved as a batch immediately or incrementally one relation at a time.

## Likely Codebase Touchpoints

- `index.html`: remove inline editor UI and add a small admin link if desired.
- `admin.html`: new admin page for entry/review.
- `server/app.js`: add admin bootstrap/list APIs; keep save API; likely add relation read endpoints.
- `README.md`: document admin page route and migration/admin workflow.
- `SCHEMA_MIGRATION_PLAN.md`: optionally record admin workflow decisions.

