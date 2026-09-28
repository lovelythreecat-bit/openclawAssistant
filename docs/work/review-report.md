# Kuro independent review

Reviewed 2026-09-16. Read-only production review; no live chat sends, gateway writes, or production edits. Parent is independently performing Electron smoke, packaging, and CSP work.

## Verdict

No Critical findings. Three Important findings should be fixed before calling the settings/connection workflow complete. The application otherwise closely follows the first-version spec: a restricted desktop bridge, independent device identity, encrypted credentials, local-only endpoints, explicit user-triggered chat sends, snapshot streaming, and per-session run isolation. Parent confirmed automatic local discovery/connect is an intentional authorized UX decision and will update the spec accordingly; automatic connection itself is not reported as a defect.

## Important findings

### R1 — An explicitly saved credential-free endpoint is overwritten on restart

- Location: `electron/main.ts:142` and `electron/store.ts:49`.
- Startup treats `credentialSource === 'none'` as “the user has never configured this app.” But `SettingsStore.save()` deliberately sets that value after an endpoint/distro change when no new secret is supplied.
- Reproduction: save a supported loopback endpoint using a different port and no token, connect to a gateway using `gateway.auth.mode: none`, then restart. Startup imports the WSL config again and overwrites the saved URL; if WSL import fails, the app does not even attempt the saved endpoint.
- Fix: persist a separate initial-setup/discovery flag, or another explicit distinction between an untouched installation and a user-saved connection. Automatic discovery should run only for the untouched installation. Add a persistence/restart regression test.
- Related startup consistency: `src/useWorkspace.ts:93` reads public settings only once, while the initial import happens asynchronously after the window is created (`electron/main.ts:143`). The UI can retain `credentialSource: none` / `hasCredential: false` after successful import and connection. Publish settings updates or refresh settings after startup connection transitions so the gateway/settings pages display the actual saved configuration.

### R2 — Manual password authentication is unreachable from Settings

- Location: `src/App.tsx:114` and `src/App.tsx:116` (input markup on line 117).
- The IPC, store, transport, and approved spec support password authentication, but the only credential field creates `{ token }`. There is no password field or authentication-type selector.
- Reproduction: use a gateway with password authentication whose config cannot be imported (the importer explicitly supports this recovery path for extended JSON and unresolved secret references). Typing the known password into the sole field sends it as a token, so authentication remains impossible through the UI.
- Fix: expose token/password selection or an optional password field; submit the selected credential under the matching property, preserve password whitespace semantics, and clear plaintext fields after successful saving. Verify the bridge receives `password`, without a stale `token`, for the password path.

### R3 — Switching gateway endpoints reuses the previous gateway's chat cache

- Location: `src/useWorkspace.ts:159` and `src/useWorkspace.ts:166`; reuse occurs at `src/useWorkspace.ts:97–99`.
- Saving/importing a different endpoint changes settings but leaves `states`, `sessions`, `localSessions`, and the selected session intact. The disconnect handler only cleans active requests/runs. A session already marked `loaded` is never fetched on subsequent selection.
- Reproduction: load `agent:main:main` from gateway A, save a different local gateway B, connect, and select B's `agent:main:main`. The UI displays A's messages under B's connection and will send the next user message to B. Old local sessions also remain in B's list. This is a real supported settings path and conflicts with the spec's authoritative gateway history requirement.
- Fix: scope cached conversations and pending async work to a connection configuration identity, or clear the chat/list/selection state when the configured endpoint changes. Invalidate outstanding list/history results before clearing. Add a deferred-response regression covering identical session keys across two endpoints.

## Transport, IPC, and secret persistence assessment

- Request correlation, connection generation checks, independent challenge signatures, timeout cleanup, exact delta replacement, and late-ack run handling are clear and appropriately separated.
- The installed OpenClaw declaration at `/home/root1/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/src/gateway/protocol/schema/logs-chat.d.ts` was read directly during this review. `chat.history`, `chat.send`, `chat.abort`, and chat event fields match the application contract, including `deliver`, `idempotencyKey`, integer `seq`, and the four terminal/stream states. Signature fields also match the recorded installed-protocol brief. This was source inspection, not a new live authentication/send validation.
- Main-process IPC verifies both the owning webContents and exact entry URL, validates side-effect arguments, and exposes named operations only. Context isolation, sandbox, navigation denial, external-link scheme restrictions, and remote-image suppression support the intended boundary.
- The encrypted blob contains the identity and authentication data; public settings return only presence/source. No production secret logging was found. Credentials are dropped on endpoint changes. Store writes use a temporary encrypted file and rename.
- Existing tests cover reducers and transport well, but settings restart semantics and React state changes across configuration replacement are uncovered. Parent's fresh integration verification remains required; this review did not rerun builds or modify application files.

## Quality assessment

The implementation is understandable and appropriately small for a local first release. The main remaining correctness risk is lifecycle state shared across configuration changes, rather than the request/stream reducer itself. Fix the three findings, synchronize public settings after automatic import, then perform focused settings and endpoint-switch integration checks. The known CSP addition belongs to the parent's existing work and is not duplicated here.
