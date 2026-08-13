# Ralplan: Admin Editor Next Phase

## RALPLAN-DR Summary

### Principles

- Treat the current admin page as a real operator tool, not a temporary form.
- Preserve the existing search, year-filter, and auth decisions unless a stronger UX reason appears.
- Add edit capability before adding more creation complexity.
- Keep new-unit creation inside the `변경 후` flow, not as a separate setup screen.
- Prefer API/UI expansion over schema expansion unless the data model truly cannot support the requirement.

### Decision Drivers

- The current page is now stable enough for data entry, so the biggest missing value is editability.
- Without relation reload and patch APIs, the admin page still behaves like a write-only surface.
- New-unit creation is important, but it becomes safer after edit mode and relation detail loading exist.

### Viable Options

Option A: Build new-unit creation first.
Pros: unlocks an obvious missing workflow quickly.
Cons: risks doubling complexity before edit mode exists; harder to debug mixed existing/new state.
Verdict: defer until edit plumbing exists.

Option B: Build relation edit mode first, then layer new-unit creation into the same state model.
Pros: gives the page a real operator loop; reduces future duplication; creates a clean place for “draft new after units”.
Cons: requires both client state work and server PATCH/detail endpoints.
Verdict: chosen.

Option C: Add delete together with edit mode.
Pros: fuller CRUD feeling.
Cons: raises risk and verification burden with little immediate UX payoff.
Verdict: defer.

## ADR

### Decision

Use the next milestone to turn `admin.html` into a real edit-capable surface first:

1. add recent-entry edit entry points,
2. add relation detail load + patch API,
3. move the page to `create/edit` state,
4. only then add inline `변경 후` 신규 코드 생성.

### Drivers

- The user’s current friction is no longer basic entry; it is missing operator continuity.
- The current UI shape already supports a future edit banner/status bar with small extensions.
- New-unit creation will be easier to reason about if the page already has a durable editable state model.

### Alternatives Considered

- Creation-first expansion: rejected because it increases state complexity before edit mode exists.
- Full CRUD in one pass: rejected because delete is higher risk and lower immediate value.
- Schema-first redesign: rejected because the current SQLite model can already support relation editing and after-unit insertion.

### Consequences

- The next implementation pass should concentrate on relation lifecycle, not broad feature spread.
- Frontend state will grow, but in a way that directly supports later after-new-unit drafts.
- Verification must cover create mode regression and edit mode correctness side by side.
- Edit mode must not silently lose loaded endpoints when `changeYear` changes.
- New path-parameter relation APIs must stay inside the same admin-auth boundary as existing admin routes.
- The active relation draft must be the single source of truth; filtered bootstrap lists are search aids only.

## Architect Review

Verdict: APPROVE WITH TENSIONS

Strongest antithesis:
Building edit mode first may delay an immediately visible feature the user already asked about: 신규 코드 입력. If staff cannot register a new `변경 후` unit, some real workflows still stall. Also, a naive create/edit merge can become unsafe if loaded endpoints disappear when the operator changes `changeYear`.

Tradeoff tension:
Edit mode improves the system architecture and long-term maintainability, while new-unit creation improves short-term task coverage. The chosen order optimizes for a cleaner state model rather than immediate breadth.

Synthesis:
Keep the edit milestone intentionally narrow. Do not over-design a generic form engine. Add only the state, API, and UI hooks necessary to reload one saved relation, edit it, and save it back. Model the active relation as one canonical draft object, use bootstrap only for year-filtered search candidates, and keep `PATCH /api/relations/:id` as an atomic endpoint-replacement operation protected by the same admin-auth boundary as existing admin routes. Once that loop is proven, extend the same `selectedAfterExisting + draftAfterNewUnits` model.

## Critic Review

Verdict: APPROVE

Why approved:

