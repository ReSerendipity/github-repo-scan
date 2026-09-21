// scan-core.mjs —— 扫描 + 渲染共享核心（scan.mjs 命令行 与 server.mjs 本地服务共用）
// v2：并行扫描 / 仓库分页 / CI 趋势 / API 配额 / 许可证链接增量复用 / schema 2
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 置 SCAN_WITH_TRAFFIC=1 时额外拉取每仓近 14 天流量（views/clones，各 +1 次 REST 调用，需 push 权限）
const WITH_TRAFFIC = process.env.SCAN_WITH_TRAFFIC === "1";

/* ---------------- gh CLI 封装（同步 + 异步，均带 5xx/429/网络抖动重试） ---------------- */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function gh(args, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
    } catch (e) {
      const msg = String(e?.message ?? e);
      const transient = /HTTP 5\d\d|HTTP 429|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
      if (attempt < retries && transient) {
        const waitMs = 2000 * (attempt + 1);
        console.log("  ↻ GitHub API 暂时不可用，" + Math.round(waitMs / 1000) + " 秒后重试（第 " + (attempt + 1) + "/" + retries + " 次）…");
        sleepSync(waitMs);
        continue;
      }
      throw e;
    }
  }
}

export async function ghAsync(args, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await execFileP("gh", args, { maxBuffer: 64 * 1024 * 1024 });
      return stdout.trim();
    } catch (e) {
      const msg = String((e && e.message) || e);
      const transient = /HTTP 5\d\d|HTTP 429|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg);
      if (attempt < retries && transient) {
        const waitMs = 2000 * (attempt + 1);
        console.log("  ↻ GitHub API 暂时不可用，" + Math.round(waitMs / 1000) + " 秒后重试（第 " + (attempt + 1) + "/" + retries + " 次）…");
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
}

/* 简易并发池：items 上按 limit 并发跑 fn，保持结果顺序 */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* ---------------- 通用工具 ---------------- */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Rust: "#dea584",
  C: "#555555", "C++": "#f34b7d", "C#": "#178600", Java: "#b07219", Kotlin: "#A97BFF",
  Swift: "#F05138", Go: "#00ADD8", Shell: "#89e051", HTML: "#e34c26", CSS: "#563d7c",
  Vue: "#41b883", Dart: "#00B4AB", PowerShell: "#012456", Batchfile: "#C1F12E",
  Lua: "#000080", MDX: "#fcb32c", Dockerfile: "#384d54", "Jupyter Notebook": "#DA5B0B",
};

export function relTime(iso) {
  if (!iso) return "—";
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (days < 1 / 24) return Math.max(1, Math.round(days * 24 * 60)) + " 分钟前";
  if (days < 1) return Math.round(days * 24) + " 小时前";
  if (days < 30) return Math.round(days) + " 天前";
  if (days < 365) return Math.round(days / 30) + " 个月前";
  return (days / 365).toFixed(1) + " 年前";
}

export function fullTime(iso) {
  return iso ? new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
}

export function ciStateOf(run) {
  if (!run) return { label: "无 CI 记录", cls: "none" };
  if (run.status !== "completed") return { label: "运行中", cls: "running" };
  switch (run.conclusion) {
    case "success": return { label: "通过", cls: "ok" };
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required": return { label: "失败", cls: "fail" };
    case "cancelled": return { label: "已取消", cls: "none" };
    case "skipped":
    case "neutral": return { label: "跳过", cls: "none" };
    default: return { label: "未知", cls: "none" };
  }
}

/* ---------------- 仓库健康评分(0-100):CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15,归档仓打七折 ---------------- */
export function scoreOf(r) {
  if (!r) return 0;
  let ci;
  if (r.ci && r.ci.cls === "ok") {
    const t = r.ci.trend || [];
    const done = t.filter((x) => ["success", "failure", "timed_out", "startup_failure", "action_required"].includes(x.c));
    const okr = done.filter((x) => x.c === "success").length;
    const ratio = done.length ? okr / done.length : 1;
    ci = 25 + Math.round(15 * ratio);
  } else if (r.ci && r.ci.cls === "running") ci = 20;
  else if (r.ci && r.ci.cls === "none") ci = 15;
  else ci = 0;
  const days = r.pushedAt ? (Date.now() - new Date(r.pushedAt).getTime()) / 86400000 : Infinity;
  const fresh = days <= 7 ? 30 : days <= 30 ? 24 : days <= 90 ? 16 : days <= 365 ? 8 : 2;
  const n = r.openIssues == null ? 0 : r.openIssues;
  const hyg = n === 0 ? 15 : n <= 2 ? 12 : n <= 9 ? 8 : n <= 29 ? 4 : 0;
  const relDays = r.latestRelease && r.latestRelease.publishedAt
    ? (Date.now() - new Date(r.latestRelease.publishedAt).getTime()) / 86400000 : null;
  const rel = relDays == null ? (r.releases > 0 ? 5 : 3) : relDays <= 90 ? 15 : relDays <= 365 ? 9 : 5;
  let total = ci + fresh + hyg + rel;
  if (r.isArchived) total = Math.round(total * 0.7);
  return Math.max(0, Math.min(100, total));
}

export function gradeOf(score) {
  if (score >= 85) return { g: "A", cls: "ok" };
  if (score >= 70) return { g: "B", cls: "info" };
  if (score >= 50) return { g: "C", cls: "warn" };
  return { g: "D", cls: "fail" };
}

const QUERY_PAGE = /* GraphQL */ `
  query($owner: String!, $cursor: String) {
    user(login: $owner) {
      login
      avatarUrl(size: 96)
      repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          description
          url
          visibility
          isArchived
          isFork
          createdAt
          pushedAt
          stargazerCount
          forkCount
          primaryLanguage { name }
          licenseInfo { spdxId name }
          defaultBranchRef { name }
          issues(states: OPEN, first: 1) { totalCount }
          pullRequests(states: OPEN, first: 1) { totalCount }
          refs(refPrefix: "refs/heads/", first: 1) { totalCount }
          releases(first: 1) { totalCount }
          latestRelease { tagName name publishedAt url }
        }
      }
    }
  }`;

