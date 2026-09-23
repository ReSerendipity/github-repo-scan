# GitHub 仓库扫描总览（github-repo-scan）

把 GitHub 账号名下所有仓库的情况（CI / 许可证 / Release / Issue / 分支 / Star·Fork / 健康分 / 可选 14 天流量）拉成本地总览面板，每个单元格都带 GitHub 跳转链接。

远程仓库：<https://github.com/ReSerendipity/github-repo-scan>

## 三种用法

| 方式 | 命令 | 说明 |
|---|---|---|
| 双击启动（推荐） | `启动面板.bat` | 双击即启动本地服务并自动打开浏览器 |
| 交互面板 | `node server.mjs` | 同上，命令行方式启动；支持 `--port` 换端口 |
| 远程+本地对照 | `node scan.mjs [owner]` | 扫远程账号并对照本机 Git 仓库，重新生成 `dashboard.html` + `scan-data.json` |
| 仅本地扫描 | `node scan.mjs --local-only` | 只扫本机 Git 仓库（不访问 GitHub），并入现有快照 |
| 本地范围/深度 | `node scan.mjs --local-paths "a;b" --depth 5` | 临时指定本地扫描根目录（分号分隔）与深度 |
| 仅远程 | `node scan.mjs --remote-only` | 跳过本地对照 |
| 仅重渲染 | `node scan.mjs --render-only` | 不重新扫描，按现有快照重渲染面板（改样式/主题后用） |
| 启动前自动扫描 | `node server.mjs --scan-on-start=always` | 每次启动面板先扫描（约 20–40 秒）再开页面；模式 `always`/`stale`/`first`/`off`，默认 `stale`（快照比 `autoScanMaxAgeHours` 旧才扫），由 `scan-config.json` 的 `autoScanOnStart` 控制，面板「启动前扫描」开关可联动切换 `always`/`off` |

指定账号：默认扫当前 gh 登录账号；`node scan.mjs someUser` 可扫指定账号。

## 页面功能

