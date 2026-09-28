# RealPixelArt 轻量桌面版

与网页使用同一套 HTML、CSS 和 JavaScript 算法。Tauri 只负责窗口、系统运行环境检查和文件保存，不包含 Python、Node.js 或整套 Chromium。

旧版保留在 [desktop-electron](../desktop-electron/README.md)，名称改为 **RealPixelArt Electron**。两个版本可以共存。

## 用户如何运行

- **Windows 10/11，64 位**：下载 `RealPixelArt-版本-win-x64.exe`，双击运行。它是便携程序，不需要安装应用。若缺少 WebView2 110+，会弹出中英双语提示，可打开微软官方页面安装 Evergreen Runtime，然后重新打开应用。
- **Windows 安装版**：`RealPixelArt-版本-win-x64-setup.exe` 会检查运行时，并在缺失或过旧时启动微软安装引导。此步骤需要联网；正常处理图片不需要联网。
- **macOS 13.3 或更新**：Apple 芯片下载 `mac-arm64.dmg`，Intel 下载 `mac-x64.dmg`，打开并拖入“应用程序”。也提供包含 .app 的 ZIP。使用系统 WKWebView，无须另外下载浏览器；若系统 API 不够新，会提示更新 macOS/Safari。

图片处理、界面、取色和颜色后处理直接复用网页代码；桌面版通过系统“另存为”窗口保存 PNG 和处理过程 ZIP。网页代码更新后重新构建即可。

当前没有商业代码签名证书。macOS 构建采用 ad-hoc 签名，尚未进行 Apple 公证；公开发行前建议配置 Developer ID 和公证，否则首次打开可能被 Gatekeeper 拦截。Windows 下载也可能显示未知发布者提示。

## 从源码构建

仅开发者需要 Node.js 22+、Rust 1.94.0（rust-toolchain.toml 已锁定），以及平台编译工具：

- Windows：Visual Studio C++ 桌面开发工具和 Windows SDK、WebView2。
- Mac：Xcode Command Line Tools（`xcode-select --install`）。

在本目录运行：

```sh
npm ci
npm start                    # 开发窗口
npm test                     # JS 适配器和静态资源一致性
npm run test:rust            # 运行时版本、导出校验
npm run test:native          # 实际系统 WebView：上传、处理、PNG/ZIP 导出
npm run build:win            # Windows 便携 EXE + 安装包
npm run build:mac            # 当前 Mac 架构的 .app / DMG / ZIP
```

只构建 Windows 便携文件：`npm run build:portable && npm run release`。
发布文件统一整理到 `desktop/release/`。构建和测试文件都已加入 .gitignore，不应提交 EXE/DMG 到源码仓库。

Mac 产物需要在 Mac 上编译。在 Windows 上开发时，可使用下方 GitHub Actions 同时构建三种产物。Windows 和 Mac 共用同一套源码，无须维护两份算法。

## GitHub Actions

提交代码后，打开 **Actions → Build lightweight desktop apps → Run workflow**，或推送 `desktop-v0.1.0` 形式的新标签。

流程分别在 Windows、Apple 芯片 Mac 和 Intel Mac 上运行验证，再构建发行文件。完成后在这次运行的 **Artifacts** 下载对应压缩包，解压并将其中 EXE/DMG/ZIP 上传到 GitHub Release。流程不自动发布 Release。

旧 Electron 版使用 **Build Electron desktop apps**，支持手动启动和 `electron-v*` 标签。

## 文件职责

| 文件 | 用途 |
| --- | --- |
| `src-tauri/src/main.rs` | 窗口、外部仓库链接、原生保存接口 |
| `src-tauri/src/runtime.rs` | 启动前检查系统 WebView，提供安装或更新引导 |
| `adapter.js` | 网页下载动作连接系统保存窗口；检查必需浏览器 API |
| `scripts/prepare.mjs` | 复制网页静态文件并加入桌面适配器 |
| `scripts/release.mjs` | 整理可分发文件 |
| `tests/`、`src-tauri/src/smoke.rs` | 单元测试与真实 WebView 集成测试 |

`smoke-test` 仅用于测试构建：隐藏窗口并把导出写到专用测试目录。正式构建不启用该特性，也不包含测试命令和测试脚本。正式程序不启动本地 HTTP 服务，全部页面资源编译进程序。

应用偏好和 WebView 缓存由系统保存在应用数据目录（标识符 `io.github.realpixelart.lightweight`），不会把用户图片上传到服务器。便携 EXE 不代表“完全不写缓存”。

## 限制

轻量化依赖系统 WebView。缺少运行时时，第一次需要安装；不同系统的字体、JPEG/WebP 解码可能有细微差异。PNG 网格和像素一致性由原生测试核对。性能和包大小以实际构建测量为准。

本机包大小、测试结果与未验证范围见 [验证记录](VALIDATION.md)。
