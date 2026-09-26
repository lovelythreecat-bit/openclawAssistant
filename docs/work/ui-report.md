# 库洛 UI 实现报告

## 完成范围

- `src/App.tsx`：导航栏、会话列表、欢迎插画和建议卡、真实聊天视图、Markdown、工具活动、网关和设置页。
- `src/useWorkspace.ts`：桥接调用、会话与历史加载、独立会话草稿和运行状态、发送/停止/重连/设置交互。
- `src/workspace.ts`：可测试的流式状态变换。
- `src/styles.css`：暖白、樱花粉、珊瑚与淡紫视觉；默认和最小窗口布局；减少动画偏好支持。
- `src/main.tsx`、`index.html`、`vite.config.ts`、`tsconfig.json`：React/Vite 前端入口与构建配置。
- `tests/workspace.test.ts`：8 个针对真实状态逻辑的测试，均先观察失败后完成实现。

角色始终使用「库洛」，原始 PNG 用于大幅欢迎插画和头像。没有生产环境示例聊天、假网关桥接或秘密本地缓存。

## 并发与真实性

- 历史请求按会话、请求编号和状态版本隔离。快速切换不复用上一会话消息。
- 发送前立即记录幂等 run ID；支持 RPC 确认前事件，返回不同 ID 时重放对应缓冲事件。
- delta 替换完整快照；终态以网关历史刷新覆盖乐观记录，避免重复。
- 每个会话分别保存草稿与运行状态，可在发送期间切换会话。
- 发送失败恢复草稿；已观察到的部分回复会保留。断线会结束等待并明确提示刷新确认送达状态。
- 停止操作等候终态事件；只有 `abort` 明确返回 `aborted: true` 才用历史刷新作为终态事件缺失时的回退。未确认停止时保持运行状态并提供重试，不宣称已停止。
- 外链经桥接打开，只允许 http/https；Markdown 不渲染外部图片，避免聊天内容静默发起外部图片请求。
- 密码输入只保存当前手动输入，保存成功会清空；公共配置仅含凭据存在与来源。

## 验证

- `npx tsc --noEmit -p tsconfig.json`：通过。
- `npx tsx --test tests/workspace.test.ts`：8/8 通过。
- `npx vite build`：通过，最终构建无警告。JS 约 420.5 KB / gzip 129.5 KB；原始角色图片约 1.72 MB。
- Edge headless + Playwright 在实际页面上执行临时桥接边界测试（仅测试注入，未写入应用）：
  - 建议卡只填草稿，不发送；IME 回车不误发；连续回车仅发送一次。
  - 延迟 Alpha 历史与快速 Beta 切换不会串记录。
  - RPC 确认前 delta 可显示；完整快照不会拼接重复；final 刷新后消息不重复。
  - 断线清理运行状态、恢复未确认草稿、禁用发送；无页面异常。
  - 未确认 abort 保持运行；确认 abort 后读历史再清除运行。
  - 发送拒绝保留草稿；设置令牌输入 masked 且保存后清空。
- 在 1320×860 与 960×680 检查欢迎页；最小尺寸检查网关/设置无横向溢出。设置页纵向滚动可访问全部表单。

## 视觉证据

- `docs/work/ui-welcome.png`
- `docs/work/ui-welcome-small.png`
- `docs/work/ui-gateway-small.png`
- `docs/work/ui-settings-small.png`
- `docs/work/ui-chat-check.png`（合成测试夹具的断线恢复截图，仅测试证据）

## 边界与后续整体验证

- 本子任务验证的是浏览器中的真实 React 界面与合成桥接边界；实际 Electron preload、WSL、OpenClaw 连接和真实模型回复由主任务整体验证。
- 未实现跨应用重启的会话选择恢复（非必须）；聊天记录不在本地持久化。
- 不支持上传附件；历史中的图片用文字占位，避免未经操作的网络资源请求。
- `npx vite` 开发服务器由本子任务启动，工具会话 ID 为 `73259`，地址 `127.0.0.1:5173`。整体验证可复用，完成后可关闭。

没有修改 `src/types.ts`、`package.json` 或 `electron/`；没有 git 提交。