/* ---------------- 数据采集（分页 + 并行 + 增量） ---------------- */
export async function collectData(ownerArg) {
  const owner = ownerArg || gh(["api", "user", "--jq", ".login"]);
  console.log("▸ 账号：" + owner);

  // 1. GraphQL 分页拉仓库（每页 100，最多 5 页 = 500 个）
  let login = null;
  let avatarUrl = "";
  let totalCount = 0;
  const repos = [];
  let cursor = null;
  let pagesFetched = 0;
  for (let page = 0; page < 5; page++) {
    const ghArgs = ["api", "graphql", "-f", "query=" + QUERY_PAGE, "-F", "owner=" + owner];
    if (cursor) ghArgs.push("-F", "cursor=" + cursor);
    const res = JSON.parse(gh(ghArgs));
    if (res.errors?.length) throw new Error("GraphQL 错误：" + res.errors.map((e) => e.message).join("; "));
    const user = res.data?.user;
    if (!user) throw new Error("找不到账号 " + owner + "（本工具面向个人账号，组织账号需改用 organization 查询）");
    login = user.login;
    avatarUrl = user.avatarUrl;
    totalCount = user.repositories.totalCount;
    repos.push(...(user.repositories.nodes ?? []));
    pagesFetched++;
    if (!user.repositories.pageInfo.hasNextPage) { cursor = null; break; }
    cursor = user.repositories.pageInfo.endCursor;
  }
  const truncated = !!cursor;
  console.log("▸ 拉到 " + repos.length + " 个仓库（账号名下 " + totalCount + " 个，GraphQL " + pagesFetched + " 页" + (truncated ? "，超过 500 个已截断" : "") + "）");

  // 2. 上一次快照（用于许可证链接增量复用：pushedAt 未变 → LICENSE 文件未变）
  let prev = null;
  try { prev = JSON.parse(readFileSync(join(HERE, "scan-data.json"), "utf8")); } catch { /* 无快照则全量 */ }
  const prevByName = new Map(((prev && prev.rows) || []).map((r) => [r.name, r]));

  // 3. 并行补齐每仓数据：许可证链接 + 最近 5 次 CI 运行（趋势）
  console.log("▸ 并行拉取许可证与 CI 运行记录（并发 8）…");
  const rows = await pool(repos, 8, async (r) => {
    let licenseUrl = null;
    if (r.licenseInfo) {
      const p = prevByName.get(r.name);
      if (p && p.pushedAt === r.pushedAt && p.licenseUrl) {
        licenseUrl = p.licenseUrl; // 增量复用
      } else {
        try {
          licenseUrl = await ghAsync(["api", "repos/" + owner + "/" + r.name + "/license", "--jq", ".html_url"]);
        } catch { /* 根目录没有标准 LICENSE 文件，忽略 */ }
      }
    }

    let runs = [];
    try {
      runs = JSON.parse(await ghAsync(["api", "repos/" + owner + "/" + r.name + "/actions/runs?per_page=5"])).workflow_runs ?? [];
    } catch { /* Actions API 不可用时按无记录处理 */ }
    const run = runs[0] ?? null;
    const trend = runs.slice().reverse().map((x) => ({ s: x.status, c: x.conclusion, at: x.created_at })); // 旧 → 新

    let traffic = null;
    if (WITH_TRAFFIC) {
      try {
        const v = JSON.parse(await ghAsync(["api", "repos/" + owner + "/" + r.name + "/traffic/views"]));
        const c = JSON.parse(await ghAsync(["api", "repos/" + owner + "/" + r.name + "/traffic/clones"]));
        const sum = (arr, k) => (arr || []).reduce((a, x) => a + (x[k] || 0), 0);
        traffic = { views: sum(v.views, "count"), viewUniques: sum(v.views, "uniques"),
                    clones: sum(c.clones, "count"), cloneUniques: sum(c.clones, "uniques") };
      } catch { /* 无权限或无数据时留空 */ }
    }

    const state = ciStateOf(run);
    const lic = r.licenseInfo;
    return {
      name: r.name,
      url: r.url,
      description: r.description ?? "",
      visibility: r.visibility,
      isArchived: !!r.isArchived,
      isFork: !!r.isFork,
      createdAt: r.createdAt,
      pushedAt: r.pushedAt,
      stars: r.stargazerCount,
      forks: r.forkCount,
      openIssues: r.issues?.totalCount ?? 0,
      openPRs: r.pullRequests?.totalCount ?? 0,
      branches: r.refs?.totalCount ?? 0,
      defaultBranch: r.defaultBranchRef?.name ?? "—",
      license: lic ? (lic.spdxId && lic.spdxId !== "NOASSERTION" ? lic.spdxId : lic.name) : null,
      licenseUrl,
      releases: r.releases?.totalCount ?? 0,
      latestRelease: r.latestRelease
        ? { tag: r.latestRelease.tagName, name: r.latestRelease.name, publishedAt: r.latestRelease.publishedAt, url: r.latestRelease.url }
        : null,
      ci: {
        state: state.label,
        cls: state.cls,
        workflow: run?.name ?? null,
        ref: run?.head_branch ?? null,
        ranAt: run?.created_at ?? null,
        url: run?.html_url ?? null,
        trend,
      },
      language: r.primaryLanguage?.name ?? null,
      langColor: LANG_COLORS[r.primaryLanguage?.name ?? ""] ?? "#8b949e",
      traffic,
    };
  });

  // 4. API 配额（rate_limit 接口本身不消耗配额）
  let rate = null;
  try {
    rate = JSON.parse(gh(["api", "rate_limit", "--jq", ".resources.core"]));
  } catch { /* 拿不到就隐藏展示 */ }

  const totals = {
    repos: rows.length,
    totalRepos: totalCount,
    stars: rows.reduce((a, r) => a + r.stars, 0),
    forks: rows.reduce((a, r) => a + r.forks, 0),
    openIssues: rows.reduce((a, r) => a + r.openIssues, 0),
    openPRs: rows.reduce((a, r) => a + r.openPRs, 0),
    releases: rows.reduce((a, r) => a + r.releases, 0),
    ciDone: rows.filter((x) => ["ok", "fail"].includes(x.ci.cls)).length,
    ciOk: rows.filter((x) => x.ci.cls === "ok").length,
  };

  return { schema: 2, owner: login, avatarUrl, scannedAt: new Date().toISOString(), truncated, rate, totals, rows };
}

