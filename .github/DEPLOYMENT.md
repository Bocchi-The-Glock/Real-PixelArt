# 自动发布到 RealPixelArt.github.io

## 切换到新网站

- 源码仓库：**https://github.com/Bocchi-The-Glock/Real-PixelArt**。
- 网站仓库：**https://github.com/RealPixelArt/RealPixelArt.github.io**，仓库名末尾没有分号。
- 网站访问地址：**https://realpixelart.github.io/**。

先创建或确认网站仓库为公开仓库。沿用 `ORG_PAGES_TOKEN` 这个 Secret 名称，但令牌必须授权给新的 **RealPixelArt/RealPixelArt.github.io**；旧组织的 fine-grained token 不会自动获得新组织的权限。按下面步骤创建新令牌，并在源码仓库更新 Secret。

提交本次更名和 workflow 修改后，运行 **Deploy RealPixelArt website**；第一次成功推送会建立目标仓库的 `gh-pages` 分支，再到目标仓库 Pages 设置中选择该分支的根目录。源码仓库改名不会自动迁移旧网站仓库、Pages 设置或部署令牌。

本地远程地址应为：

```powershell
git remote set-url origin https://github.com/Bocchi-The-Glock/Real-PixelArt.git
```

## 两个仓库的分工

```text
Bocchi-The-Glock/Real-PixelArt 的 main 分支收到 push
  → 安装 Python 3.12 和固定版本依赖
  → 运行 src/tests/test_realpixelart.py
  → 生成 Python 参考结果，验证原生 JS 与 Python 的网格和像素一致
  → node web/build.mjs 校验并构建原生 JavaScript 网站
  → 将 build/pages 的内容推送到目标仓库 gh-pages 分支
  → 目标仓库的 GitHub Pages 发布 https://realpixelart.github.io/
```

源仓库保留完整项目：`.github/`、`scripts/`、`src/`、`input/`、`web/`、`realpixelart.py`、`pyproject.toml` 等。CI 的参考测试需要 Python 源码和 input 图片；静态网站本身只需要 web 中的发布资源。

目标仓库 `RealPixelArt/RealPixelArt.github.io` 接收网页成品。发布目录根部就是 index.html，同时包含前端 JS/CSS、core/、core-manifest.json、assets 和 .nojekyll。不会把开发脚本、测试或 input/output 文件夹复制到网站。

## 一、创建跨仓库令牌

使用对目标仓库有写权限、且属于 RealPixelArt 组织的账号：

1. GitHub 个人头像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**。
2. 名称可填 `Real-PixelArt website deploy`；设置有效期，到期前更新 Secret。
3. **Resource owner：RealPixelArt**。不要选源码仓库的个人用户名。
4. **Repository access → Only select repositories**：仅选择 `RealPixelArt.github.io`。
5. **Repository permissions → Contents：Read and write**；Metadata 的只读权限自动带上。
6. 生成令牌。如果显示 Pending，先让组织管理员批准。此方案只推送静态文件，不需要给令牌增加 Workflows、Pages 或组织管理权限。

如果 Resource owner 列表里没有 RealPixelArt，请先确认当前账号是该组织成员，以及组织允许 fine-grained tokens。若 RealPixelArt 实际是另一个个人账号，需要由该账号创建可写目标仓库的令牌。

## 二、Secret 放到源码仓库

