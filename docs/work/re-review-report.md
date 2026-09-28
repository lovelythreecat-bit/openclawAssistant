# Kuro scoped re-review

Reviewed 2026-09-16. Scope: R1–R3 from `review-report.md`, their regression tests, the minimum-window CSS fix, and internal consistency of the native gateway client identity. Production code was not edited. `fix-report.md` was inspected before this verdict.

## Verdict

**R1, R2, and R3 are addressed. No remaining Critical or Important finding in this scoped re-review.**

| Finding | Result | Review evidence |
| --- | --- | --- |
| R1: saved credential-free endpoint overwritten on restart | Addressed | `SettingsStore` persists `configured`, sets it on explicit save/import, exposes `needsInitialDiscovery()`, and startup uses that decision. Public settings refresh on status transitions with request-order protection. |
| R2: manual password authentication unavailable | Addressed | Settings exposes Token/Password selection, clears the field on type changes, submits only the selected property, preserves password whitespace, and clears input after a successful save. |
| R3: old gateway chat cache reused after endpoint change | Addressed | Save/import resets messages, drafts, remote/local lists, and selection. A workspace generation invalidates old list/history/send/abort results. Endpoint/status reconciliation avoids a second reset that would erase a new endpoint's fresh draft. |

The broader reset on every successful save/import is now explicitly stated in the settings UI and README. This makes the loss of unsent drafts an explained part of the settings workflow. Server history remains authoritative and is loaded again after reconnection.

## Regression review and verification

- Inspected all six browser tests in `tests/settings-ui.test.ts`. They exercise real React UI behavior through a test bridge: manual password submission, public settings refresh, identical keys across two gateways with delayed old list/history results, minimum viewport controls, import with late send acknowledgment, and preserving a fresh draft on first connection to a newly saved endpoint.
- The CSS uses `min-height: 0` and contained overflow on grid/flex children so scroll areas can shrink. The reported 944×641 content-area check covers the minimum Electron outer window's composer, send button, and rail footer.
- Inspected the new persistence tests for explicit credential-free save/restart and migration from older sealed settings. The current flag preserves even an explicitly saved default endpoint; the migration heuristic applies only to earlier files that had no flag.
- Fresh reviewer command: `node --import tsx --test --test-name-pattern='initial|discovery|legacy|configured|proof|handshake' tests/store.test.ts tests/gateway.test.ts` — **6 tests passed, 0 failed**. This included persistence/discovery cases, independent signature verification, and the exact handshake test.
- The fix agent's recorded broader verification is `npm test` **36/36 passed** and `npm run build` passed. Those full commands were not redundantly rerun by this reviewer. Parent separately owns final packaged Electron validation.

## Native protocol correction

`electron/gateway.ts` now sends `client.id = gateway-client` and `client.mode = ui`. `electron/identity.ts` signs those same values in the v3 device payload. The independent crypto verification and handshake tests agree and passed in this review. The operator role and requested read/write scopes remain consistent; no backend mode or synthetic Origin was introduced.

Parent separately reports a successful real read-only connection with 3 sessions and 34 history messages. This review performed no live chat sends or gateway configuration writes. Production CSP remains enabled; the browser regression test's CSP bypass is confined to its Vite test context.

## Limits

This is a scoped verification of the reported fixes, not a second broad audit or a claim that real model send/abort was tested. There are no requested fix items left open from the original review.