/* ---------------- 产物输出 ---------------- */
export function writeOutputs(data) {
  writeFileSync(join(HERE, "scan-data.json"), JSON.stringify(data, null, 2), "utf8");
  writeFileSync(join(HERE, "dashboard.html"), renderDashboard(data), "utf8");
}

export function printSummary(data) {
  const t = data.totals;
  console.log("✔ 扫描完成：" + t.repos + " 个仓库 · ★ " + t.stars + " · Fork " + t.forks + " · 开放 Issue " + t.openIssues + "（另有 PR " + t.openPRs + "） · 发布 " + t.releases + " · CI 通过 " + t.ciOk + "/" + t.ciDone);
  for (const r of data.rows) {
    console.log("   " + r.name.padEnd(24) + " CI:" + r.ci.state.padEnd(6) + " 许可:" + (r.license ?? "未声明").padEnd(12) + " Release:" + (r.latestRelease ? r.latestRelease.tag : "—").padEnd(14) + " 分支:" + r.defaultBranch + "/" + r.branches + "  ★" + r.stars);
  }
  if (data.rate) console.log("▸ GitHub API 余量：" + data.rate.remaining + "/" + data.rate.limit);
  console.log("▸ 面板：" + join(HERE, "dashboard.html"));
  console.log("▸ 快照：" + join(HERE, "scan-data.json") + "（schema " + (data.schema ?? 1) + "）");
}

