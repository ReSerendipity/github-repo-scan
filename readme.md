# GitHub 仓库扫描总览（github-repo-scan）

把 GitHub 账号名下所有仓库的情况（CI / 许可证 / Release / Issue / 分支 / Star·Fork / 健康分 / 可选 14 天流量）拉成本地总览面板，每个单元格都带 GitHub 跳转链接。

远程仓库：<https://github.com/ReSerendipity/github-repo-scan>

## 三种用法

| 方式 | 命令 | 说明 |
|---|---|---|
| 双击启动（推荐） | `启动面板.bat` | 双击即启动本地服务并自动打开浏览器 |
| 交互面板 | `node server.mjs` | 同上，命令行方式启动；支持 `--port` 换端口 |
| 静态快照 | `node scan.mjs [owner]` | 命令行扫描并重新生成 `dashboard.html` + `scan-data.json` |
| 仅重渲染 | `node scan.mjs --render-only` | 不重新扫描，按现有快照重渲染面板（改样式/主题后用） |

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
| API 配额 | 页脚实时显示 GitHub API 剩余额度与重置时间 |
| CI/CD 状态 | 最近一次 GitHub Actions 运行：通过 / 失败 / 运行中 + 工作流名与触发分支，点击直达该次运行页 |
| 许可证类型 | SPDX 标识（MIT、Apache-2.0 等），点击直达 LICENSE 文件页 |
| Release | 最新发布 tag + 名称 + 时间，点击直达 release 页 |
| Issue | 开放 issue 数（不含 PR），点击直达 issues 页；开放 PR 数单独列出并链接 |
| 分支 | 默认分支名 + 分支总数，点击直达 branches 页 |
| 仓库信息 | star / fork / 主语言 / 描述 / 可见性 / 最近推送，均链接到对应 GitHub 页面 |

## 性能与增量

- 扫描并行化：许可证与 CI 记录按并发 8 并行拉取，全账号扫描约 5–15 秒（旧版串行需 30–40 秒）。
- 仓库分页：GraphQL 每页 100 个、最多 5 页（500 个），超出会在页面提示截断。
- 许可证链接增量复用：`pushedAt` 未变的仓库直接复用上次快照里的 LICENSE 链接，省一半 REST 调用。
- 自动重试：GitHub API 5xx / 429 / 网络抖动自动重试（最多 3 次、递增退避）。

## 依赖说明（是否依赖 gh CLI）

- **排序、筛选、明暗切换**：纯浏览器 JS，零依赖，离线可用。
- **扫描取数**：需要一个带凭据的 GitHub API 通道。当前实现复用本机 **gh CLI**（登录态存在系统 keyring，token 不落盘）；本地服务只是把 gh 的调用包成页面可点的按钮。
- 不想装 gh 也可以改造：① 用 `GITHUB_TOKEN` 环境变量替代 gh；② 在页面里粘贴 Personal Access Token 直连 api.github.com（支持 CORS），代价是 token 要自己保管。需要哪种说一声即可改。

前置：Node 18+；扫描功能需要 gh CLI 已登录（`gh auth login`）。

## 文件

- `启动面板.bat` —— 双击启动（UTF-8 无 BOM + `chcp 65001`，中文提示不乱码）
- `dashboard.html` —— 交互面板（每次扫描重新生成，数据内嵌，双击即开）
- `server.mjs` —— 本地服务（页面一键扫描的后端；仅监听 127.0.0.1，带跨站来源校验）
- `scan-core.mjs` —— 扫描与渲染共享核心（并行 / 分页 / 重试 / 增量）
- `scan.mjs` —— 命令行扫描入口（`--render-only` 仅重渲染）
- `scan-data.json` —— 最近一次扫描的数据快照（schema 2）
- `tests/core.test.mjs` —— 冒烟测试

## 测试

```bash
node --test
```

覆盖：CI 状态映射、相对时间分档、时区格式化、面板渲染（内嵌数据转义 / XSS 注入防护 / 默认主题 / 配额展示）。

## 数据口径

- CI 取最近一次工作流运行（Actions runs 接口，任意分支/标签），显示工作流名与触发分支；从无运行记录显示「无 CI 记录」。
- Issue 数为开放 issue，不含 PR（GraphQL 的 issues 连接天然排除 PR；PR 数单列）。
- 分支数为全部分支总数（不含 tag）。
- 许可证链接来自 `GET /repos/{owner}/{repo}/license`；根目录没有标准 LICENSE 文件时只显示标识、不带链接。
- 本工具面向个人账号（查询走 `user(login:)`），组织账号暂不支持。
