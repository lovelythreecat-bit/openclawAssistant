# Gateway and device identity report

## Delivered

- `electron/identity.ts` creates an Ed25519 keypair, derives the device ID as SHA-256 of the 32-byte raw public key, exports PEM material for the owner-managed store, and signs the exact protocol-v3 challenge payload.
- `electron/gateway.ts` implements a manual-lifecycle `GatewayClient` with challenge authentication, request correlation, per-request timeouts, generation isolation, status/event/device-token emissions, secret redaction, pairing guidance, negotiated payload/backpressure limits, and inbound-silence detection.
- `tests/gateway.test.ts` uses a real loopback `WebSocketServer`; it never opens a connection to the installed gateway.

## Red/green evidence

Initial red run, before the production files existed:

```text
npx tsx --test tests/gateway.test.ts
ERR_MODULE_NOT_FOUND: Cannot find module electron/gateway.js
tests 1, pass 0, fail 1
```

The implemented gateway suite then reached green with 10/10 tests. A subsequent stored-device-token fallback test received an explicit mutation check: temporarily removing `options.deviceToken` from token selection made the test fail because `auth` was `undefined`; restoring the required fallback made the focused test pass 1/1.

The first root-owned live integration returned `[INVALID_REQUEST] origin not allowed`. Inspection of the installed server showed that `webchat-ui`/`webchat` classifies the native Node connection as a browser webchat client and therefore requires an Origin header. The legitimate native identity is `gateway-client` with mode `ui`. Literal handshake and independently constructed signature tests were changed first and failed 4/4 against the old production values; changing the connect frame and signed payload to the native values made the focused tests pass 4/4. Authentication, device identity, role, and scopes remain unchanged. The client does not forge an Origin header or use the backend-trust mode.

Final verification is recorded from fresh commands:

```text
npm test
28 tests, 28 pass, 0 fail

npx tsc --noEmit -p tsconfig.electron.json
exit 0

npm run build
TypeScript checks and Vite production build completed successfully
```

Gateway coverage includes independently verifying the Ed25519 signature against a hand-built payload; exact connect fields and credential priority; public-status secret exclusion; issued device-token emission; password and stored-token paths; out-of-order RPC responses; useful normal and pairing errors; disconnect cleanup; reconnect generation isolation; challenge, handshake, and RPC timeouts; silence detection; outgoing policy enforcement; exact `chat.send` params; and unmodified streamed snapshots.

## Code quality review

- Identity/key encoding is isolated from transport behavior and uses Node's native crypto primitives. The raw-key SPKI prefix is validated rather than assuming every PEM contains an Ed25519 key.
- Every socket callback is bound to both a socket instance and generation. Reconnect/disconnect removes old listeners, rejects old work, and clears request and lifecycle timers.
- RPC retries are absent, so side-effecting calls such as `chat.send` are never replayed automatically.
- Secrets are used only to build the authentication frame and signature. No logging exists, status objects contain only public connection data, and gateway-provided error/close text is scrubbed against all known credentials.
- Incoming frames have a 25 MiB WebSocket hard cap and are checked against the smaller negotiated limit after authentication. Outgoing frames check both negotiated payload size and current `bufferedAmount` plus the new frame size before sending.
- The public contract comes only from `src/types.ts`; no shared-contract, package, UI, main-process, or store files were changed by this task.

## Integration notes and remaining concerns

- Device identity, newly emitted device tokens, and endpoint validation remain at the root-owned boundary as assigned. The separate encrypted-store suite verifies their persistence behavior.
- This worker made no live gateway call. The root integration pass identified the native-client classification issue described above and will rerun the live connection after this fix.
- Reconnect remains manual for v1. This prevents accidental replay of side-effecting RPCs.
- Payload-size enforcement is tested deterministically. Actual kernel-level backpressure saturation is not forced in the test suite; the production check uses `ws.bufferedAmount` and the negotiated `maxBufferedBytes` before every send.