打开 [源码仓库的 Actions secrets](https://github.com/Bocchi-The-Glock/Real-PixelArt/settings/secrets/actions)：

**Settings → Secrets and variables → Actions → New repository secret**

- Name：`ORG_PAGES_TOKEN`
- Secret：上一节生成的令牌值。

令牌的授权对象是**目标仓库**，保存 Secret 的位置是**源码仓库**。不要把令牌写进 YAML、提交记录或聊天。

源码仓库的 **Settings → Actions → General** 需要允许 workflow 使用 `actions/checkout`、`actions/setup-python`、`actions/setup-node` 和 `peaceiris/actions-gh-pages`。当前 workflow 的内置 GITHUB_TOKEN 只需 `contents: read`；跨仓库写入使用 ORG_PAGES_TOKEN。

## 三、首次推送，先生成 gh-pages 分支

将 `.github/workflows/deploy-org-pages.yml`、`.github/requirements-ci.txt`、`web/build.mjs` 和本说明提交到**源码仓库的 main 分支**。已有网页或 Python 修改也按你的发布需要提交。

注意 workflow 必须位于 GitHub 仓库根部的 `.github/workflows/`；不能外面再套一层 real_pixel_art 文件夹。

进入 [源码仓库 Actions](https://github.com/Bocchi-The-Glock/Real-PixelArt/actions)，等待 **Deploy RealPixelArt website** 成功。也可点进该 workflow → **Run workflow → Branch: main → Run workflow** 手动运行。

第一次成功后，目标仓库会出现 **gh-pages** 分支。不用预先创建；现有 main 分支不会被这个 workflow 改写。gh-pages 专门保存生成的网页：每次同步会移除旧的成品文件，保留提交历史，因此不要手动在 gh-pages 放其他资料。

## 四、在目标仓库开启 GitHub Pages（只需一次）

打开 [目标仓库 Pages 设置](https://github.com/RealPixelArt/RealPixelArt.github.io/settings/pages)：

1. **Settings → Pages → Build and deployment**。
2. **Source：Deploy from a branch**。
3. **Branch：gh-pages**，文件夹选 **/ (root)**，点 **Save**。
4. 确认目标仓库 **Settings → Actions → General** 没有禁用 Actions；组织策略也需要允许 Pages 发布。
5. 回到源码仓库的 **Deploy RealPixelArt website → Run workflow → main**，再运行一次，让开启 Pages 后的目标分支收到新的推送。
6. 等待目标仓库 Actions 中的 **pages build and deployment** 成功。
7. 访问 **https://realpixelart.github.io/**，用上传图片、生成、下载验证页面。

这里选择 Deploy from a branch；源码仓库的 Actions 负责构建和跨仓库推送，目标仓库负责从 gh-pages 发布。无需在目标仓库再复制这份源 workflow，也无需在源码仓库开启 Pages。

目标仓库目前若为空，Pages 下拉菜单可能没有 gh-pages；先完成第三节，再回来选择。首次开启 Pages 后，以目标仓库的部署记录和网站实际访问为准，源码 workflow 绿色只代表构建与推送成功。

## 之后怎样更新

每次向源码仓库 **main** 推送，或将 PR 合并进 main，都会运行检查并更新网页。其他分支的 push 不发布；手动运行也应选择 main。快速连续推送会串行处理，GitHub 可能合并等待中的旧任务，最终发布最新一次更新。

网页已迁移到原生 JavaScript。修改算法时同步 `src/realpixelart` 与 `web/core`，用 `python scripts/export_web_reference.py` 和 `npm --prefix web test` 检查一致性。CI 测试后执行 `node web/build.mjs --out build/pages`；无需 Python 运行时、vendor 或算法压缩包。

构建或测试失败时，不执行推送，已部署网站仍保留前一次版本。发布步骤设置了 `allow_empty_commit: true`：即使网页成品没有变化，也会向目标分支提交并推送一次，便于在首次启用 Pages 或修复设置后重新触发发布。这只增加部署记录，不会重复存储一整份相同的网页文件。

### 已选 gh-pages，但目标 Actions 一直为空

Pages 设置中的 “currently being built from the gh-pages branch” 只说明发布来源，不能证明发布任务已运行。

1. 在目标仓库 **Settings → Actions → General** 检查 Actions 是否启用；如组织策略限制，需在组织设置中允许。
2. 对比源码 workflow 的运行时间与目标 `gh-pages` 最新提交时间。旧配置在文件不变时跳过提交，重复运行源码 workflow 不会产生新的 push。提交本次 `allow_empty_commit` 修改后，在源码 Actions 点击 **Run workflow**；不要只重跑旧提交的任务。
3. 保持 Pages 来源为 **Deploy from a branch → gh-pages → / (root)**，查看目标 Actions 的 **All workflows**。
4. 若目标分支已有新提交，但仍没有部署任务，按 GitHub 官方要求检查推送令牌所属账号是否有目标仓库管理员权限、邮箱是否已验证。若用 fine-grained PAT，还需保留对目标仓库的 Contents 写权限。

不要把源码 workflow 原样复制到目标仓库：它有源码仓库条件限制，也依赖目标仓库不存在的 Python 源码。源码 Action 绿色仍仅表示构建与同步成功；网站上线以目标 Pages 部署成功为准。

## 本地复现构建

在项目根目录，使用 Python 3.12（参考测试）和 Node.js 22 运行：

```powershell
python -m pip install -r .github/requirements-ci.txt
python -m pytest src/tests/test_realpixelart.py -q
python scripts/export_web_reference.py
npm --prefix web test
node web/build.mjs --out build/pages
python -m http.server 8765 --bind 127.0.0.1 --directory build/pages
```

`build/pages` 是可重复生成的成品目录，每次 build.mjs --out 都会替换它；build 已被 gitignore 排除。CI 执行 Python 回归、JS 对照测试及资源完整性检查，浏览器交互回归仍按 web/README.md 单独运行。

## 常见失败位置

| 现象 | 检查项 |
| --- | --- |
| Actions 中没有 workflow | 是否将 `.github` 提交到源仓库 main，文件是否在仓库根部，Actions 是否启用 |
| 提示缺少 ORG_PAGES_TOKEN | Secret 必须放源码仓库；名称完全一致；不要建成 Variable |
| 推送目标仓库报 403 / permission denied | 令牌是否过期；Resource owner/仓库选错；Contents 是否 Read and write；组织是否待审批；gh-pages 的 Rulesets 是否阻止直接推送 |
| Pytest 失败 | 读取失败项日志；先修复再发布，不跳过测试掩盖失败 |
| Missing / checksum mismatch | 检查 web/core 是否完整提交；运行 node web/build.mjs 更新资源清单 |
| 源仓库 Actions 成功，网站仍 404 | 目标仓库 Pages 是否选 gh-pages / root，目标仓库部署是否成功 |
| 已选 gh-pages，目标 Actions 仍为空 | 检查目标 Actions/组织策略是否允许；提交 allow_empty_commit 修改后重新 Run workflow；确认目标最新提交确实更新，再检查推送账号的管理员权限和邮箱验证 |
| 主页能开但一直加载算法 | 浏览器 Network 检查 worker.js、core/*.js、core/palettes.json 和 core-manifest.json 是否 200；强制刷新 |
| 页面仍是旧版 | 确认修改已推送到源仓库 main，查看两个仓库最新部署，再 Ctrl+F5 |

## 参考

- [GitHub：设置 Pages 的发布来源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [GitHub：创建 fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [actions-gh-pages：发布到另一仓库，需要 deploy key 或 personal token](https://github.com/peaceiris/actions-gh-pages#%EF%B8%8F-deploy-to-external-repository-external_repository)
