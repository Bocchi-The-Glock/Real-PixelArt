# RealPixelArt Web

纯前端应用：使用原生 JavaScript 在 Worker 中识别网格、恢复像素和处理颜色。图片不上传，没有后端，也不加载 Python、Pyodide、NumPy、Pillow 或算法压缩包。网页版、Tauri 轻量版与 Electron 保留版使用相同的网页文件。桌面版构建见 [desktop](../desktop/README.md)。

## 本地打开与发布

需要 Node.js 22 或更新版本，**不需要 npm install**：

```bash
node web/build.mjs
npm --prefix web start
```

打开 **http://127.0.0.1:8765/**。也可以使用任何静态文件服务器。模块 Worker 需要 HTTP(S)，不能双击 HTML 使用 file://。

生成可直接部署的网站目录：

```bash
node web/build.mjs --out build/pages
```

上传 `build/pages/` 中的全部文件即可部署到 GitHub Pages 或 Cloudflare Pages。构建脚本只校验、复制静态资源；网站运行时不需要 Node.js。CI 的 Python 环境仅用于对照测试。现有跨仓库发布目标不变，详见[部署说明](../.github/DEPLOYMENT.md)。

## 界面行为

- 上传图片后点击“生成”；默认同时生成 FFT、边缘、网格、投影与曲率过程图，可在“更多设置”关闭。
- 颜色数量、色库和自然/RGB 模式是独立后处理。调整时使用缓存的不限色原生 PNG，不重新检测网格，也不叠加上次量化。
- 导出倍数 1–16 只做最近邻放大；预览缩放与导出倍数独立。
- 明暗主题、中英文、双窗口缩放与拖动、PNG 和处理过程 ZIP 下载保留。
- 网页不自动写入电脑 output 目录；ZIP 内路径为 `output/debug/<图片名>/`。
- 页面打开时预加载轻量 JS 引擎和色库。取消或内存异常会终止 Worker，后续任务重新启动。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `app.js` / `i18n.js` | 界面、预览、参数、翻译与任务状态 |
| `worker.js` | 初始化、文件解码、调度、导出；不决定网格 |
| `core/config.js` | 参数默认值与校验 |
| `core/pipeline.js` | 与 Python 对应的处理顺序、结果和计时 |
| `core/features.js` | 原分辨率梯度、投影、FFT 与边段证据 |
| `core/grid.js` | 尺度/起点搜索、分割、验证及保守回退 |
| `core/sampling.js` | 格内取色、透明度、照片取色与可选颜色后处理 |
| `core/numeric.js` | 数值归约、偶数舍入和混合基数/Bluestein FFT |
| `core/tools.js` | PNG 像素读写、浏览器解码、EXIF/MPO 与 ZIP |
| `core/diagnostics.js` | Canvas 过程图和诊断文件，不参与算法判断 |
| `core/palettes.json` | 与 Python 相同的 DMC/MARD 色库 |
| `core-manifest.json` | 构建生成的资源哈希、默认配置和色库目录 |
| `build.mjs` / `serve.mjs` | 开发与部署工具，不进入发布目录 |

Python 的 `src/realpixelart` 仍供 CLI/API 使用。以后修改算法，应同步对应 JS 阶段并执行对照测试；不能只改一种实现后假定另一种会自动更新。JS 公共函数使用 camelCase，配置和诊断字段保留 Python 的 snake_case，方便对照。

## 数值与格式约定

- RGBA 工作数组为 Float32Array，Lab/颜色距离和 FFT 使用 Float64；关键求和顺序、候选排序、平局处理与 NumPy 偶数舍入明确实现。
- PNG 直接读取/写出通道，不经 Canvas 预乘透明度；支持灰度、RGB、RGBA、索引色、合法位深和 Adam7。完全透明 RGB 不参与证据。
- JPEG/MPO、静态 WebP/GIF/BMP 使用浏览器解码；MPO 选择声明的唯一主照片，否则第一张。EXIF 方向保留。支持 ImageDecoder 时，无 EXIF 的透明 WebP 直接复制原生 RGBA/BGRA 通道，避免 Canvas 的低 alpha 颜色量化；不支持时使用 Canvas 回退。动画与浏览器不支持的格式明确报错，目前不支持 TIFF。
- Canvas 只用于普通图片的浏览器解码、界面显示及过程图绘制，不替代 PNG 取色或最近邻导出。
- 超过 400 万像素时，继续使用原分辨率条带与受限中心 FFT 展示区域。不会偷偷缩小输入再检测格距。
- 解码、float32 源图和导出仍会占用与像素数相关的内存。取消了旧 Wasm 堆限制，不代表支持无限大图片。
- JPEG 解码器、浮点计算末位和诊断字体可能存在平台差异。相同解码像素的回归测试要求输出字节和切割线完全一致；连续浮点参数允许很小的数值误差。

## 验证

```bash
python -m pip install -e ".[test]"
python scripts/export_web_reference.py
npm --prefix web test
node web/build.mjs --check
cd desktop-electron
npm ci
npm test
```

第一步仅用于开发对照：参考导出器生成真实 input 图片与合成图的 Python 网格、原生取色和限色结果。Node 测试逐像素比较 JS 输出，另覆盖 FFT、PNG、透明度、异常输入、颜色匹配与最近邻导出。没有生成参考文件时，对照测试会明确标为跳过；CI 先生成后测试。

Electron 测试通过真实窗口页面上传、生成、调色、导出，检查无远程图像请求，并与 Python 比较 PNG。实测速度、体积和已验证范围见[迁移记录](../docs/WEB_MIGRATION.md)。
