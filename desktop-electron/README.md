# RealPixelArt Electron（保留版）

原来的 Electron 桌面实现完整保留在这里。新的轻量版在 [desktop](../desktop/README.md)。

- 应用名：**RealPixelArt Electron**
- 新构建产物：`RealPixelArt-Electron-版本-平台-架构`
- 继续使用相同的网页和 JS 图像算法；自带 Chromium，兼容性不依赖系统 WebView。
- 已有的旧安装包不改写。缓存格式保留，新的包会使用自身内容对应的缓存目录。

```sh
npm ci
npm start
npm test
npm run dist:win
npm run dist:mac
```

构建流程：**Build Electron desktop apps**（手动或 `electron-v*` 标签）。发布文件在本目录的 `dist/`，不提交到 Git。
