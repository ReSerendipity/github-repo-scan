# GitHub 仓库扫描总览（github-repo-scan）

把 GitHub 账号名下所有仓库的情况（CI / 许可证 / Release / Issue / 分支 / Star·Fork）拉成本地总览面板，每个单元格都带 GitHub 跳转链接。

## 两种用法

| 方式 | 命令 | 说明 |
|---|---|---|
| 双击启动（推荐） | `启动面板.bat` | 双击即启动本地服务并自动打开浏览器；页面内可**一键重新扫描**、明暗切换、点击表头排序 |
| 交互面板 | `node server.mjs` | 同上，命令行方式启动；支持 `--port` 换端口 |
| 静态快照 | `node scan.mjs [owner]` | 命令行扫描，重新生成 `dashboard.html` + `scan-data.json`；双击 HTML 可看，排序与主题同样可用，仅「一键扫描」需服务 |

指定账号：默认扫当前 gh 登录账号；`node scan.mjs someUser` 可扫指定账号。

## 页面功能

| 需求 | 实现 |
|---|---|
| 扫描更新 | 页面右上角「重新扫描」→ 本地服务 → gh CLI → GitHub API；完成后表格原地刷新，同时把 dashboard.html 与 scan-data.json 写回磁盘 |
| 明暗切换 | 右上角主题按钮（默认浅色；GitHub 亮 / 暗两套配色），切换后选择记忆在浏览器 localStorage |
| 排序 | 全部表头可点击：仓库 / CI 状态 / 许可证 / Release / Issue / 分支 / Star / Fork / 语言 / 最近推送；再点一次切换升降序，空值恒沉底 |
| CI/CD 状态 | 最近一次 GitHub Actions 运行：通过 / 失败 / 运行中 + 工作流名与触发分支，点击直达该次运行页 |
| 许可证类型 | SPDX 标识（MIT、Apache-2.0 等），点击直达 LICENSE 文件页 |
| Release | 最新发布 tag + 名称 + 时间，点击直达 release 页 |
| Issue | 开放 issue 数（不含 PR），点击直达 issues 页；开放 PR 数单独列出并链接 |
| 分支 | 默认分支名 + 分支总数，点击直达 branches 页 |
| 仓库信息 | star / fork / 主语言 / 描述 / 可见性 / 最近推送，均链接到对应 GitHub 页面 |

## 依赖说明（是否依赖 gh CLI）

- **排序、明暗切换**：纯浏览器 JS，零依赖，离线可用。
- **扫描取数**：需要一个带凭据的 GitHub API 通道。当前实现复用本机 **gh CLI**（登录态存在系统 keyring，token 不落盘）；本地服务只是把 gh 的调用包成页面可点的按钮。
- 不想装 gh 也可以改造：① 用 `GITHUB_TOKEN` 环境变量替代 gh；② 在页面里粘贴 Personal Access Token 直连 api.github.com（支持 CORS），代价是 token 要自己保管。需要哪种说一声即可改。

前置：Node 18+；扫描功能需要 gh CLI 已登录（`gh auth login`）。

## 文件

- `启动面板.bat` —— 双击启动（UTF-8 无 BOM + `chcp 65001`，中文提示不乱码）
- `dashboard.html` —— 交互面板（每次扫描重新生成，数据内嵌，双击即开）
- `server.mjs` —— 本地服务（页面一键扫描的后端；仅监听 127.0.0.1）
- `scan-core.mjs` —— 扫描与渲染共享核心（含 5xx/429 自动重试）
- `scan.mjs` —— 命令行扫描入口（`--render-only` 仅按现有快照重渲染面板，不重新扫描）
- `scan-data.json` —— 最近一次扫描的数据快照

## 数据口径

- CI 取最近一次工作流运行（Actions runs 接口，任意分支/标签），显示工作流名与触发分支；从无运行记录显示「无 CI 记录」。
- Issue 数为开放 issue，不含 PR（GraphQL 的 issues 连接天然排除 PR；PR 数单列）。
- 分支数为全部分支总数（不含 tag）。
- 许可证链接来自 `GET /repos/{owner}/{repo}/license`；根目录没有标准 LICENSE 文件时只显示标识、不带链接。
- 本工具面向个人账号（查询走 `user(login:)`），组织账号暂不支持。