| 功能 | 实现 |
|---|---|
| 扫描更新 | 页面右上角「重新扫描」→ 本地服务 → gh CLI → GitHub API；完成后表格原地刷新，同时把 dashboard.html 与 scan-data.json 写回磁盘 |
| 自动刷新 | 工具栏可选每 10 / 30 / 60 分钟自动扫描一次，选择会记住 |
| 明暗切换 | 右上角主题按钮（默认浅色；GitHub 亮 / 暗两套配色），切换后选择记忆在浏览器 localStorage |
| 排序 | 全部表头可点击：仓库 / 健康 / CI 状态 / 许可证 / Release / Issue / 分支 / Star / Fork / 语言 / 流量 / 最近推送；再点一次切换升降序，空值恒沉底，排序选择会记住 |
| 健康评分 | 每仓 0-100 分：CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15（归档仓打七折），A/B/C/D 四档，悬停看构成 |
| 自定义视图 | 「＋存视图」把当前搜索/筛选/排序存成命名视图，下拉一键切换，保存在浏览器 localStorage |
| 流量（14天） | 设环境变量 `SCAN_WITH_TRAFFIC=1` 后重新扫描，展示近 14 天浏览量与克隆数（每仓多 2 次 API 调用，需 push 权限） |
| 筛选与搜索 | 按仓库名/描述搜索、按语言筛选、按状态筛选（CI 通过/失败/运行中/无 CI/有 Issue/未声明许可证）、一键隐藏 fork |
| CI 趋势 | 每仓展示最近 5 次 Actions 运行的点阵（绿=通过、红=失败、黄=运行中），悬停看时间与结论 |
| 本地对照 | 每仓显示本机是否有对应 Git 仓库（本地有 / 本地缺失），带分支、脏状态、领先落后；支持按本地状态筛选与排序 |
| 仅本地视图 | 「仅扫本地」只读本机 .git；「仅本地仓库」模式列出全部本机仓库（含远程账号名下没有的），「本地目录…」设置扫描范围 |
| API 配额 | 页脚实时显示 GitHub API 剩余额度与重置时间 |
| CI/CD 状态 | 最近一次 GitHub Actions 运行：通过 / 失败 / 运行中 + 工作流名与触发分支，点击直达该次运行页 |
| 许可证类型 | SPDX 标识（MIT、Apache-2.0 等），点击直达 LICENSE 文件页 |
| Release | 最新发布 tag + 名称 + 时间，点击直达 release 页 |
| Issue | 开放 issue 数（不含 PR），点击直达 issues 页；开放 PR 数单独列出并链接 |
| 分支 | 默认分支名 + 分支总数，点击直达 branches 页 |
| 仓库信息 | star / fork / 主语言 / 描述 / 可见性 / 最近推送，均链接到对应 GitHub 页面 |
| 可见性排序/筛选 | 「可见性」列可点表头按公开/私有排序（私有优先）；状态筛选下拉含「仅公开 / 仅私有」；顶部指标卡显示公开/私有数量 |
| 仓库大小 | 「大小」列显示 GitHub 磁盘占用（自动 KB/MB/GB 换算），可点表头排序；顶部指标卡显示总大小 |
| 最近变更文件 | 「最近变更」列显示最近一次提交变更的文件数，点「N 文件」就地展开文件清单（A 增 / M 改 / D 删，带 +− 行数，链接到提交页） |
| 导出 CSV | 右上角「导出 CSV」把当前筛选/排序结果导出为 UTF-8（带 BOM）CSV，Excel 可直接打开 |
| 隐藏归档 | 工具栏「隐藏归档」复选框一键隐藏 archived 仓库 |
| 低健康分筛选 | 状态筛选「仅低健康分(<50)」快速定位问题仓库 |
| 启动前自动扫描 | 面板「启动前扫描」开关 + `scan-config.json` 的 `autoScanOnStart`（always/stale/first/off），双击启动面板可先自动扫描再打开 |
| 创建时间排序 | 「创建时间」列可点表头按仓库创建时间排序 |
| 语言分布 | 顶部「语言分布」面板按仓库数 Top 8 展示各语言占比条（颜色取自 GitHub 语言色） |
| 聚合视图 | 顶部「聚合视图」面板一键列出 CI 失败 / 低健康分(<50) / 未声明许可证 / 无 CI 记录 / 本地缺失 的数量，点 chip 直接套用对应筛选 |
| 复制 clone | 右上角「复制 clone」把当前可见仓库的 `git clone <url>` 命令批量复制到剪贴板（Excel/终端可直接粘贴） |
| 仅归档筛选 | 状态筛选新增「仅归档仓库」；聚合视图面板单独列出归档仓库数量，点 chip 一键筛选 |
| Star 排行榜 | 顶部「Star 排行 Top 5」面板按 Star 数从高到低展示仓库名与占比条（点击仓库名直达 GitHub） |

## 本地 Git 仓库扫描（对照 + 独立）

- **远程与本地对照**：扫描远程账号的同时遍历本机目录找 Git 仓库，每个远程仓库在「本地」列显示：本地有（分支 · 干净 / 未提交 n / ↑领先 ↓落后）或本地缺失。
- **仅本地扫描**：`node scan.mjs --local-only` 或面板「仅扫本地」——只读本机 `.git`（remote / 分支 / HEAD / status / rev-list），不访问 GitHub、不 fetch、不推送；面板「仅本地仓库」模式列出全部本机仓库。
- **本地独有仓库**：本机存在但远程账号名下没有对应的仓库（改名、fork 后删库、纯本地实验仓），单独区块列出。
- **扫描范围**：默认 = 用户主目录（只看 1 层）+ 桌面 / 文档 / 下载（深度 4）；`scan-config.json` 的 `localScanRoots`（字符串或 `{ "path": "...", "depth": 2 }`）+ `localScanDepth` 持久配置，`--local-paths` / `--depth` 临时覆盖，面板「本地目录…」可视化保存。隐藏目录、`node_modules` 等重目录、符号链接自动跳过，最多 500 个仓库。
- **对照规则**：本地 remote URL 解析出 `owner/repo` 与远程精确匹配；无 GitHub remote 或 owner 不同但仓库名唯一时按名字兜底；同名多候选不猜（标记 ambiguous，进「本地独有」）。
- **依赖**：git 在 PATH 即可，无需 gh 登录；`--remote-only` 可关掉本地对照。
- **配置文件**：`scan-config.json` 含本机路径，已加入 `.gitignore` 不入库；还可配置 `autoScanOnStart`（启动前自动扫描模式：`always`/`stale`/`first`/`off`，默认 `stale`）与 `autoScanMaxAgeHours`（stale 模式下判定「过期」的小时数，默认 6）。

