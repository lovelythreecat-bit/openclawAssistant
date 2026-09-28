<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="Kuro: a Windows desktop companion for local OpenClaw, with chat, model and capability management, and a Live2D companion.">
</p>

<p align="center"><a href="README.md">简体中文</a> · <strong>English</strong></p>

# Kuro · OpenClaw Desktop

A Windows desktop workspace for your local OpenClaw: continue conversations, read streaming responses, switch models, and browse Skills and plugins. A warm ivory and pink interface comes with an optional, collapsible Live2D companion.

**For users who already run OpenClaw and want a Windows desktop interface.** Install OpenClaw and start its gateway before connecting Kuro.

[Quick start](#quick-start) · [Features](#features) · [Connection and authentication](#connection-and-authentication) · [Development](#development) · [Troubleshooting](#troubleshooting)

![Kuro welcome screen with a conversation sidebar, suggestion cards and message composer](docs/screenshots/kuro-welcome.png)

<details>
<summary>More screenshots: chat and the Live2D companion</summary>

**Chat and code blocks**

![Kuro displaying a user message and an assistant response with a code block](docs/screenshots/kuro-chat-demo.png)

**Collapsible Live2D companion**

![Shizuku in the companion panel beside the Kuro conversation area](docs/work/ui-live2d.png)

</details>

*Existing repository screenshots. The chat example uses a local mock gateway, not a real model response. Current source also includes Skills, model and plugin pages; the running version may look different. The Kuro welcome illustration and the Shizuku Live2D character are separate assets. The application UI shown here is in Chinese.*

## Features

| Task | What Kuro offers |
| --- | --- |
| Continue a conversation | Create, search and switch sessions with separate drafts and run states. |
| Read responses | Streaming text, Markdown, tables, code blocks and tool activity reported by the gateway. |
| Choose models | Select a model per conversation; configure the default model, provider endpoints and model lists. |
| Discover capabilities | Browse and filter Skills by availability; inspect sources and missing dependencies. |
| Manage plugins | Inspect and import plugins in the current WSL environment; restart the gateway when needed. |
| Connect with less setup | Import gateway settings from WSL or enter connection details manually. |
| Keep a companion nearby | Shizuku idle motion, blinking, breathing, gaze tracking and a greeting interaction. |

Skills, models and plugins require a gateway connection. Model configuration writes depend on gateway permissions; plugin management also requires a matching WSL service environment. Bundled character assets work offline. Model network requirements depend on your OpenClaw configuration.

## Quick start

### 1. Prepare a local gateway

Start your OpenClaw gateway and make sure Windows can reach its local port. The default address is `ws://127.0.0.1:18789/`; automatic import defaults to the `Ubuntu-24.04` WSL distribution.

**Only loopback addresses are supported**: `localhost`, `127.0.0.1` and `[::1]`. Direct connections to remote server addresses are not supported.

### 2. Start Kuro

**From source** — Windows x64, Node.js 22+ and npm:

```powershell
npm install
npm start
```

`npm start` checks TypeScript, builds the application and opens an Electron window. The initial install downloads Electron and other dependencies. Opening a Vite page in a browser does not provide the desktop bridge.

**With locally built artifacts**, open `release/Kuro-0.1.0-Windows-x64.exe` for the portable version, or double-click `Start-Kuro.cmd`. The launcher prefers the unpacked build, then the portable EXE, then falls back to `npm start` (dependencies must already be installed). See [Development](#development) to build these artifacts.

### 3. Connect and chat

1. On first launch, if no connection has been explicitly saved, Kuro attempts to import from the default WSL distribution and connect. WSL import requires Python 3 inside that distribution.
2. If import fails, open **设置 (Settings)**, enter the correct distribution name and select **从 WSL 导入 (Import from WSL)**. You can also enter the address and authentication manually. After saving, use **连接网关 (Connect gateway)** on the **网关 (Gateway)** page.
3. Once connected, select **开启新对话 (New conversation)** or continue a session from the sidebar.

To find your distribution name, run in PowerShell:

```powershell
wsl --list --quiet
```

## Connection and authentication

<p align="center">
  <img src="assets/readme/connection.svg" width="100%" alt="Typical WSL deployment: Kuro on Windows connects over a local WebSocket to an OpenClaw gateway in WSL, which calls the configured model service.">
</p>

Kuro handles the desktop interface; OpenClaw handles sessions, tools and model calls. The diagram shows a typical WSL setup: **desktop client → local gateway → configured model service**. A local gateway connection does not imply local model inference.

- **Automatic import** reads WSL OpenClaw settings, normally `~/.openclaw/openclaw.json`, and also considers `OPENCLAW_CONFIG_PATH` and authentication in the gateway service environment.
- **Authentication** supports token, password and unauthenticated configurations through WSL import. Manual entry offers Token or Password; leading and trailing password spaces are preserved.
- **Storage** keeps connection settings and device identity in `connection.sealed` under Electron's `userData` directory, encrypted through Windows-backed `safeStorage`. Saved secrets are not displayed. Kuro does not persist a local chat-message cache.

<details>
<summary>Saved credentials, connection changes and portable settings</summary>

- After an explicit save or import, subsequent launches use that configuration, including unauthenticated gateways.
- Leaving credentials blank preserves existing authentication when the address and distribution are unchanged. Changing either clears the old authentication; import or enter it again.
- Saving or importing disconnects the gateway and clears session views and unsent drafts. Reconnecting loads records from the selected gateway.
- Credential inputs clear after a successful save. Use the original Windows account to read encrypted settings.
- “Portable” means no application installation is required. Settings remain in the current user's application data directory and do not travel with the EXE.

</details>

## Everyday use and limits

- **Compose:** `Enter` sends; `Shift + Enter` inserts a newline. Enter during IME composition does not send. Welcome suggestions fill a draft for you to review and send.
- **History:** up to 100 sessions and the latest 200 messages per session. Refresh lists or history and switch sessions during generation.
- **Content:** Markdown, lists, tables and code blocks. HTTP/HTTPS links open in the system browser. Historical images appear as text placeholders; attachment uploads are not supported.
- **Stop and reconnect:** stopping requires gateway confirmation. If delivery is uncertain or the connection drops, reconnect and refresh history before retrying.
- **Companion:** click the character or greeting button to interact. The collapsed state is remembered; collapsing or leaving chat releases rendering resources. Chat remains available if graphics fail. Reduced-motion settings produce a static presentation.
- **Current scope:** no voice or dedicated emotion expressions. Default Windows builds are unsigned and do not include automatic updates.

## Development

Built with **Electron · React · TypeScript · Vite** and **PixiJS · pixi-live2d-display** for the companion.

```powershell
# Type-check and build the frontend and Electron main process
npm run build

# Build the unpacked Windows application
npm run package:dir

# Build the Windows x64 portable executable
npm run package
```

Outputs: `release/win-unpacked/Kuro.exe` and `release/Kuro-<version>-Windows-x64.exe`; the version comes from `package.json`. Distribute the entire `win-unpacked` directory for an unpacked build. Packaging may download Windows build tools; commands disable publishing and exclude WSL settings and user credentials.

Validation commands:

```powershell
npm test
npm run test:desktop
npm run test:live2d
```

Run `npm run build` before desktop and Live2D checks. Automated tests and mock gateways do not replace integration with real models. Historical scope is documented in the [verification notes](docs/verification-notes.md) and [Live2D report](docs/work/2026-09-24-live2d.md) (Chinese); test counts and artifact hashes apply to their recorded dates.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| WSL configuration not found | Distribution name, Python 3 and configuration path; then import again. |
| Gateway connection fails | Running gateway, correct port and Windows access to the loopback address. |
| Extended JSON import is unsupported | The importer uses standard JSON. Enter the address and Token / Password manually. |
| Device pairing is required | Complete OpenClaw's device approval flow, then reconnect. |
| Model settings cannot be saved | Check gateway permissions, pairing and error details; wait for active generation to finish. |
| Plugin environment mismatch | The selected WSL distribution's `openclaw-gateway.service` user service must match the connected port. |
| Encrypted settings cannot be read | Use the original Windows account in a normal desktop session. |
| Response interrupted | Reconnect and refresh history before continuing. |

## License and assets

`package.json` currently declares `UNLICENSED`; the repository does not provide an open-source project license. The Live2D Shizuku sample model, Cubism runtime and third-party dependencies have separate terms. Review the [asset and dependency notices](public/live2d/NOTICE.txt) before redistribution or commercial use.
