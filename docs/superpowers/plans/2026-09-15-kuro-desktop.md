# Kuro Desktop Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in the existing fresh project directory. The user has authorized continuation; routine implementation does not need another approval round.

**Goal:** Deliver a runnable cute Windows desktop client for the user's WSL OpenClaw gateway.

**Architecture:** Electron owns the WebSocket connection and encrypted credentials. A restricted preload connects the React UI to named operations; the gateway remains the source of conversation history.

**Tech Stack:** Electron 44, React 19, TypeScript 5, Vite 6 (compatible with installed Node 22.14), ws, react-markdown, remark-gfm, lucide-react, tsx and Playwright.

**Spec:** ../specs/2026-09-15-kuro-desktop-design.md

## Global Constraints

- Windows client, Ubuntu-24.04 WSL gateway, default ws://127.0.0.1:18789.
- Character name: 库洛. Warm cream and cherry blossom palette; deep readable text.
- Local loopback endpoints only; credentials never enter renderer state, logs, or source control.
- Device identity with protocol 3 authentication and read/write scopes; do not weaken gateway auth.
- Do not automatically send messages to the live gateway or restart it.
- Current directory is a fresh, standalone project without a Git repository; implementation occurs here without a nested worktree.

## Files and interfaces

- `electron/gateway.ts`: `GatewayClient.connect(options)`, `request(method, params)`, `disconnect()`, `on('status'|'event')`; nonce authentication, lifecycle and request correlation.
- `electron/identity.ts`: `createIdentity()` and `signDevice(identity, nonce, token, signedAt)`; persistent key serialization owned by store.
- `electron/store.ts`: encrypted local config and keypair storage; `getPublicSettings()` omits secrets.
- `electron/wsl.ts`: read-only config import using fixed Python program and execFile argument arrays.
- `electron/main.ts`, `electron/preload.cjs`: native window and explicit IPC methods.
- `src/types.ts`: shared public connection, session, message and bridge contracts.
- `src/App.tsx`, `src/useWorkspace.ts`, `src/components/*`, `src/styles.css`: navigation, per-session state, history, connection form, Markdown and character artwork.
- `tests/gateway.test.ts`: real WebSocket fixture server with scripted protocol responses, independent of live gateway.
- `tests/electron-smoke.mjs`: launch actual Electron, inspect renderer and IPC, take screenshots and check errors.
- `scripts/start.mjs`, `README.md`: Windows-friendly launch and usage.

## Task 1: authenticated transport

- [x] Add minimal package configuration and install dependencies.
- [x] Write failing behavior tests before transport implementation: verify challenge-bound signature using crypto.verify; ensure error responses reject; pending requests reject on disconnect; late responses from previous connections cannot affect a newer one.
- [x] Run `npm test` and confirm intended failures.
- [x] Implement identity and GatewayClient following installed schema: `connect` uses protocol 3, client id `webchat-ui`, mode `webchat`, platform `win32`, displayName `库洛桌面`; sign `v3|deviceId|clientId|mode|operator|operator.read,operator.write|signedAt|token|nonce|win32|`.
- [x] Request examples: `request('sessions.list', {limit:100,includeDerivedTitles:true,includeLastMessage:true})`; `request('chat.history',{sessionKey,limit:200})`; `request('chat.send',{sessionKey,message,idempotencyKey,deliver:false})`; `request('chat.abort',{sessionKey,runId})`.
- [x] Run tests until green; no automatic chat retries.

## Task 2: desktop boundary and settings

- [x] Add Electron window with `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`; load only local built output and preload.
- [x] Expose named settings/connect/list/history/send/abort methods; return result envelopes `{ok:true,value}` or `{ok:false,error}`. Validate input in main process; do not expose arbitrary RPC or shell operations.
- [x] Persist secrets and private device key using safeStorage; default public settings have no token. Read only gateway auth fields through WSL Python JSON output captured privately in main process.
- [x] Use a live read-only smoke command to verify connect, sessions.list and chat.history without printing content or credentials.

## Task 3: Kuro workspace UI

- [x] Build responsive navigation and session list with honest empty/loading/error states; import supplied PNG as welcome artwork.
- [x] Implement composer, Markdown, streaming snapshot replacement, abort, and stale-response guards. Sending requires connection and nonempty draft; Enter sends unless Shift or IME composition is active.
- [x] Implement gateway/settings screens with local import, credential status, editable loopback endpoint and reconnect.
- [x] Keep operational controls plainly named; hide illustration in dense chat view. Respect prefers-reduced-motion.

## Task 4: verify and hand off

- [x] Run `npm test` and `npm run build`.
- [x] Run Electron smoke test, verify no renderer errors, inspect welcome/settings/chat screenshots at default and minimum sizes.
- [x] Review connection lifecycle, IPC validation, secret persistence, cross-session streaming and stale asynchronous state; fix identified defects and rerun relevant checks.
- [x] Write README with install/start instructions, WSL authentication/pairing guidance, known limits, and next milestone (packaging/tray).
- [x] Report exact verified behavior and any unverified live model calls. Leave source and runnable build in the workspace.