## 性能与增量

- 扫描并行化：许可证与 CI 记录按并发 8 并行拉取，全账号扫描约 5–15 秒（旧版串行需 30–40 秒）。
- 仓库分页：GraphQL 每页 100 个、最多 5 页（500 个），超出会在页面提示截断。
- 许可证链接增量复用：`pushedAt` 未变的仓库直接复用上次快照里的 LICENSE 链接，省一半 REST 调用。
- 自动重试：GitHub API 5xx / 429 / 网络抖动自动重试（最多 3 次、递增退避）。

## 依赖说明（是否依赖 gh CLI）

- **排序、筛选、明暗切换**：纯浏览器 JS，零依赖，离线可用。
- **扫描取数**：需要一个带凭据的 GitHub API 通道。当前实现复用本机 **gh CLI**（登录态存在系统 keyring，token 不落盘）；本地服务只是把 gh 的调用包成页面可点的按钮。
- 不想装 gh：设 `GH_TOKEN`（或 `GITHUB_TOKEN`）环境变量即自动走 **token 直连兜底通道**（REST+GraphQL，gh 缺失或未登录时自动生效，2026-09-21 实现）；token 走环境变量、不落盘。

前置：Node 18+；扫描功能需要 gh CLI 已登录（`gh auth login`）。

## 文件

- `启动面板.bat` —— 双击启动（UTF-8 无 BOM + `chcp 65001`，中文提示不乱码）
- `dashboard.html` —— 交互面板（每次扫描重新生成，数据内嵌，双击即开）
- `server.mjs` —— 本地服务（页面一键扫描的后端；仅监听 127.0.0.1，带跨站来源校验）
- `scan-core.mjs` —— 扫描与渲染共享核心（并行 / 分页 / 重试 / 增量）
- `scan.mjs` —— 命令行扫描入口（`--render-only` 仅重渲染）
- `scan-data.json` —— 最近一次扫描的数据快照（schema 3，含本地对照结果）
- `scan-config.json` —— 本地扫描配置（可选；含本机路径不入库，面板「本地目录…」会写入）
- `tests/core.test.mjs` —— 冒烟测试
- `hooks/pre-push` —— 推送前自动跑 `node --test` 的冒烟测试门闸（需复制到 `.git/hooks/` 启用）

## 测试

```bash
node --test
```

覆盖：CI 状态映射、相对时间分档、时区格式化、面板渲染（内嵌数据转义 / XSS 注入防护 / 默认主题 / 配额展示）。

**提交前必须运行**：改动 `scan-core.mjs` 等核心逻辑后，需本地 `node --test` 全绿再提交。

**自动触发点（pre-push 钩子）**：仓库内置 `hooks/pre-push`，会在每次 `git push` 前自动跑 `node --test`，失败即阻止推送并打印 `文件:行` 级断言差异。克隆后执行一次安装即可启用：

```bash
cp hooks/pre-push .git/hooks/pre-push
```

（Windows  PowerShell：`Copy-Item hooks/pre-push .git/hooks/pre-push`）钩子只运行已有冒烟测试，不改动业务逻辑，也不对比 `scan-data.json` 数据快照。

## 数据口径

- CI 取最近一次工作流运行（Actions runs 接口，任意分支/标签），显示工作流名与触发分支；从无运行记录显示「无 CI 记录」。
- Issue 数为开放 issue，不含 PR（GraphQL 的 issues 连接天然排除 PR；PR 数单列）。
- 分支数为全部分支总数（不含 tag）。
- 许可证链接来自 `GET /repos/{owner}/{repo}/license`；根目录没有标准 LICENSE 文件时只显示标识、不带链接。
- 本工具面向个人账号（查询走 `user(login:)`），组织账号暂不支持。
- 本地对照：`↑n` 本地领先远程 n 个提交、`↓n` 落后 n 个（基于本地缓存的远程 refs，不自动 fetch，需要刷新先手动 `git fetch`）；「未提交 n」为工作区改动文件数（含未跟踪）；「本地缺失」= 远程有但扫描范围内没有对应目录。
