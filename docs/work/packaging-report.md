# Windows 打包配置与启动说明

## 文件

- `electron-builder.yml`：应用 ID `local.kuro.openclaw`，产品/可执行文件名 `Kuro`，Windows x64 便携目标，输出 `release/`。
- `package.json`：添加 `package`、`package:dir`、`package:icon` 脚本和 `UNLICENSED` 标记。没有更改依赖版本或应用主入口。
- `README.md`：中文源码/便携启动步骤、首次 WSL 导入、连接认证、操作方法、构建命令、产物结构、边界与常见问题。

## 配置细节

- 便携 EXE 文件名：`Kuro-${version}-Windows-${arch}.exe`。
- 目录版：`release/win-unpacked/Kuro.exe`，分发时应包含整个目录。
- ASAR 包含 `dist/`、`dist-electron/`、`electron/preload.cjs`、原始角色 PNG、package 元数据；electron-builder 自动收集生产依赖。
- 主进程从 `dist-electron/electron/main.js` 向上两级定位应用根目录，目录结构在 ASAR 内保持一致。
- 图标采用现有 PNG；`scripts/create-icon.cjs` 用 Electron `nativeImage` 缩放到 256×256，并把透明 PNG 封装到标准 ICO 容器。打包脚本先生成 `assets/concepts/kuro.ico`，避免 electron-builder 的 WebAssembly 图标转换器在当前 Windows 环境内存分配失败。
- `electronDist: node_modules/electron/dist` 使用 npm 已安装且版本一致的 Electron 44.3.0。这样避开 electron-builder 26.15.3 在 Windows 上把刚解压的 `win-unpacked.tmp` 立即重命名时稳定触发的 `EPERM`。执行打包前必须先运行 `npm install`，确保本地 Electron distribution 存在。
- `win.signExecutable: false` 关闭代码签名，保留默认资源编辑，以保留图标与版本信息。该选项已用已安装的 electron-builder 26.15.3 schema 验证。
- `publish: null`，且两个打包脚本都指定 `--publish never`。
- 不需要管理员权限，不含安装、发布或自动更新流程。
- 源码仍使用现有 `npm start`；分发使用产物 EXE。新增脚本仅生成打包图标，不参与应用运行。

## 验证与主任务交接

已执行真实目录打包：

```powershell
npm run package:dir
```

命令退出码为 0，目录产物位于 `release/win-unpacked/Kuro.exe`。验证结果：ICO 为单图 256×256、32 bpp、PNG payload；`Kuro.exe` 可提取到非空 32×32 关联图标；`resources/app.asar` 包含 `dist/index.html`、`dist-electron/electron/main.js`、`electron/preload.cjs` 和 `package.json`。失败尝试留下的 `release/win-unpacked.tmp` 与 `release/.icon-ico` 已在确认绝对路径位于项目 `release/` 下后删除。

原始问题先用默认配置连续复现：Electron ZIP 已完整解压，但立即执行目录 rename 两次均报 `EPERM`；builder 退出后对同一目录正反 rename 均成功，排除了 ACL、目标已存在及持久进程占用。使用本地 `electronDist` 后流程越过该阶段，随后发现并解决独立的 WebAssembly 图标转换内存错误。最终 portable 产物仍由主任务在运行时/UI 修复完成后重新构建。

未修改 UI、Electron 运行时代码或测试文件；没有 git 提交。