/* ---------------- 面板渲染（内嵌数据 + 筛选搜索 + 排序 + 主题 + 扫描 + 趋势 + 配额） ---------------- */
export function renderDashboard(data) {
  const jsonStr = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub 仓库总览</title>
<style>
  :root, :root[data-theme="dark"] {
    --bg:#0d1117; --panel:#161b22; --border:#30363d; --rowborder:#21262d;
    --text:#e6edf3; --text2:#c9d1d9; --muted:#8b949e; --accent:#58a6ff;
    --ok:#3fb950; --fail:#f85149; --warn:#d29922; --hover:#151b23;
    color-scheme: dark;
  }
  :root[data-theme="light"] {
    --bg:#ffffff; --panel:#f6f8fa; --border:#d0d7de; --rowborder:#d8dee4;
    --text:#1f2328; --text2:#424a53; --muted:#656d76; --accent:#0969da;
    --ok:#1a7f37; --fail:#cf222e; --warn:#9a6700; --hover:#f6f8fa;
    color-scheme: light;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { background: var(--bg); }
  body {
    background: var(--bg); color: var(--text2);
    font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 14px; line-height: 1.55; -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 1320px; margin: 0 auto; padding: 36px 28px 56px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
  a.sub { color: var(--muted); }
  a.sub:hover { color: var(--accent); }

  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header img { width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--border); }
  h1 { font-size: 22px; font-weight: 600; color: var(--text); letter-spacing: .01em; }
  .scan-meta { font-size: 12.5px; color: var(--muted); margin-top: 3px; }
  .controls { margin-left: auto; display: flex; gap: 10px; align-items: center; }
  .btn {
    display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px;
    border: 1px solid var(--border); border-radius: 6px; background: var(--panel);
    color: var(--text2); cursor: pointer; font-size: 13px; font-family: inherit;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { border-color: rgba(63,185,80,.55); }
  .btn.primary:hover { border-color: var(--ok); color: var(--ok); }
  .btn.icon { padding: 7px 9px; }
  .btn.scanning { opacity: .6; cursor: progress; }
  .btn.scanning .ico { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hint { min-height: 20px; font-size: 12.5px; color: var(--muted); margin-top: 12px; }
  .hint.okc { color: var(--ok); }
  .hint.err { color: var(--fail); }

  .metrics { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0 20px; }
  .metric { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 20px; min-width: 118px; }
  .metric .v { font-size: 22px; font-weight: 600; color: var(--text); }
  .metric .vsub { font-size: 13px; font-weight: 400; color: var(--muted); }
  .metric .k { font-size: 12px; color: var(--muted); margin-top: 2px; }

  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 0 0 14px; }
  .toolbar input[type="search"], .toolbar select {
    background: var(--panel); border: 1px solid var(--border); color: var(--text2);
    border-radius: 6px; padding: 6px 10px; font-size: 13px; font-family: inherit;
  }
  .toolbar input[type="search"] { min-width: 230px; }
  .toolbar input:focus, .toolbar select:focus { outline: none; border-color: var(--accent); }
  .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); cursor: pointer; }
  .chk input { accent-color: var(--accent); }
  .views-box { display: inline-flex; gap: 6px; align-items: center; }
  .views-box select {
    background: var(--panel); border: 1px solid var(--border); color: var(--text2);
    border-radius: 6px; padding: 6px 10px; font-size: 13px; font-family: inherit; max-width: 190px;
  }
  .badge.info { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .badge.info .dot { background: var(--accent); }
  .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 8%, transparent); }
  .badge.warn .dot { background: var(--warn); }
  .toolbar .spacer { flex: 1; }

  .scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
  table { width: 100%; border-collapse: collapse; min-width: 1340px; }
  thead th {
    position: sticky; top: 0; background: var(--panel); color: var(--muted);
    font-size: 12px; font-weight: 600; letter-spacing: .05em; text-align: left;
    padding: 11px 14px; border-bottom: 1px solid var(--border); white-space: nowrap;
  }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--accent); }
  th.sortable.active { color: var(--text); }
  th .arr { margin-left: 3px; font-size: 10px; }
  tbody td { padding: 12px 14px; border-top: 1px solid var(--rowborder); vertical-align: top; }
  tbody tr:hover { background: var(--hover); }
  tbody tr:first-child td { border-top: none; }
  td.empty { text-align: center; color: var(--muted); padding: 40px 0; }
  td.repo { min-width: 260px; max-width: 380px; }
  .repo-name { font-weight: 600; font-size: 14.5px; }
  .desc {
    font-size: 12px; color: var(--muted); margin-top: 3px;
    max-width: 340px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .tag {
    display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px;
    font-size: 11px; border: 1px solid var(--border); color: var(--muted); vertical-align: 2px;
  }
  .tag.warn { color: var(--warn); border-color: var(--warn); }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px;
    border-radius: 999px; font-size: 12px; border: 1px solid var(--border);
    color: var(--muted); white-space: nowrap;
  }
  a.badge:hover { text-decoration: none; filter: brightness(1.15); }
  .badge .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); }
  .badge.ok .dot { background: var(--ok); }
  .badge.fail { color: var(--fail); border-color: color-mix(in srgb, var(--fail) 45%, transparent); background: color-mix(in srgb, var(--fail) 8%, transparent); }
  .badge.fail .dot { background: var(--fail); }
  .badge.running { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 8%, transparent); }
  .badge.running .dot { background: var(--warn); }
  .trend { display: inline-flex; gap: 3px; margin-top: 5px; }
  .tdot { width: 7px; height: 7px; border-radius: 50%; background: var(--border); display: inline-block; }
  .tdot.ok { background: var(--ok); }
  .tdot.fail { background: var(--fail); }
  .tdot.run { background: var(--warn); }
  .pair { display: flex; flex-direction: column; gap: 3px; }
  .pair a { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); }
  .pair a:hover { color: var(--accent); text-decoration: none; }
  .lang { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .ldot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  td.num { white-space: nowrap; }
  .notice { font-size: 12.5px; color: var(--warn); margin: 0 0 14px; }
  footer { margin-top: 18px; font-size: 12px; color: var(--muted); line-height: 1.8; }
  footer code { font-family: Consolas, "Cascadia Mono", monospace; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; }
  #footExtra strong { color: var(--text2); font-weight: 600; }
</style>
</head>
<body>
<div class="container">
  <header>
    <img id="avatar" alt="" style="display:none">
    <div>
      <h1 id="title">GitHub 仓库总览</h1>
      <div class="scan-meta" id="scanMeta">正在载入数据…</div>
    </div>
    <div class="controls">
      <button id="scanBtn" class="btn primary" type="button" title="重新扫描并刷新本页数据（需本地服务已启动：node server.mjs）"><span class="ico"></span><span class="lbl">重新扫描</span></button>
      <button id="themeBtn" class="btn icon" type="button" title="切换明暗主题" aria-label="切换明暗主题"></button>
    </div>
  </header>
  <div class="hint" id="scanHint"></div>

  <div class="metrics" id="metrics"></div>

  <div class="toolbar">
    <input id="q" type="search" placeholder="搜索仓库名 / 描述…">
    <select id="fLang" title="按语言筛选"><option value="">全部语言</option></select>
    <select id="fStatus" title="按状态筛选">
      <option value="">全部状态</option>
      <option value="ok">CI 通过</option>
      <option value="fail">CI 失败</option>
      <option value="running">CI 运行中</option>
      <option value="none">无 CI 记录</option>
      <option value="hasIssue">有开放 Issue</option>
      <option value="noLic">未声明许可证</option>
    </select>
    <label class="chk"><input type="checkbox" id="fNoFork">隐藏 fork</label>
    <span class="spacer"></span>
    <span class="views-box">
      <select id="fView" title="自定义视图 = 当前搜索/筛选/排序的命名快照"><option value="">视图:手动状态</option></select>
      <button id="viewSave" class="btn" type="button" title="把当前筛选与排序保存为命名视图">＋存视图</button>
      <button id="viewDel" class="btn" type="button" title="删除当前选中的视图">删</button>
    </span>
    <label class="chk">自动刷新
      <select id="auto" title="定时自动重新扫描（消耗 GitHub API 配额）">
        <option value="0">关闭</option>
        <option value="10">每 10 分钟</option>
        <option value="30">每 30 分钟</option>
        <option value="60">每 60 分钟</option>
      </select>
    </label>
  </div>

  <div class="notice" id="truncNotice" style="display:none"></div>

  <div class="scroll">
    <table>
      <thead>
        <tr>
          <th class="sortable" data-key="name" title="点击按仓库名排序">仓库<span class="arr" data-arr="name"></span></th>
          <th class="sortable" data-key="score" title="健康分 = CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15(归档仓打七折)">健康<span class="arr" data-arr="score"></span></th>
          <th class="sortable" data-key="ci" title="点击按 CI 状态排序（降序 = 问题优先）">CI/CD 状态<span class="arr" data-arr="ci"></span></th>
          <th class="sortable" data-key="license" title="点击按许可证排序">许可证<span class="arr" data-arr="license"></span></th>
          <th class="sortable" data-key="release" title="点击按最新发布时间排序">最新 Release<span class="arr" data-arr="release"></span></th>
          <th class="sortable" data-key="issues" title="点击按开放 Issue 数排序">Issue<span class="arr" data-arr="issues"></span></th>
          <th class="sortable" data-key="branches" title="点击按分支数排序">分支<span class="arr" data-arr="branches"></span></th>
          <th class="sortable" data-key="stars" title="点击按 Star 数排序">Star<span class="arr" data-arr="stars"></span></th>
          <th class="sortable" data-key="forks" title="点击按 Fork 数排序">Fork<span class="arr" data-arr="forks"></span></th>
          <th class="sortable" data-key="language" title="点击按语言排序">语言<span class="arr" data-arr="language"></span></th>
          <th class="sortable" data-key="traffic" title="点击按近 14 天浏览量排序(设 SCAN_WITH_TRAFFIC=1 开启采集)">流量<span class="arr" data-arr="traffic"></span></th>
          <th class="sortable" data-key="pushedAt" title="点击按最近推送排序">最近推送<span class="arr" data-arr="pushedAt"></span></th>
        </tr>
      </thead>
      <tbody id="tbody"><tr><td class="empty" colspan="12">正在载入…</td></tr></tbody>
    </table>
  </div>

  <footer>
    <div id="footExtra"></div>
    数据为扫描时快照：页面内点「重新扫描」可原地更新（需启动本地服务 <code>node server.mjs</code>），或命令行 <code>node scan.mjs</code>（<code>--render-only</code> 仅重渲染）·
    排序：点击表头，再点一次切换升降序（选择会记住）· 健康分：CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15 · 视图：「＋存视图」保存当前筛选与排序 · 主题：右上角切换（默认浅色）·
    CI 取最近一次 Actions 运行（任意分支/标签）· Issue 数不含 PR（PR 单列）· 分支数为全部本地分支（不含 tag）·
    表格内每个单元格都链接到对应的 GitHub 页面。
  </footer>
</div>

<script>
window.__SCAN_DATA__ = ${jsonStr};
</script>
<script>
(function () {
  'use strict';

  var SVG_STAR = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>';
  var SVG_FORK = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/></svg>';
  var SVG_SUN = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-1.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 1 1-1.06 1.06l-1.06-1.06a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 1 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM16 8a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 16 8ZM3 8a.75.75 0 0 1-.75.75H.75a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 3 8Zm10.657-5.657a.75.75 0 0 1 0 1.061l-1.06 1.06a.75.75 0 1 1-1.061-1.06l1.06-1.06a.75.75 0 0 1 1.061 0ZM4.464 11.536a.75.75 0 0 1 0 1.06l-1.06 1.061a.75.75 0 0 1-1.061-1.06l1.06-1.061a.75.75 0 0 1 1.061 0Z"/></svg>';
  var SVG_MOON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/></svg>';
  var SVG_SYNC = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>';

  var THEME_KEY = 'grs-theme';
  var AUTO_KEY = 'grs-auto';
  var SORT_KEY = 'grs-sort';
  var state = { data: null, sortKey: 'pushedAt', sortDir: 'desc', scanning: false, q: '', fLang: '', fStatus: '', noFork: false };
  var VIEWS_KEY = 'ghscan.views.v1';
  var viewState = { views: {}, current: '' };
  try { viewState.views = JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}') || {}; } catch (e) { viewState.views = {}; }
  var autoTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function relTime(iso) {
    if (!iso) return '—';
    var days = (Date.now() - new Date(iso).getTime()) / 86400000;
    if (days < 1 / 24) return Math.max(1, Math.round(days * 24 * 60)) + ' 分钟前';
    if (days < 1) return Math.round(days * 24) + ' 小时前';
    if (days < 30) return Math.round(days) + ' 天前';
    if (days < 365) return Math.round(days / 30) + ' 个月前';
    return (days / 365).toFixed(1) + ' 年前';
  }
  function fullTime(iso) {
    return iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
  }

  /* ---------- 主题 ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    var b = document.getElementById('themeBtn');
    if (b) { b.innerHTML = t === 'dark' ? SVG_SUN : SVG_MOON; b.title = t === 'dark' ? '切换到亮色主题' : '切换到暗色主题'; }
  }

  /* ---------- 健康评分(与 scan-core.mjs 导出的 scoreOf/gradeOf 同款实现) ---------- */
  function scoreOf(r) {
    if (!r) return 0;
    var ci;
    if (r.ci && r.ci.cls === 'ok') {
      var tr = (r.ci.trend || []);
      var done = tr.filter(function (x) { return ['success', 'failure', 'timed_out', 'startup_failure', 'action_required'].indexOf(x.c) >= 0; });
      var okr = done.filter(function (x) { return x.c === 'success'; }).length;
      var ratio = done.length ? okr / done.length : 1;
      ci = 25 + Math.round(15 * ratio);
    } else if (r.ci && r.ci.cls === 'running') ci = 20;
    else if (r.ci && r.ci.cls === 'none') ci = 15;
    else ci = 0;
    var days = r.pushedAt ? (Date.now() - new Date(r.pushedAt).getTime()) / 86400000 : Infinity;
    var fresh = days <= 7 ? 30 : days <= 30 ? 24 : days <= 90 ? 16 : days <= 365 ? 8 : 2;
    var n = r.openIssues == null ? 0 : r.openIssues;
    var hyg = n === 0 ? 15 : n <= 2 ? 12 : n <= 9 ? 8 : n <= 29 ? 4 : 0;
    var relDays = (r.latestRelease && r.latestRelease.publishedAt)
      ? (Date.now() - new Date(r.latestRelease.publishedAt).getTime()) / 86400000 : null;
    var rel = relDays == null ? ((r.releases || 0) > 0 ? 5 : 3) : (relDays <= 90 ? 15 : relDays <= 365 ? 9 : 5);
    var total = ci + fresh + hyg + rel;
    if (r.isArchived) total = Math.round(total * 0.7);
    return Math.max(0, Math.min(100, total));
  }
  function gradeOf(score) {
    if (score >= 85) return { g: 'A', cls: 'ok' };
    if (score >= 70) return { g: 'B', cls: 'info' };
    if (score >= 50) return { g: 'C', cls: 'warn' };
    return { g: 'D', cls: 'fail' };
  }

  /* ---------- 排序 ---------- */
  var SORT_VAL = {
    name: function (r) { return r.name; },
    ci: function (r) { return { fail: 3, running: 2, ok: 1, none: 0 }[r.ci.cls] || 0; },
    license: function (r) { return r.license ? r.license.toLowerCase() : null; },
    release: function (r) { return r.latestRelease && r.latestRelease.publishedAt ? r.latestRelease.publishedAt : null; },
    issues: function (r) { return r.openIssues; },
    branches: function (r) { return r.branches; },
    stars: function (r) { return r.stars; },
    forks: function (r) { return r.forks; },
    language: function (r) { return r.language ? r.language.toLowerCase() : null; },
    pushedAt: function (r) { return r.pushedAt; },
    score: function (r) { return scoreOf(r); },
    traffic: function (r) { return r.traffic ? r.traffic.views : null; }
  };
  var ASC_DEFAULT = { name: true, license: true, language: true };

  function saveSort() {
    try { localStorage.setItem(SORT_KEY, JSON.stringify({ k: state.sortKey, d: state.sortDir })); } catch (e) {}
  }
  function loadSort() {
    try {
      var ss = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
      if (ss && SORT_VAL[ss.k]) {
        state.sortKey = ss.k;
        state.sortDir = ss.d === 'asc' ? 'asc' : 'desc';
      }
    } catch (e) {}
  }

  /* ---------- 筛选 ---------- */
  function matchFilters(r) {
    if (state.noFork && r.isFork) return false;
    if (state.fStatus === 'ok' && r.ci.cls !== 'ok') return false;
    if (state.fStatus === 'fail' && r.ci.cls !== 'fail') return false;
    if (state.fStatus === 'running' && r.ci.cls !== 'running') return false;
    if (state.fStatus === 'none' && r.ci.cls !== 'none') return false;
    if (state.fStatus === 'hasIssue' && r.openIssues <= 0) return false;
    if (state.fStatus === 'noLic' && r.license) return false;
    if (state.fLang && r.language !== state.fLang) return false;
    if (state.q) {
      var qq = state.q.toLowerCase();
      var hay = (r.name + ' ' + (r.description || '')).toLowerCase();
      if (hay.indexOf(qq) === -1) return false;
    }
    return true;
  }

  function rebuildLangOptions() {
    var sel = document.getElementById('fLang');
    var langs = {};
    state.data.rows.forEach(function (r) { if (r.language) langs[r.language] = true; });
    var names = Object.keys(langs).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    var cur = sel.value || state.fLang;
    var html = '<option value="">全部语言</option>';
    for (var i = 0; i < names.length; i++) html += '<option value="' + esc(names[i]) + '">' + esc(names[i]) + '</option>';
    sel.innerHTML = html;
    if (cur && names.indexOf(cur) >= 0) { sel.value = cur; state.fLang = cur; }
    else { state.fLang = ''; }
  }

  function visibleRows() {
    return currentRows().filter(matchFilters);
  }

  function currentRows() {
    var rows = state.data.rows.slice();
    var val = SORT_VAL[state.sortKey] || SORT_VAL.pushedAt;
    var dir = state.sortDir === 'asc' ? 1 : -1;
    rows.sort(function (a, b) {
      var va = val(a), vb = val(b);
      var an = va == null || va === '', bn = vb == null || vb === '';
      if (an && bn) return 0;
      if (an) return 1;   // 空值恒沉底
      if (bn) return -1;
      if (typeof va === 'string') return va.localeCompare(String(vb), 'zh-CN') * dir;
      return (va - vb) * dir;
    });
    return rows;
  }

  function updateArr() {
    var ths = document.querySelectorAll('th.sortable');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i], k = th.getAttribute('data-key');
      th.classList.toggle('active', k === state.sortKey);
      var arr = th.querySelector('.arr');
      if (arr) arr.textContent = k === state.sortKey ? (state.sortDir === 'desc' ? '▼' : '▲') : '';
    }
  }

  /* ---------- 渲染 ---------- */
  function metric(v, k) {
    return '<div class="metric"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
  }

  function trendDots(r) {
    var t = (r.ci && r.ci.trend) || [];
    if (!t.length) return '';
    var out = '<span class="trend">';
    for (var i = 0; i < t.length; i++) {
      var x = t[i];
      var cls = '';
      if (x.c === 'success') cls = 'ok';
      else if (x.c === 'failure' || x.c === 'timed_out' || x.c === 'startup_failure' || x.c === 'action_required') cls = 'fail';
      else if (x.s && x.s !== 'completed') cls = 'run';
      out += '<span class="tdot ' + cls + '" title="' + esc(fullTime(x.at)) + ' · ' + esc(x.c == null ? (x.s || '未知') : x.c) + '"></span>';
    }
    return out + '</span>';
  }

  function ciCell(r) {
    var ci = r.ci;
    if (!ci.url) return '<span class="badge ' + ci.cls + '"><span class="dot"></span>' + esc(ci.state) + '</span>' + trendDots(r);
    var tip = '最近一次运行：' + (ci.workflow || '未知工作流') + (ci.ref ? '（' + ci.ref + '）' : '') + (ci.ranAt ? ' · ' + fullTime(ci.ranAt) : '');
    var sub = [ci.workflow, ci.ref ? '@' + ci.ref : '', ci.ranAt ? relTime(ci.ranAt) : ''].filter(Boolean).join(' · ');
    return '<a class="badge ' + ci.cls + '" href="' + esc(ci.url) + '" target="_blank" rel="noopener" title="' + esc(tip) + '"><span class="dot"></span>' + esc(ci.state) + '</a><div class="sub">' + esc(sub) + '</div>' + trendDots(r);
  }

  function scoreCell(r) {
    var s = scoreOf(r), g = gradeOf(s);
    var tip = 'CI ' + (r.ci ? r.ci.state : '?') + ' · 最近推送 ' + relTime(r.pushedAt) + ' · 开放 Issue ' + (r.openIssues || 0) + ' · 健康分 = CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15' + (r.isArchived ? '(归档仓七折)' : '');
    return '<span class="badge ' + g.cls + '" title="' + esc(tip) + '"><span class="dot"></span>' + s + ' · ' + g.g + '</span>';
  }
  function trafficCell(r) {
    var t = r.traffic;
    if (!t) return '<a class="muted" href="' + esc(r.url) + '/graphs/traffic" target="_blank" rel="noopener" title="未采集流量:设环境变量 SCAN_WITH_TRAFFIC=1 后重新扫描">—</a>';
    return '<a class="muted" href="' + esc(r.url) + '/graphs/traffic" target="_blank" rel="noopener" title="近 14 天:' + t.viewUniques + ' 位访客 · ' + t.cloneUniques + ' 人克隆">' + t.views + ' 浏览 · ' + t.clones + ' 克隆</a>';
  }

  function rowHtml(r) {
    var tags =
      (r.visibility && r.visibility !== 'PUBLIC' ? '<span class="tag warn">私有</span>' : '') +
      (r.isArchived ? '<span class="tag">已归档</span>' : '') +
      (r.isFork ? '<span class="tag">fork</span>' : '');
    var lic = r.license
      ? (r.licenseUrl
          ? '<a href="' + esc(r.licenseUrl) + '" target="_blank" rel="noopener" title="打开 LICENSE 文件">' + esc(r.license) + '</a>'
          : '<span class="muted" title="未在根目录检测到标准 LICENSE 文件">' + esc(r.license) + '</span>')
      : '<span class="muted">未声明</span>';
    var rel = r.latestRelease
      ? '<a href="' + esc(r.latestRelease.url) + '" target="_blank" rel="noopener" title="' + esc(fullTime(r.latestRelease.publishedAt)) + '">' + esc(r.latestRelease.tag) + '</a><div class="sub">' + esc(((r.latestRelease.name && r.latestRelease.name !== r.latestRelease.tag) ? r.latestRelease.name + ' · ' : '') + (r.latestRelease.publishedAt ? relTime(r.latestRelease.publishedAt) : '')) + '</div>'
      : '<a class="muted" href="' + esc(r.url) + '/releases" target="_blank" rel="noopener">暂无发布</a>';
    var issue = '<a href="' + esc(r.url) + '/issues" target="_blank" rel="noopener" title="打开 Issues 页">' + r.openIssues + ' 个</a>' +
      (r.openPRs > 0 ? ' <a class="sub" href="' + esc(r.url) + '/pulls" target="_blank" rel="noopener" title="打开 Pull requests 页">+' + r.openPRs + ' PR</a>' : '');
    var branch = '<a href="' + esc(r.url) + '/branches" target="_blank" rel="noopener" title="打开 Branches 页">' + esc(r.defaultBranch) + ' · ' + r.branches + ' 个</a>';
    var star = '<a href="' + esc(r.url) + '/stargazers" target="_blank" rel="noopener" title="打开 Stargazers 页">' + SVG_STAR + ' ' + r.stars + '</a>';
    var fork = '<a href="' + esc(r.url) + '/forks" target="_blank" rel="noopener" title="打开 Forks 页">' + SVG_FORK + ' ' + r.forks + '</a>';
    return '<tr>' +
      '<td class="repo"><a class="repo-name" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name) + '</a>' + tags + '<div class="desc" title="' + esc(r.description) + '">' + esc(r.description || '无描述') + '</div></td>' +
      '<td>' + scoreCell(r) + '</td>' +
      '<td>' + ciCell(r) + '</td>' +
      '<td>' + lic + '</td>' +
      '<td>' + rel + '</td>' +
      '<td class="num">' + issue + '</td>' +
      '<td>' + branch + '</td>' +
      '<td class="num">' + star + '</td>' +
      '<td class="num">' + fork + '</td>' +
      '<td><span class="lang"><span class="ldot" style="background:' + esc(r.langColor) + '"></span>' + esc(r.language || '—') + '</span></td>' +
      '<td class="num">' + trafficCell(r) + '</td>' +
      '<td class="num"><span title="' + esc(fullTime(r.pushedAt)) + '">' + esc(relTime(r.pushedAt)) + '</span></td>' +
      '</tr>';
  }

  function render() {
    var d = state.data;
    if (!d) {
      document.getElementById('scanMeta').textContent = '尚未扫描';
      document.getElementById('metrics').innerHTML = '';
      document.getElementById('tbody').innerHTML = '<tr><td class="empty" colspan="12">暂无数据 —— 点击右上角「重新扫描」开始第一次扫描（需已启动 node server.mjs）</td></tr>';
      return;
    }
    var avatar = document.getElementById('avatar');
    if (d.avatarUrl) { avatar.src = d.avatarUrl; avatar.style.display = ''; }
    document.getElementById('title').textContent = d.owner + ' · GitHub 仓库总览';
    document.getElementById('scanMeta').textContent = '扫描时间 ' + fullTime(d.scannedAt) + ' · 共 ' + d.totals.repos + ' 个仓库（账号名下 ' + d.totals.totalRepos + ' 个） · 数据源 gh api（GraphQL + REST）';
    var t = d.totals;
    document.getElementById('metrics').innerHTML =
      metric(t.repos, '仓库') +
      metric(t.stars, 'Star 合计') +
      metric(t.forks, 'Fork 合计') +
      metric(t.openIssues + '<span class="vsub"> +' + t.openPRs + ' PR</span>', '开放 Issue') +
      metric(t.releases, '发布合计') +
      metric(t.ciOk + '<span class="vsub">/' + t.ciDone + '</span>', 'CI 通过 / 有记录') +
      metric(function () { var s = 0, n = d.rows.length || 1; for (var i = 0; i < d.rows.length; i++) s += scoreOf(d.rows[i]); return Math.round(s / n); }(), '平均健康分');

    rebuildLangOptions();

    var rows = visibleRows();
    document.getElementById('tbody').innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<tr><td class="empty" colspan="12">没有匹配的仓库 —— 试试清空搜索或放宽筛选条件</td></tr>';

    var extra = [];
    if (d.rate && typeof d.rate.remaining === 'number') {
      extra.push('GitHub API 余量 <strong>' + d.rate.remaining + '/' + d.rate.limit + '</strong>，' + esc(fullTime(new Date(d.rate.reset * 1000).toISOString())) + ' 重置');
    }
    if (d.truncated) extra.push('仓库超过 500 个，仅显示最近推送的前 500 个');
    document.getElementById('footExtra').innerHTML = extra.length ? extra.join(' · ') : '';
  }

  /* ---------- 扫描更新 ---------- */
  function setHint(text, cls) {
    var h = document.getElementById('scanHint');
    h.textContent = text;
    h.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function doScan() {
    if (state.scanning) return;
    state.scanning = true;
    var btn = document.getElementById('scanBtn');
    btn.classList.add('scanning');
    btn.querySelector('.lbl').textContent = '扫描中…';
    setHint('正在通过 gh api 并行拉取数据（GraphQL 分页 + REST，约 5–15 秒）…');
    fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'HTTP 错误');
        state.data = j.data;
        updateArr();
        render();
        setHint('已更新：' + fullTime(state.data.scannedAt) + ' · dashboard.html 与 scan-data.json 已同步写入磁盘', 'okc');
      })
      .catch(function (e) {
        var m = String((e && e.message) || e);
        if (/failed to fetch|networkerror|load failed|fetch failed/i.test(m)) {
          m = '未检测到本地服务：请在项目文件夹运行 node server.mjs 启动后重试（或用 node scan.mjs 命令行刷新静态快照）';
        } else if (location.protocol.indexOf('http') === 0 && !/^(127\\.0\\.0\\.1|localhost)$/.test(location.hostname)) {
          m = '静态托管页面无法扫描（没有本地服务）：请在本地运行 node server.mjs 后使用，或直接浏览内嵌快照';
        }
        setHint('扫描失败：' + m, 'err');
      })
      .then(function () {
        state.scanning = false;
        btn.classList.remove('scanning');
        btn.querySelector('.lbl').textContent = '重新扫描';
      });
  }

  /* ---------- 自动刷新 ---------- */
  function applyAuto(silent) {
    var mins = parseInt(document.getElementById('auto').value, 10) || 0;
    try { localStorage.setItem(AUTO_KEY, String(mins)); } catch (e) {}
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (mins > 0) {
      autoTimer = setInterval(function () { if (!state.scanning) doScan(); }, mins * 60000);
      if (!silent) setHint('自动刷新已开启：每 ' + mins + ' 分钟扫描一次（每次消耗约 ' + '30–40 个 GitHub API 调用）', 'okc');
    }
  }

  /* ---------- 自定义视图 ---------- */
  function saveViews() { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(viewState.views)); } catch (e) {} }
  function rebuildViewOptions() {
    var sel = document.getElementById('fView');
    var names = Object.keys(viewState.views).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    var html = '<option value="">视图:手动状态</option>';
    for (var i = 0; i < names.length; i++) html += '<option value="' + esc(names[i]) + '">' + esc(names[i]) + '</option>';
    sel.innerHTML = html;
    if (viewState.current && viewState.views[viewState.current]) sel.value = viewState.current;
    else viewState.current = '';
  }
  function captureView() {
    return { q: state.q, fLang: state.fLang, fStatus: state.fStatus, noFork: state.noFork, sortKey: state.sortKey, sortDir: state.sortDir };
  }
  function applyView(v) {
    state.q = v.q || ''; document.getElementById('q').value = state.q;
    state.fLang = v.fLang || ''; document.getElementById('fLang').value = state.fLang;
    state.fStatus = v.fStatus || ''; document.getElementById('fStatus').value = state.fStatus;
    state.noFork = !!v.noFork; document.getElementById('fNoFork').checked = state.noFork;
    state.sortKey = SORT_VAL[v.sortKey] ? v.sortKey : 'pushedAt';
    state.sortDir = v.sortDir === 'asc' ? 'asc' : 'desc';
    saveSort(); updateArr(); rebuildLangOptions(); render();
  }

  /* ---------- 启动 ---------- */
  function boot() {
    var saved = 'light';
    try { saved = localStorage.getItem(THEME_KEY) || 'light'; } catch (e) {}
    applyTheme(saved);

    document.getElementById('scanBtn').querySelector('.ico').innerHTML = SVG_SYNC;
    document.getElementById('scanBtn').addEventListener('click', doScan);
    document.getElementById('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });

    var qEl = document.getElementById('q');
    qEl.addEventListener('input', function () { state.q = qEl.value.trim(); render(); });
    var fl = document.getElementById('fLang');
    fl.addEventListener('change', function () { state.fLang = fl.value; render(); });
    var fs = document.getElementById('fStatus');
    fs.addEventListener('change', function () { state.fStatus = fs.value; render(); });
    var nf = document.getElementById('fNoFork');
    nf.addEventListener('change', function () { state.noFork = nf.checked; render(); });
    var au = document.getElementById('auto');
    au.addEventListener('change', function () { applyAuto(false); });
    var savedAuto = '0';
    try { savedAuto = localStorage.getItem(AUTO_KEY) || '0'; } catch (e) {}
    if (['10', '30', '60'].indexOf(savedAuto) >= 0) au.value = savedAuto;
    applyAuto(true);

    rebuildViewOptions();
    document.getElementById('fView').addEventListener('change', function () {
      var name = this.value;
      viewState.current = name;
      if (name && viewState.views[name]) applyView(viewState.views[name]);
    });
    document.getElementById('viewSave').addEventListener('click', function () {
      var name = prompt('视图名称(保存当前搜索/筛选/排序):', viewState.current || '');
      if (!name) return;
      viewState.views[name] = captureView();
      viewState.current = name;
      saveViews(); rebuildViewOptions();
      setHint('已保存视图「' + name + '」(共 ' + Object.keys(viewState.views).length + ' 个视图)', 'okc');
    });
    document.getElementById('viewDel').addEventListener('click', function () {
      if (!viewState.current || !viewState.views[viewState.current]) { setHint('先在下拉框选中要删除的视图', 'err'); return; }
      delete viewState.views[viewState.current];
      viewState.current = '';
      saveViews(); rebuildViewOptions();
      setHint('已删除视图', 'okc');
    });

    var ths = document.querySelectorAll('th.sortable');
    for (var i = 0; i < ths.length; i++) {
      (function (th) {
        th.addEventListener('click', function () {
          var k = th.getAttribute('data-key');
          if (state.sortKey === k) {
            state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
          } else {
            state.sortKey = k;
            state.sortDir = ASC_DEFAULT[k] ? 'asc' : 'desc';
          }
          saveSort();
          updateArr();
          render();
        });
      })(ths[i]);
    }

    loadSort();
    updateArr();
    var embedded = window.__SCAN_DATA__ || null;
    if (embedded) { state.data = embedded; render(); }
    else { render(); }
    // 有本地服务时，用服务的最新快照覆盖内嵌数据（静态快照可能更旧）
    fetch('/api/data')
      .then(function (r) { if (!r.ok) throw new Error('no data'); return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.data && j.data.rows) { state.data = j.data; render(); }
      })
      .catch(function () { /* file:// 或静态托管时无服务，用内嵌快照 */ });
  }

  boot();
})();
</script>
</body>
</html>
`;
}
