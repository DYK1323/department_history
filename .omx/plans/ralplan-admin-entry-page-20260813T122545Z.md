# Ralplan: Admin Entry Page

## RALPLAN-DR Summary

### Principles

- Keep the public flow viewer read-only and visually focused.
- Treat SQLite as the write source of truth; CSV remains compatibility/export output.
- Design admin entry around events and relation endpoints, not flat CSV rows.
- Make validation visible before save, not only after server rejection.
- Keep the first implementation small enough to verify end to end.
- Optimize for real staff entry work: fast search, low ambiguity, clear recovery, and review-before-save.

### Decision Drivers

- The inline modal is too small for real curriculum-change entry.
- Admin workflows need more room for endpoint selection, preview, validation, and future edit/delete.
- Existing viewer must keep working through the same CSV fetch contract.
- Users entering 학칙-driven changes need confidence that "what I selected" and "what will be saved" match.

### Viable Options

Option A: Keep inline modal and enrich it.
Pros: fewer files, faster superficial iteration.
Cons: cramped UX, mixes read and write concerns, hard to add review/edit workflows.
Verdict: invalidated for the user's stated preference and operational complexity.

Option B: Create `admin.html` as a separate page using current API.
Pros: clean separation, enough workspace, minimal backend expansion, preserves current app shape.
Cons: duplicates some client-side helpers unless shared later.
Verdict: chosen for first admin workflow.

Option C: Build a full routed single-page app.
Pros: more scalable long term.
Cons: requires introducing bundling/app structure that the repo does not currently use.
Verdict: defer until the static app becomes painful.

## ADR

### Decision

Implement a separate `admin.html` for curriculum-change administration, remove the inline editor from `index.html`, and expand the server API only enough to support admin bootstrap, preview/listing, and relation creation.

### Drivers

- Admin data entry is denser than the viewer toolbar can comfortably support.
- The schema already models `change_event`, `change_relation`, and endpoints, so the UI should follow that mental model.
- The safest first pass is creation with preview and validation; edit/delete can follow after the list view is reliable.

### Alternatives Considered

- Keep and enrich the modal: rejected because it overloads the viewer and makes future management awkward.
- Rewrite as a bundled frontend app: rejected because this repo is intentionally lightweight and currently needs no build pipeline.
- Add a separate backend framework: rejected for now because Node's existing server plus `sqlite3` CLI is enough.

### Consequences

- `index.html` becomes cleaner but may keep a small `관리자` link.
- Some helpers may initially be duplicated between `index.html` and `admin.html`; this is acceptable for the first pass, but repeated CSV/unit helper code should be extracted later if it grows.
- `server/app.js` will become more API-like. It may need light internal organization to avoid becoming a single long mixed-purpose file.
- The first admin page will be more structured than the temporary modal, but it will intentionally stop short of a full CRUD console.

## First-Pass Admin Contract

### Event Fields

The first pass captures event-level fields that are already represented in `change_event`:

- `change_year`: required.
- `title`: optional, defaults to `{change_year}학년도 편제개편`.
- `rule_revision_date`: optional date/text field for 학칙 개정일.
- `source_text`: optional multiline field for 학칙 근거 문구.
- `note`: optional internal note.

These fields are saved only when a new event is created or when the user explicitly chooses "새 개편 사건으로 저장". Editing existing event metadata is deferred.

Existing-event mode is strict in v1: when `event.eventId` is present, the server ignores no metadata silently. If `title`, `ruleRevisionDate`, `sourceText`, or event `note` are supplied with values that differ from the existing event, the request is rejected with a message telling the user to create a new event or wait for event-edit support. This keeps create-vs-edit semantics legible.

Event identity is never inferred from `change_year` in admin writes. Existing-event mode is selected only by `event.eventId`. New-event mode is selected by omitting `event.eventId`, and it always creates a new `change_event` using the submitted event metadata, even when another event already exists for the same 학년도. The admin event picker must display `event_id`, `change_year`, and `title` together so same-year events are distinguishable.

### Relation Fields

The first pass captures one relation at a time:

- `change_type`: required.
- `retain_until_grad_year`: optional integer.
- `note`: optional relation-level note.
- `prevUnitCodes`: zero or more, depending on change type.
- `afterUnitCodes`: zero or more, depending on change type.

Batch relation entry under one event is deferred, but the page layout should leave room for a later "관계 추가" queue.

### Legacy Export Contract

The first pass will support multi-endpoint admin input, but the read-only viewer remains row-based. Therefore, every saved relation must have a deterministic legacy export shape:

- `1 prev x 1 after`: export one legacy row.
- `N prev x 1 after`: export `N` rows, one per previous endpoint to the same after endpoint. This covers 통합.
- `1 prev x N after`: export `N` rows, one from the previous endpoint to each after endpoint. This covers 분리.
- `0 prev x N after`: export `N` created rows.
- `N prev x 0 after`: export `N` closed rows.
- `N prev x M after` where `N > 1` and `M > 1`: block in v1 unless the user explicitly splits it into separate relation entries. This prevents a Cartesian expansion that looks precise but may not match the academic rule.

