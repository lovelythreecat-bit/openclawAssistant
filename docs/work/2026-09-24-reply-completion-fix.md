# 回复完成后仍显示“正在写下回复”修复

## 原因

用户确认回复已经完整显示，但运行提示不消失。

只读核对本机 OpenClaw 的 `/home/root1/.npm-global/lib/node_modules/openclaw/dist/server-chat-DTU9AsbF.js`，`emitChatFinal()` 在第 393 行附近先调用 `flushBufferedChatDeltaIfNeeded(..., seq)`，随后使用相同的 `seq` 广播 `final` 或 `error`。这是合法的“最后一段文字 + 结束状态”组合。

原 `src/workspace.ts` 使用 `event.seq <= run.seq` 统一去重，因此最后一段文字已经显示，随后结束事件却被丢弃，`run` 与 `stream` 一直保留。

## 修改

仍丢弃比当前序号更旧的事件，并对相同序号的 `delta` 去重；允许同序号的结束事件完成当前运行。保留会话、运行 ID 和重复终态检查，不使用固定超时或猜测文本完整性来结束回复。

## 验证

- 新增 4 项状态机回归：同序号 final/error/aborted，以及发送确认前缓存的 delta + final；同时覆盖重复文本、较旧结束事件和重复结束事件。
- 新增 1 项界面回归：完整文字显示后收到同序号 final，聊天提示消失、角色恢复待机文字、停止按钮撤下，并可发送下一条消息。
- 上述五项修改前失败，修改后通过。
- `npm test`：51 项通过，0 失败。
- `npm run build`：TypeScript、Vite 构建通过。
- `node tests/electron-smoke.mjs`：模拟网关按真实行为发送同序号 delta + final，通过真实 Electron、IPC、WebSocket 流程。
- 独立只读复核未发现需要修改的问题。
- `npm run package`：目录版与便携版打包成功。
- `node tests/artifact-check.cjs`：包内入口与最终构建一致。
- `node tests/electron-smoke.mjs --packaged`：正常桌面权限下，最终目录版同序号结束事件及后续消息发送回归通过。初次受限环境启动遇到 GPU 子进程错误，正常桌面权限复测通过。
- `node tests/portable-smoke.mjs`：最终便携版启动、桥接、图片和 Live2D 模型检查通过。验收时将测试进程的 TEMP/TMP 指向项目 `.test-data/portable-temp`；未改系统设置。

## 产物与环境说明

启动入口仍为 `Start-Kuro.cmd`，优先打开已经验证的 `release/win-unpacked/Kuro.exe`。

便携版 `release/Kuro-0.1.0-Windows-x64.exe`：110,520,607 字节。

SHA-256：`E8BE8F75A68BC175ABE2FB287E33D84D7141EC75CABC389630BC1926BB46A656`，对应 `.sha256` 已更新。

默认临时目录中的便携启动曾失败；检查时 C 盘仅剩约 94 MB，无法满足自解压所需空间。改用 F 盘临时目录后同一 EXE 通过验收。日常可直接使用目录版入口，C 盘空间不足时不建议直接双击便携 EXE。

本轮未发送真实模型聊天，也未停止用户已有任务。
