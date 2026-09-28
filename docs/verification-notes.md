# 库洛验收记录

## 真实环境

- Windows x64；Ubuntu-24.04 WSL2。
- OpenClaw 2026.5.3-1，端点 ws://127.0.0.1:18789/。
- 2026-09-16，实际 Electron 应用通过正常设备身份握手成功连接。
- 只读会话读取成功：3 个会话；选取一段历史成功返回 34 条消息。
- 未自动向真实网关发送聊天消息，未修改 OpenClaw 配置或重启网关。

## 交互验证

实际 Electron 窗口连接本地测试 WebSocket 网关，验证了发送、完整快照式流式回复、Markdown 代码块、停止回复、断开后禁止发送、外部地址拒绝和凭据不出现在公开设置。测试数据只存在于测试服务器中，不随应用发布。

加密存储验证使用 Windows Electron safeStorage（桌面烟测）以及独立 AES-GCM 测试适配器（持久化单测）；检查了磁盘文件不含明文凭据和私钥。

## 首轮审查与修复

独立审查发现三项设置生命周期问题：首次导入覆盖显式无凭据地址、缺少密码认证入口、更换网关后缓存未隔离。修复与复验结果见 docs/work/fix-report.md 和后续复审记录。

三项问题已修复，限定范围复审未发现剩余 Critical/Important 项。最终完整自动测试为 **36 项通过、0 失败**。主任务再次执行源代码 Electron 验收：最小外窗 960×680、保存无凭据配置后重启、发送和停止、密码/凭据隔离均通过；真实网关只读连接再次通过。

## 界面截图

- `docs/screenshots/kuro-welcome.png`：欢迎页。
- `docs/screenshots/kuro-compact.png`：最小窗口，输入区保持可见，欢迎内容可滚动。
- `docs/screenshots/kuro-chat-demo.png`：本地测试网关提供的示例消息，展示代码块；不是用户的真实聊天。
- `docs/screenshots/kuro-settings.png`：连接设置。

## 验证命令

```powershell
npm test
npm run build
node tests/electron-smoke.mjs
node tests/electron-smoke.mjs --live
node tests/electron-smoke.mjs --packaged
```

`--live` 仅执行连接、会话列表、历史读取。普通与 `--packaged` 模式使用本地模拟网关进行消息收发。截图写入 .test-data/desktop 和 .test-data/live。

## 最终产物验收

2026-09-16 最终交付检查全部通过：

| 检查 | 结果 |
| --- | --- |
| `npm test` | 36 项通过，0 失败 |
| `npm run package` | TypeScript、Vite、图标生成、Windows 便携打包均成功 |
| `node tests/artifact-check.cjs` | 包内最终代码/图片与构建结果一致，不含项目测试、测试配置或文档 |
| `node tests/electron-smoke.mjs --packaged` | 真实目录版窗口、聊天、停止、断开、加密凭据、最小窗口及无凭据重启通过 |
| `node tests/electron-smoke.mjs --packaged --live` | 真实网关连接、3 个会话、34 条历史消息读取通过 |
| `node tests/portable-smoke.mjs` | 最终便携 EXE 解压启动、窗口、角色图片、隔离的桌面接口通过，退出码 0 |

便携产物：`release/Kuro-0.1.0-Windows-x64.exe`，103,586,457 字节（约 98.79 MiB）。

SHA-256：`E2FDD89549212E7474228F67A620C9A9324F9F1BBFA5BA517A15C175842AB674`

目录版：`release/win-unpacked/Kuro.exe`。项目根目录 `Start-Kuro.cmd` 优先启动目录版，便于本机快速打开。

## 2026-09-24 Stop 修复版

修复运行 ID 未命中后无法退出等待、过早停止及历史刷新失败导致停止状态卡住的问题。42 项自动测试、源码与目录版 Electron 交互、包内容校验和新版便携 EXE 启动均通过。详见 [修复与验证记录](work/2026-09-24-stop-fix.md)。本轮未发起真实模型聊天。

当前便携 EXE 为 103,587,019 字节，SHA-256：`B59A9A751AB91DAF5217101E9642CECB6FED3CD1C693CAF9A6DC5E9708F3C487`。上面的 2026-09-16 大小与校验值属于旧版。

## 范围说明

第一版提供本机 WSL 网关连接、聊天、历史、设置及便携运行。真实模型回复依赖现有 OpenClaw 的模型和工具配置，本轮没有代替用户发起真实模型请求。尚未包含托盘、开机启动、附件上传、远程网关、多看板娘和自动更新。