The admin preview must show the exact row expansion count before save. For example, "3개 이전 편제가 1개 이후 편제로 통합되어 3개 화면 연결선으로 표시됩니다." This keeps the relational admin model honest while preserving the current viewer's CSV contract.

Implementation note: keep the legacy CSV route row output stable for existing rows. If the current `v_org_unit_relation_legacy` naturally produces the required expansion for `N x 1`, `1 x N`, created, and closed relations, use it; otherwise replace it with an explicit export query that orders by `relation_id`, `prev.sort_order`, `after.sort_order`.

### CSV Export Sync Contract

Normal server mode keeps the current behavior: after a successful write, SQLite is the source of truth and compatibility CSV files are regenerated.

Test mode must be explicit and environment-driven:

- `CSV_EXPORT_DIR=<path>` directs regenerated CSV files to that directory instead of the repo root.
- `DISABLE_CSV_SYNC=1` disables CSV regeneration after writes.
- Mutation verification must use one of these modes with a copied `DB_PATH`.

This prevents automated save-success checks from modifying committed CSV files while preserving production/local default behavior.

### `/api/admin/bootstrap` Response

The bootstrap endpoint should return:

- `units`: `unit_code`, `unit_name`, `unit_type`, `parent_unit_code`, computed `path`, and `is_temp_code`.
- `changeTypes`: code and Korean label.
- `events`: `event_id`, `change_year`, `title`, `rule_revision_date`, `note`, relation count, and a display label combining event id, year, and title. Exclude full `source_text` from the list response to keep payloads light.
- `eventDetails` is not part of v1. Full `source_text` can be returned later by a separate detail endpoint if event editing becomes necessary.
- `recentRelations`: latest relation summaries with prev/after endpoint display names and expansion count.
- `years`: sorted change years.

### `POST /api/relations` Payload

The save endpoint should accept:

```json
{
  "event": {
    "eventId": 1,
    "changeYear": 2027,
    "title": "2027학년도 편제개편",
    "ruleRevisionDate": "2026-03-27",
    "sourceText": "...",
    "note": "..."
  },
  "relation": {
    "changeType": "renewed",
    "retainUntilGradYear": 2029,
    "note": "...",
    "prevUnitCodes": ["HED2100"],
    "afterUnitCodes": ["TMP-DPT-0005"]
  }
}
```

For backward compatibility during transition, the endpoint may temporarily accept the existing flat payload, but `admin.html` should use the structured payload.

## Usability Plan

### Primary Workflow

The page should read as a workbench, not a modal:

1. Pick or create a change event.
2. Choose a change type.
3. Add previous and next units in two side-by-side columns.
4. Review a generated preview sentence and endpoint paths.
5. Save.
6. See the newly saved relation in a recent list.

### Unit Selection UX

- Search should match code, unit name, parent department, college, and full path.
- Each search result should show name, code, type badge, and path.
- Temporary codes should be visibly marked.
- Duplicate selections should be prevented before save.
- When the same name exists under different parents, the path must be prominent enough to disambiguate.
- Selection chips should stay visible after choosing an item so users can scan the final prev/after sets without reopening search.

### Change-Type Guidance

The form should change its affordances by type:

- `created`: collapse or soften previous-unit input.
- `closed`: collapse or soften after-unit input.
- `merged`: emphasize adding multiple previous units.
- `splitted`: emphasize adding multiple after units.
- `revised` and `renewed`: default to one previous and one after unit.

The UI should not rely only on explanatory paragraphs. It should make the expected shape clear through enabled/disabled sections, empty states, and inline validation.

### Preview And Confidence

Before save, the page should show:

- A compact natural-language preview, e.g. `소프트웨어전공에서 소프트웨어·정보보안전공으로 통합`.
- The normalized endpoint paths that will be stored.
- The exact legacy viewer expansion, including row/edge count.
- The retention sentence, if present.
- Warnings for temp codes, ambiguous names, duplicate endpoints, and missing required sides.

### Recovery

- Validation errors should appear next to the relevant section and also in a summary area.
- Save should disable the button and keep form state visible.
- Successful save should not clear everything silently; it should show the saved relation and then offer "같은 사건으로 계속 입력".
- The admin page should have a clear path back to the flow viewer.

## Implementation Plan

1. Revert the viewer-scoped editor surface.
   - Remove `openEditorBtn`, modal markup, editor CSS, and editor JS from `index.html`.
   - Add an explicit persistent `관리자` navigation link in the header that opens `/admin.html`.
   - Preserve all existing flow rendering and detail-panel behavior.

2. Add admin bootstrap APIs.
   - `GET /api/admin/bootstrap`: returns units, change types, years, and existing events/relations summary.
   - Keep CSV compatibility routes unchanged.
   - Keep `POST /api/relations`, but improve response shape for admin use.
   - Add a server option to direct CSV export sync to the active `DB_PATH` directory, or allow export sync to be disabled for mutation tests.