- The plan has a clear outcome and a bounded first milestone.
- Alternatives were considered fairly and one was explicitly deferred rather than hand-waved away.
- Acceptance and verification can be written concretely.
- The execution order reduces risk by establishing edit-state correctness before adding mixed existing/new unit state.
- The remaining sequencing tension is explicit and intentionally bounded: `변경 후 신규 코드 생성` stays out of the immediate milestone until relation reload, canonical draft state, and PATCH behavior are proven.

Required verification emphasis:

- Prove that switching into edit mode round-trips an existing relation without silent mutation.
- Confirm `changeYear` changes during edit mode do not silently drop loaded endpoints.
- Verify PATCH is atomic so relation fields and endpoint rows commit or roll back together.
- Re-run create mode regression after edit-state introduction.
- Confirm unauthenticated `GET /api/relations/:id` and `PATCH /api/relations/:id` are blocked.
- Keep delete and inline new-unit creation out of the immediate edit milestone.

## Execution Plan

### Phase 1: Edit Entry UX

- Add `수정` action to recent-entry cards.
- Introduce `mode: create | edit` and `editingRelationId`.
- Show a visible edit-state indicator and swap actions to `수정 저장` / `수정 취소`.
- Separate the editable relation draft from year-filtered selectable candidate lists.

### Phase 2: Relation Detail / Patch API

- Add `GET /api/relations/:id`.
- Add `PATCH /api/relations/:id`.
- Implement endpoint replacement strategy on patch.
- Reuse existing validation rules from create flow.
- Extend the admin auth guard so path-parameter relation routes are protected too.
- Make PATCH atomic so relation fields and endpoint rows succeed or fail together.

### Phase 3: Form Rehydration

- Load a chosen relation into the current form state.
- Rehydrate `changeYear`, `changeType`, `retainUntilGradYear`, `selectedPrev`, and `selectedAfter`.
- Use bootstrap year filtering only for search candidates and ensure the edited relation remains loaded without silently pruning endpoints.

### Phase 4: Post-Edit Stabilization

- Refresh recent-entry summaries after patch.
- Confirm create mode reset behavior is clean.
- Only after this phase begins cleanly, open the next ticket for `변경 후 신규 코드 생성`.

## Acceptance Criteria

- Recent-entry cards expose a clear `수정` entry point.
- Selecting `수정` loads one saved relation into the form without manual re-entry.
- Edit mode visually differs from create mode.
- Saving in edit mode updates the same relation instead of creating a duplicate.
- Create mode still works after edit features are introduced.
- Existing auth, year filtering, and recent-entry summary UI remain intact.
- Changing `changeYear` during edit mode never drops loaded endpoints without an explicit user action.
- `GET /api/relations/:id` and `PATCH /api/relations/:id` are not accessible without admin authentication.
- Edit mode can load a relation whose endpoints are outside the current filtered candidate list and still preserve those endpoints.

## Verification Path

- Static syntax: `node --check server/app.js`.
- Extracted script syntax check for `admin.html`.
- API smoke on a temp DB:
  - `GET /api/admin/bootstrap`
  - `GET /api/relations/:id`
  - `PATCH /api/relations/:id`
- UI smoke:
  - enter edit mode from recent entries
  - cancel edit mode
  - save edited relation
  - change `changeYear` during edit mode and confirm selections are preserved or explicitly handled
  - create a new relation afterward
- Failure-path smoke:
  - provoke PATCH failure and confirm relation + endpoints stay unchanged together
  - verify unauthenticated `GET/PATCH /api/relations/:id` returns auth failure

## Available Agent Types

- `architect`: boundary and state-shape review
- `critic`: acceptance/verification pressure
- `executor`: UI/API implementation
- `test-engineer`: temp-DB verification path
- `verifier`: final regression check before commit

## Recommended Execution Lane

Default: `$ultragoal`

Suggested team split if parallelized later:

- Executor lane: `admin.html` edit-mode UI/state
- Backend lane: `server/app.js` relation detail + patch endpoints
- Verification lane: temp DB create/edit regression checks

`$ralph` remains an optional single-owner fallback, but this work is well-shaped for a normal sequential goal or a small team split.