3. Create `admin.html`.
   - Use a work-focused layout: top header, event section, relation editor, endpoint columns, preview/validation panel, recent relation list.
   - Provide searchable unit selection with code/name/path/type.
   - Support multiple prev/after endpoints.
   - Show a generated natural-language preview before save.
   - Show server validation errors inline.
   - Make the event picker/create mode explicit so users know whether they are adding to an existing change event or creating a new one.
   - In existing-event mode, require choosing a concrete event by `event_id`; do not let the UI attach by year alone.

4. Strengthen relation validation.
   - Client-side: required counts by change type, valid unit selections, duplicate endpoint prevention, retain-year integer validation.
   - Server-side: keep the same checks as source of truth.
   - Server invariants: no duplicate unit within the same side, no same unit on both prev and after in one relation unless explicitly allowed later, all unit codes exist, all generated endpoint paths match unit type and parent chain, change type endpoint counts are valid, retain year is integer or null, existing-event metadata conflicts are rejected, existing-event attachment requires `event_id`, new-event mode never reuses by year, and `N prev x M after` where both sides are greater than 1 is rejected in v1.
   - Do not implement rollup policy yet.

5. Verify and document.
   - `node --check server/app.js`.
   - Start server, check `/`, `/admin.html`, `/api/admin/bootstrap`, CSV routes.
   - Test invalid `POST /api/relations` without mutation.
   - For save success, use a throwaway DB copy and isolated export directory, or disable CSV sync for the test server, so committed DB and CSV files stay untouched.
   - Test the legacy export contract on temp DB for `1x1`, `N x 1`, `1 x N`, created, and closed examples, and verify row counts match the expansion rule.
   - Test unsupported `N x M` with both sides greater than 1 against temp DB and expect HTTP 400 with a clear "split into separate entries" message.
   - Test existing-event metadata conflict and expect HTTP 400 rather than silent overwrite or silent ignore.
   - Test event identity branches: one valid save with omitted `eventId` must create a new event even if the year already exists, and one valid save with an existing `eventId` must attach to exactly that event.
   - Update README with admin route and write-flow note.

## Acceptance Criteria

- Main viewer works exactly as a read-only flow viewer.
- Main viewer has a persistent `관리자` link to `/admin.html`.
- `/admin.html` loads without build tooling.
- Admin page can search/select existing units and compose a relation.
- Admin page previews the relationship before save.
- Admin page makes event selection/creation, endpoint direction, and saved result easy to understand without reading documentation.
- Admin page blocks unsupported `N x M` relation saves in v1 with a clear message to split the rule into multiple entries.
- API rejects invalid payloads with useful JSON errors.
- API rejects existing-event metadata conflicts with useful JSON errors.
- API rejects unsupported `N x M` relation saves in v1 with a split-guidance message.
- API never binds writes to an event by year alone.
- API can save a valid relation into a copied SQLite DB during verification.
- CSV compatibility routes still return expected row counts from the normal DB.
- CSV compatibility routes produce deterministic row expansion for supported multi-endpoint relations.
- Successful mutation verification leaves the real workspace DB and CSV files unchanged.

## Risks

- `server/app.js` may become too large if API logic keeps growing.
- Duplicated frontend helpers can drift between `index.html` and `admin.html`.
- Successful save tests against the real DB would modify committed data accidentally.
- Using `sqlite3` CLI instead of a Node SQLite library limits transaction ergonomics.
- A richer admin page can become visually busy if every schema field is exposed at once.
- Search by name alone can produce ambiguous selections when names repeat across colleges or departments.

## Mitigations

- Keep admin APIs small and named by workflow.
- Extract shared frontend helpers only after duplication is concrete.
- Use `DB_PATH` with a temporary copied DB and isolate or disable CSV export sync for mutation tests.
- Add tests/scripts later if admin writes become frequent.
- Keep advanced event editing and batch queues deferred until the first create workflow is proven.
- Show full paths and codes in unit search results to avoid name collisions.

## Verification Path

- Static syntax: `node --check server/app.js`.
- Server smoke: request `/`, `/admin.html`, `/dim_org_unit.csv`, `/org_unit_relation.csv`.
- API smoke: request `/api/admin/bootstrap`.
- API validation: post `{}` to `/api/relations` and expect a 400 JSON error.
- Mutation verification: copy `department_history.sqlite` to temp, run server with `DB_PATH=<temp>` plus isolated/disabled CSV export sync, post a valid relation, then confirm relation count increases only in temp DB and the real repo CSV files do not change.

## Available Agent Types

- `architect`: review architecture, boundaries, and API/UI split.
- `critic`: enforce consistency, acceptance criteria, and risk mitigation.
- `executor`: implement the approved plan.
- `test-engineer`: design or run mutation-safe verification.
- `verifier`: validate final evidence before commit.

## Recommended Execution Lane

Use `$ultragoal` as the default durable execution lane after consensus approval. A small `$team` split is possible:

- Executor lane: `admin.html` and `index.html` cleanup.
- Backend lane: `server/app.js` admin APIs and mutation-safe behavior.
- Verifier lane: smoke/API verification on a temp DB.

`$ralph` is available only as a single-owner fallback if the user explicitly wants one persistent implementation loop.
