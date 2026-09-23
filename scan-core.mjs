// scan-core.mjs —— 扫描 + 渲染共享核心（scan.mjs 命令行 与 server.mjs 本地服务共用）
// v2：并行扫描 / 仓库分页 / CI 趋势 / API 配额 / 许可证链接增量复用 / schema 2

// 仓库大小格式化（GitHub API 返回的单位为 KB）
export function fmtSize(kb) {
  if (!kb) return "—";
  if (kb < 1024) return kb + " KB";
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(1) + " MB";
  return (mb / 1024).toFixed(2) + " GB";
}
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
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

/* ---------------- GH_TOKEN 直连兜底(兜底矩阵:gh CLI → token 直连) ---------------- */
function ghToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}
function canDirectFallback(e, msg) {
  if (!ghToken()) return false;
  return e?.code === "ENOENT" || /command not found|not recognized|不是内部或外部命令|gh auth login|not logged/i.test(msg);
}
/* 极简 jq 子集:仅支持 .a.b.c 点路径(覆盖本工具全部 --jq 用法) */
export function applyJq(data, expr) {
  if (!/^\.[A-Za-z0-9_.]*$/.test(expr)) throw new Error("GH_TOKEN 兜底通道不支持该 --jq 表达式:" + expr);
  let v = data;
  for (const k of expr.slice(1).split(".")) { if (v == null) break; v = v[k]; }
  return v;
}
export async function directApi(args) {
  const headers = { "User-Agent": "github-repo-scan", Authorization: "Bearer " + ghToken(), Accept: "application/vnd.github+json" };
  if (args[0] !== "api") throw new Error("GH_TOKEN 兜底通道仅支持 api 调用");
  if (args[1] === "graphql") {
    const body = {};
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "-f" || args[i] === "-F") {
        const eq = String(args[i + 1] ?? "").indexOf("=");
        if (eq > 0) body[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
        i++;
      }
    }
    const r = await httpsJson("https://api.github.com/graphql", { method: "POST", headers, body: JSON.stringify(body) });
    if (r.status >= 300) throw new Error("GraphQL 直连响应异常(HTTP " + r.status + ")");
    try { return JSON.stringify(JSON.parse(r.text)); }
    catch (e) { throw new Error("GraphQL 直连响应异常(HTTP " + r.status + ")"); }
  }
  const restPath = String(args[1]).replace(/^\//, "");
  let jq = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--jq") { jq = args[i + 1]; i++; }
  }
  const r = await httpsJson("https://api.github.com/" + restPath, { headers });
  if (r.status >= 300) throw new Error("GitHub API HTTP " + r.status + "(GH_TOKEN 直连)");
  let data = null;
  try { data = JSON.parse(r.text); } catch (e) { data = r.text; }
  if (jq != null) {
    const v = applyJq(data, jq);
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  return typeof data === "string" ? data : JSON.stringify(data);
}

/* 直连传输层:严格 TLS 优先;本机代理会拦截证书链(gh CLI 走系统信任库所以无感,Node 不认),
   此时仅对 api.github.com 放宽校验重试一次。 */
function httpsJson(url, { method = "GET", headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (strict) => {
      const agent = new https.Agent({ rejectUnauthorized: strict, keepAlive: false });
      const req = https.request(url, { method, headers, agent, timeout: 25000 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      });
      req.on("error", (e) => {
        const msg = String((e && e.message) || e) + " " + String((e && e.cause && e.cause.message) || "");
        if (strict && /UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|CERT/i.test(msg)) {
          console.log("  ? TLS 证书校验失败（本机代理所致），放宽校验重试一次（仅限 api.github.com）");
          return attempt(false);
        }
        reject(e);
      });
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end(body || undefined);
    };
    attempt(true);
  });
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
      if (canDirectFallback(e, msg)) {
        try {
          const out = await directApi(args);
          console.log("  ? gh CLI 不可用，已用 GH_TOKEN 直连兜底通道完成本次调用");
          return out;
        } catch (e2) {
          console.log("  ? GH_TOKEN 直连兜底失败：" + e2.message);
        }
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

/* ---------------- 本地 Git 仓库扫描（读本机 .git，不联网、不依赖 gh） ---------------- */
const SKIP_DIRS = new Set([
  "node_modules", "venv", ".venv", "__pycache__", "site-packages", "dist", "build",
  "target", ".next", ".nuxt", ".gradle", ".m2", ".cargo", ".rustup", ".idea", ".vs",
  "$recycle.bin", "system volume information",
]);

/* 解析远程 URL → { host, owner, repo, isGitHub }；支持 https / git / ssh / scp 风格 */
export function parseRemoteUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  let m = s.match(/^(?:ssh:\/\/)?git@([^\/:]+)[:\/](.+?)(?:\.git)?\/?$/i);
  if (!m) m = s.match(/^(?:https?|git|ssh):\/\/(?:[^@\/]+@)?([^\/:]+(?::\d+)?)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/:\d+$/, "");
  const parts = m[2].split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { host, owner: parts[0], repo: parts[1], isGitHub: host === "github.com" || host.endsWith(".github.com") };
}

/* 递归找 .git：depth 为根目录下的最大层数；跳过隐藏目录与常见重目录；不跟进符号链接与仓库内部 */
export function findGitRepos(roots, depth = 4, maxRepos = 500) {
  const out = [];
  const seen = new Set();
  const norm = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase();
  const push = (p) => {
    const k = norm(p);
    if (seen.has(k) || out.length >= maxRepos) return;
    seen.add(k);
    out.push(p);
  };
  const walk = (dir, d, maxD) => {
    if (out.length >= maxRepos) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name.toLowerCase() === ".git")) { push(dir); return; }
    if (d >= maxD) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const n = e.name;
      if (n.startsWith(".") || SKIP_DIRS.has(n.toLowerCase())) continue;
      walk(join(dir, n), d + 1, maxD);
    }
  };
  for (const root of roots ?? []) {
    const p = typeof root === "string" ? root : (root && root.path);
    if (!p || !existsSync(p)) continue;
    const dd = (typeof root === "object" && Number.isFinite(root.depth)) ? root.depth : depth;
    walk(p, 0, dd);
  }
  return out;
}

async function gitOne(repoPath, args, timeoutMs = 12000) {
  const { stdout } = await execFileP("git", ["-C", repoPath, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, windowsHide: true });
  return stdout.trim();
}

/* 读取单个本地仓库：远程 URL / 分支 / HEAD / 脏状态 / 领先落后（基于本地缓存的 remote refs，不 fetch） */
export async function gitInfoFor(repoPath) {
  const info = {
    path: repoPath, name: repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath,
    remoteUrl: null, remotes: [], github: null, branch: null, head: null,
    lastCommitAt: null, dirty: false, dirtyCount: 0, ahead: null, behind: null,
    bare: false, error: null,
  };
  try {
    try { info.bare = (await gitOne(repoPath, ["rev-parse", "--is-bare-repository"])) === "true"; } catch { /* 按非 bare 处理 */ }
    try {
      const out = await gitOne(repoPath, ["remote", "-v"]);
      const seen = new Map();
      for (const line of out.split("\n")) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
        if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
      }
      info.remotes = [...seen].map(([name, url]) => ({ name, url }));
      const pick = seen.get("origin") ?? [...seen.values()][0] ?? null;
      info.remoteUrl = pick;
      const p = parseRemoteUrl(pick);
      if (p) info.github = { owner: p.owner, repo: p.repo, host: p.host, isGitHub: p.isGitHub };
    } catch { /* 无远程也算正常仓库 */ }
    try { info.branch = (await gitOne(repoPath, ["branch", "--show-current"])) || null; } catch { /* ignore */ }
    if (!info.branch) {
      try {
        info.branch = (await gitOne(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])) || null;
        if (info.branch === "HEAD") info.branch = "(detached)";
      } catch { /* ignore */ }
    }
    try { info.head = (await gitOne(repoPath, ["rev-parse", "--short", "HEAD"])) || null; } catch { /* 空仓库无提交 */ }
    try { info.lastCommitAt = (await gitOne(repoPath, ["log", "-1", "--format=%cI"])) || null; } catch { /* ignore */ }
    if (!info.bare) {
      try {
        const st = await gitOne(repoPath, ["status", "--porcelain"]);
        const n = st ? st.split("\n").filter((l) => l.trim()).length : 0;
        info.dirtyCount = n;
        info.dirty = n > 0;
      } catch { /* ignore */ }
    }
    if (info.branch && !/^\(/.test(info.branch)) {
      const ub = "origin/" + info.branch;
      const cnt = async (spec) => {
        try { return parseInt(await gitOne(repoPath, ["rev-list", "--count", spec]), 10); } catch { return null; }
      };
      info.ahead = await cnt(ub + "..HEAD");
      info.behind = await cnt("HEAD.." + ub);
    }
  } catch (e) {
    info.error = String((e && e.message) || e).split("\n")[0];
  }
  return info;
}

/* ---------------- 本地扫描配置（scan-config.json；含本机路径，不入库） ---------------- */
export function readLocalConfig() {
  try { return JSON.parse(readFileSync(join(HERE, "scan-config.json"), "utf8")) ?? {}; } catch { return {}; }
}
export function writeLocalConfig(cfg) {
  writeFileSync(join(HERE, "scan-config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
/* 默认扫描范围：用户主目录只看 1 层（覆盖 C:\Users\me\<repo> 式克隆）+ 桌面/文档/下载看完整深度 */
export function defaultLocalRoots() {
  const cfg = readLocalConfig();
  if (Array.isArray(cfg.localScanRoots) && cfg.localScanRoots.length) return cfg.localScanRoots;
  const home = homedir();
  const roots = [{ path: home, depth: 1 }];
  for (const name of ["Desktop", "Documents", "Downloads"]) {
    const p = join(home, name);
    if (existsSync(p)) roots.push(p);
  }
  return roots;
}

/* 并发读取全部本地仓库信息 */
export async function collectLocal({ roots, depth = 4, maxRepos = 500 } = {}) {
  try { await execFileP("git", ["--version"], { timeout: 8000, windowsHide: true }); }
  catch { throw new Error("未检测到 git 命令：请安装 Git（https://git-scm.com）并确保在 PATH 中"); }
  const rs = (roots && roots.length ? roots : defaultLocalRoots()).filter(Boolean);
  const paths = findGitRepos(rs, depth, maxRepos);
  const rootsText = rs.map((x) => (typeof x === "string" ? x : (x && x.path) || "?")).join(" ; ");
  if (!paths.length) {
    throw new Error("在「" + rootsText + "」（深度 " + depth + "）下没有找到 Git 仓库：可用 --local-paths 或面板「本地目录…」调整范围");
  }
  console.log("? 本地扫描根目录：" + rootsText + "（深度 " + depth + "）→ 找到 " + paths.length + " 个 Git 仓库，并发读取状态…");
  const repos = await pool(paths, 6, gitInfoFor);
  return {
    scannedAt: new Date().toISOString(),
    roots: rs.map((x) => (typeof x === "string" ? x : x.path)),
    depth,
    count: repos.length,
    repos,
  };
}

/* 本地仓库与远程 rows 匹配：优先 owner/repo 精准，其次唯一同名兜底；写入 row.local 与 localScan.matched */
export function matchLocalToRemote(data, localScan) {
  const rows = data.rows || [];
  for (const r of rows) r.local = null;
  const byFull = new Map();
  const byName = new Map();
  for (const r of rows) {
    const p = parseRemoteUrl(r.url);
    if (p && p.isGitHub) byFull.set((p.owner + "/" + p.repo).toLowerCase(), r);
    const k = String(r.name).toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  let matched = 0;
  const localOnly = [];
  for (const lr of localScan.repos || []) {
    lr.matched = false;
    lr.matchType = null;
    lr.matchedRepo = null;
    let row = null;
    if (lr.github && lr.github.isGitHub) {
      row = byFull.get((lr.github.owner + "/" + lr.github.repo).toLowerCase()) || null;
      if (row) lr.matchType = "owner/repo";
    }
    if (!row) {
      const cands = byName.get(String(lr.name).toLowerCase()) || [];
      if (cands.length === 1) { row = cands[0]; lr.matchType = "name"; }
      else if (cands.length > 1) lr.matchType = "ambiguous";
    }
    if (row) {
      lr.matched = true;
      lr.matchedRepo = row.name;
      row.local = {
        path: lr.path, branch: lr.branch, head: lr.head,
        dirty: !!lr.dirty, dirtyCount: lr.dirtyCount || 0,
        ahead: lr.ahead, behind: lr.behind,
        lastCommitAt: lr.lastCommitAt, remoteUrl: lr.remoteUrl,
      };
      matched++;
    } else {
      localOnly.push(lr);
    }
  }
  localScan.matched = matched;
  localScan.localOnlyCount = localOnly.length;
  return { matched, localOnly };
}

/* 汇总本地对照指标（无本地扫描时置 null，面板据此隐藏） */
export function applyLocalTotals(data) {
  const t = data.totals || (data.totals = {});
  const ls = data.localScan;
  if (!ls) {
    t.localTotal = t.localMatched = t.localMissing = t.localOnly = t.localDirty = t.localDiverged = null;
    return;
  }
  const rows = data.rows || [];
  const repos = ls.repos || [];
  t.localTotal = ls.count ?? repos.length;
  t.localMatched = ls.matched ?? 0;
  t.localMissing = rows.filter((r) => !r.local).length;
  t.localOnly = ls.localOnlyCount ?? 0;
  t.localDirty = repos.filter((x) => x.dirty).length;
  t.localDiverged = repos.filter((x) => (x.ahead || 0) > 0 || (x.behind || 0) > 0).length;
}

/* 仅本地扫描：并入现有快照（没有则生成远程部分为空的骨架） */
export function mergeLocalSnapshot(localScan) {
  let data = null;
  try { data = JSON.parse(readFileSync(join(HERE, "scan-data.json"), "utf8")); } catch { /* 无快照 */ }
  if (!data || !Array.isArray(data.rows)) {
    data = {
      schema: 3, owner: null, avatarUrl: "", scannedAt: null, truncated: false, rate: null,
      totals: { repos: 0, totalRepos: 0, stars: 0, forks: 0, openIssues: 0, openPRs: 0, releases: 0, ciDone: 0, ciOk: 0 },
      rows: [],
    };
  }
  matchLocalToRemote(data, localScan);
  data.localScan = localScan;
  data.schema = 3;
  applyLocalTotals(data);
  return data;
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
          size
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
export async function collectData(ownerArg, opts = {}) {
  const owner = ownerArg || (await ghAsync(["api", "user", "--jq", ".login"]));
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
    const res = JSON.parse(await ghAsync(ghArgs));
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

    // 最近一次提交的变更文件（用于「最近变更」列；每个仓库 +1 次 REST 调用）
    let lastCommit = null;
    try {
      const c = JSON.parse(await ghAsync(["api", "repos/" + owner + "/" + r.name + "/commits?per_page=1"]));
      const cm = Array.isArray(c) ? c[0] : null;
      if (cm && cm.sha) {
        const files = (cm.files || []).slice(0, 12).map((f) => ({ name: f.filename, status: f.status, add: f.additions || 0, del: f.deletions || 0 }));
        lastCommit = {
          sha: cm.sha,
          message: (cm.commit?.message || "").split("\n")[0].slice(0, 120),
          at: cm.commit?.author?.date || cm.commit?.committer?.date || null,
          url: cm.html_url || null,
          files,
          fileCount: (cm.files || []).length,
        };
      }
    } catch { /* 无提交或接口不可用时留空 */ }

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
      size: r.size ?? 0,
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
      lastCommit,
    };
  });

  // 4. API 配额（rate_limit 接口本身不消耗配额）
  let rate = null;
  try {
    rate = JSON.parse(await ghAsync(["api", "rate_limit", "--jq", ".resources.core"]));
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
    sizeTotal: rows.reduce((a, r) => a + (r.size || 0), 0),
  };

  const data = { schema: 3, owner: login, avatarUrl, scannedAt: new Date().toISOString(), truncated, rate, totals, rows };
  for (const r of data.rows) r.local = null;
  if (opts.local !== false) {
    try {
      const cfg = readLocalConfig();
      const depth = Number.isFinite(opts.depth) ? opts.depth : (Number.isFinite(cfg.localScanDepth) ? cfg.localScanDepth : 4);
      const localScan = await collectLocal({ roots: opts.roots, depth });
      matchLocalToRemote(data, localScan);
      data.localScan = localScan;
    } catch (e) {
      console.log("▸ 本地对照跳过：" + ((e && e.message) ?? e));
      data.localScan = null;
    }
  } else {
    data.localScan = null;
  }
  applyLocalTotals(data);
  return data;
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
  if (data.localScan) {
    const ls = data.localScan;
    console.log("▸ 本地对照：本机 " + ls.count + " 个 Git 仓库 · 对上 " + ls.matched + " · 本地独有 " + ls.localOnlyCount + " · 远程有本地缺 " + (t.localMissing ?? 0));
    const missing = data.rows.filter((r) => !r.local).map((r) => r.name);
    if (missing.length) console.log("  ⚠ 远程有但本地没扫到：" + missing.join(", "));
    for (const lr of ls.repos) {
      const st = [lr.dirty ? "未提交" + (lr.dirtyCount || 0) : "", (lr.ahead || 0) > 0 ? "↑" + lr.ahead : "", (lr.behind || 0) > 0 ? "↓" + lr.behind : ""].filter(Boolean).join(" ") || "干净";
      console.log("   " + (lr.matched ? "✔ " : "＋") + lr.name.padEnd(24) + " " + String(lr.branch || "—").padEnd(14) + " " + st.padEnd(14) + " " + lr.path);
    }
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
  .modes { display: inline-flex; gap: 6px; }
  .modes .btn.on { border-color: var(--accent); color: var(--accent); }
  .local-box { border: 1px solid var(--border); border-radius: 8px; margin-top: 16px; background: var(--bg); overflow: hidden; }
  .local-box .panel-title { padding: 11px 14px; font-size: 12.5px; font-weight: 600; color: var(--text); background: var(--panel); border-bottom: 1px solid var(--border); }
  .local-scroll { overflow-x: auto; }
  .local-table { width: 100%; border-collapse: collapse; min-width: 860px; }
  .local-table tbody td { padding: 10px 14px; border-top: 1px solid var(--rowborder); vertical-align: top; }
  .local-table tbody tr:hover { background: var(--hover); }
  .local-table tbody tr:first-child td { border-top: none; }
  .path { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; color: var(--muted); max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dirty { color: var(--warn); }
  .badge.local-ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); }
  .badge.local-ok .dot { background: var(--ok); }
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

  .scorebar { height: 4px; border-radius: 3px; background: var(--rowborder); margin-top: 6px; overflow: hidden; width: 76px; }
  .scorebar > i { display: block; height: 100%; border-radius: 3px; }
  .filetoggle { background: var(--panel); border: 1px solid var(--border); color: var(--text2); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .filetoggle:hover { border-color: var(--accent); color: var(--accent); }
  .filelist { margin-top: 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); max-height: 168px; overflow-y: auto; padding: 6px 8px; }
  .filelist .fi { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 2px 0; font-family: Consolas, "Cascadia Mono", monospace; }
  .filelist .st { width: 18px; text-align: center; font-weight: 700; flex: none; }
  .filelist .st.add { color: var(--ok); }
  .filelist .st.mod { color: var(--warn); }
  .filelist .st.del { color: var(--fail); }
  .filelist .fn { color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filelist .num { margin-left: auto; color: var(--muted); flex: none; font-size: 11px; }
  .sz { white-space: nowrap; }

  .alert-box { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  .alert-box:empty { display: none; }
  .alert-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); color: var(--text2); font-size: 13px; cursor: pointer; font-family: inherit; }
  .alert-chip:hover { border-color: var(--accent); color: var(--accent); }
  .alert-chip .n { font-weight: 700; color: var(--text1); }
  .alert-chip.fail { border-color: var(--fail); }
  .alert-chip.fail .n { color: var(--fail); }
  .alert-chip.warn { border-color: var(--warn); }
  .alert-chip.warn .n { color: var(--warn); }
  .alert-chip.ok { border-color: var(--ok); }
  .alert-chip.ok .n { color: var(--ok); }
  .alert-box .lbl { color: var(--muted); font-size: 13px; align-self: center; margin-right: 2px; }

  .lang-box { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 0 0 14px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
  .lang-box:empty { display: none; }
  .lang-box .lbl { color: var(--muted); font-size: 13px; align-self: center; }
  .lang-row { display: flex; flex-direction: column; gap: 4px; min-width: 150px; }
  .lang-row .top { display: flex; justify-content: space-between; font-size: 13px; }
  .lang-row .nm { color: var(--text1); font-weight: 600; }
  .lang-row .ct { color: var(--text2); }
  .lang-row .bar { height: 6px; border-radius: 4px; background: var(--rowborder); overflow: hidden; }
  .lang-row .bar > i { display: block; height: 100%; border-radius: 4px; }
  .lang-row .rk { color: var(--accent); font-weight: 700; margin-right: 6px; }
  .lang-row a.nm { color: var(--text1); font-weight: 600; text-decoration: none; }
  .lang-row a.nm:hover { color: var(--accent); text-decoration: underline; }
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
      <button id="scanBtn" class="btn primary" type="button" title="重新扫描并刷新本页数据（远程 + 本地对照；需本地服务已启动：node server.mjs）"><span class="ico"></span><span class="lbl">重新扫描</span></button>
      <button id="scanLocalBtn" class="btn" type="button" title="只扫描本机 Git 仓库并对照/列出（不访问 GitHub，需本地服务）"><span class="ico2"></span><span class="lbl">仅扫本地</span></button>
      <button id="csvBtn" class="btn" type="button" title="导出当前筛选/排序结果为 CSV（Excel 可直接打开，带 UTF-8 BOM）">导出 CSV</button>
      <button id="cloneBtn" class="btn" type="button" title="复制当前可见仓库的 git clone 命令到剪贴板">复制 clone</button>
      <button id="themeBtn" class="btn icon" type="button" title="切换明暗主题" aria-label="切换明暗主题"></button>
    </div>
  </header>
  <div class="hint" id="scanHint"></div>

  <div class="metrics" id="metrics"></div>
  <div class="alert-box" id="alertBox"></div>
  <div class="lang-box" id="langBox"></div>
  <div class="lang-box" id="rankBox"></div>

  <div class="toolbar">
    <input id="q" type="search" placeholder="搜索仓库名 / 描述…">
    <select id="fLang" title="按语言筛选"><option value="">全部语言</option></select>
    <select id="fStatus" title="按状态筛选">
      <option value="">全部状态</option>
      <option value="ok">CI 通过</option>
      <option value="fail">CI 失败</option>
      <option value="running">CI 运行中</option>
      <option value="none">无 CI 记录</option>
      <option value="pub">仅公开仓库</option>
      <option value="priv">仅私有仓库</option>
      <option value="hasIssue">有开放 Issue</option>
      <option value="noLic">未声明许可证</option>
      <option value="lowScore">仅低健康分(&lt;50)</option>
      <option value="noLocal">本地缺失</option>
      <option value="dirtyLocal">本地有未提交改动</option>
      <option value="aheadLocal">本地与远程不一致</option>
      <option value="archived">仅归档仓库</option>
    </select>
    <span class="modes" id="modeBox" style="display:none">
      <button id="modeBoth" class="btn on" type="button" title="远程扫描结果 + 每仓本地对照状态">远程+本地对照</button>
      <button id="modeLocal" class="btn" type="button" title="只看本机 Git 仓库（含远程账号名下没有的）">仅本地仓库</button>
    </span>
    <button id="cfgBtn" class="btn" type="button" title="设置本地扫描根目录（分号分隔），保存到 scan-config.json，下次扫描生效">本地目录…</button>
    <label class="chk"><input type="checkbox" id="fNoFork">隐藏 fork</label>
    <label class="chk"><input type="checkbox" id="fNoArchived">隐藏归档</label>
    <label class="chk"><input type="checkbox" id="fAutoScanStart" title="开启后，启动面板会先自动扫描（约 20–40 秒）再打开页面；可在 scan-config.json 设 stale/always/off">启动前扫描</label>
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

  <div class="scroll" id="mainScroll">
    <table>
      <thead>
        <tr>
          <th class="sortable" data-key="name" title="点击按仓库名排序">仓库<span class="arr" data-arr="name"></span></th>
          <th class="sortable" data-key="visibility" title="点击按可见性排序（私有优先）">可见性<span class="arr" data-arr="visibility"></span></th>
          <th class="sortable" data-key="local" title="点击按本地状态排序（降序 = 本地异常优先）">本地<span class="arr" data-arr="local"></span></th>
          <th class="sortable" data-key="score" title="健康分 = CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15(归档仓打七折)">健康<span class="arr" data-arr="score"></span></th>
          <th class="sortable" data-key="ci" title="点击按 CI 状态排序（降序 = 问题优先）">CI/CD 状态<span class="arr" data-arr="ci"></span></th>
          <th class="sortable" data-key="license" title="点击按许可证排序">许可证<span class="arr" data-arr="license"></span></th>
          <th class="sortable" data-key="release" title="点击按最新发布时间排序">最新 Release<span class="arr" data-arr="release"></span></th>
          <th class="sortable" data-key="issues" title="点击按开放 Issue 数排序">Issue<span class="arr" data-arr="issues"></span></th>
          <th class="sortable" data-key="branches" title="点击按分支数排序">分支<span class="arr" data-arr="branches"></span></th>
          <th class="sortable" data-key="stars" title="点击按 Star 数排序">Star<span class="arr" data-arr="stars"></span></th>
          <th class="sortable" data-key="forks" title="点击按 Fork 数排序">Fork<span class="arr" data-arr="forks"></span></th>
          <th class="sortable" data-key="language" title="点击按语言排序">语言<span class="arr" data-arr="language"></span></th>
          <th class="sortable" data-key="size" title="点击按仓库大小排序（GitHub 返回的磁盘占用，单位 KB）">大小<span class="arr" data-arr="size"></span></th>
          <th class="sortable" data-key="traffic" title="点击按近 14 天浏览量排序(设 SCAN_WITH_TRAFFIC=1 开启采集)">流量<span class="arr" data-arr="traffic"></span></th>
          <th class="sortable" data-key="files" title="点击按最近一次提交变更文件数排序（点「N 文件」展开详情）">最近变更<span class="arr" data-arr="files"></span></th>
          <th class="sortable" data-key="pushedAt" title="点击按最近推送排序">最近推送<span class="arr" data-arr="pushedAt"></span></th>
          <th class="sortable" data-key="createdAt" title="点击按创建时间排序">创建时间<span class="arr" data-arr="createdAt"></span></th>
        </tr>
      </thead>
      <tbody id="tbody"><tr><td class="empty" colspan="17">正在载入…</td></tr></tbody>
    </table>
  </div>

  <div class="local-box" id="localOnlyBox" style="display:none"></div>

  <footer>
    <div id="footExtra"></div>
    数据为扫描时快照：页面内点「重新扫描」可原地更新（需启动本地服务 <code>node server.mjs</code>），或命令行 <code>node scan.mjs</code>（<code>--render-only</code> 仅重渲染）·
    排序：点击表头，再点一次切换升降序（选择会记住）· 健康分：CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15 · 视图：「＋存视图」保存当前筛选与排序 · 主题：右上角切换（默认浅色）·
    CI 取最近一次 Actions 运行（任意分支/标签）· Issue 数不含 PR（PR 单列）· 分支数为全部本地分支（不含 tag）·
    表格内每个单元格都链接到对应的 GitHub 页面 · 本地对照列：本机有对应 Git 仓库时显示分支与工作区状态（干净 / 未提交 n / ↑领先 ↓落后，基于本地缓存的远程 refs，不自动 fetch），扫描范围用「本地目录…」或 <code>scan-config.json</code> 调整 · 「仅本地仓库」模式在下方列出全部本机仓库（含远程账号名下没有的「本地独有」仓库）· <strong>可见性</strong>列可点表头按公开/私有排序，筛选下拉含「仅公开 / 仅私有」· <strong>大小</strong>列为 GitHub 磁盘占用（KB/MB/GB）· <strong>最近变更</strong>列点「N 文件」展开最近一次提交的文件清单（A 增 / M 改 / D 删，带 +− 行数）· 工具栏「隐藏归档」「启动前扫描」可记忆式开关 · 右上角「导出 CSV」导出当前视图（UTF-8，Excel 可直接打开）· 「仅低健康分(&lt;50)」可快速定位问题仓库。
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
  var state = { data: null, sortKey: 'pushedAt', sortDir: 'desc', scanning: false, q: '', fLang: '', fStatus: '', noFork: false, noArchived: false, mode: 'both', expanded: {} };
  var VIEWS_KEY = 'ghscan.views.v1';
  var MODE_KEY = 'grs-mode';
  var viewState = { views: {}, current: '' };
  try { viewState.views = JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}') || {}; } catch (e) { viewState.views = {}; }
  var autoTimer = null;

  var SVG_FOLDER = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M1.75 1.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V4.75a.25.25 0 0 0-.25-.25H7.5a.75.75 0 0 1-.6-.3L5.9 2.9a.25.25 0 0 0-.2-.1H1.75ZM0 1.75C0 .784.784 0 1.75 0h4.06c.464 0 .909.216 1.194.585l1.28 1.665h5.966c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V1.75Z"/></svg>';

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
    visibility: function (r) { return r.visibility === 'PRIVATE' ? 1 : 0; },
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
    traffic: function (r) { return r.traffic ? r.traffic.views : null; },
    size: function (r) { return r.size || 0; },
    files: function (r) { return r.lastCommit && r.lastCommit.files ? r.lastCommit.fileCount : null; },
    createdAt: function (r) { return r.createdAt ? new Date(r.createdAt).getTime() : null; },
    local: function (r) {
      if (!state.data || !state.data.localScan) return null;
      var l = r.local;
      if (!l) return 0;
      if (l.dirty) return 3;
      if ((l.ahead || 0) > 0 || (l.behind || 0) > 0) return 2;
      return 1;
    }
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
    if (state.noArchived && r.isArchived) return false;
    if (state.fStatus === 'ok' && r.ci.cls !== 'ok') return false;
    if (state.fStatus === 'pub' && r.visibility !== 'PUBLIC') return false;
    if (state.fStatus === 'priv' && r.visibility !== 'PRIVATE') return false;
    if (state.fStatus === 'lowScore' && scoreOf(r) >= 50) return false;
    if (state.fStatus === 'archived' && !r.isArchived) return false;
    if (state.fStatus === 'fail' && r.ci.cls !== 'fail') return false;
    if (state.fStatus === 'running' && r.ci.cls !== 'running') return false;
    if (state.fStatus === 'none' && r.ci.cls !== 'none') return false;
    if (state.fStatus === 'hasIssue' && r.openIssues <= 0) return false;
    if (state.fStatus === 'noLic' && r.license) return false;
    if (state.fLang && r.language !== state.fLang) return false;
    var hasLocalData = state.data && state.data.localScan;
    if (state.fStatus === 'noLocal' && (!hasLocalData || !!r.local)) return false;
    if (state.fStatus === 'dirtyLocal' && (!hasLocalData || !r.local || !r.local.dirty)) return false;
    if (state.fStatus === 'aheadLocal' && (!hasLocalData || !r.local || !(((r.local.ahead || 0) > 0) || ((r.local.behind || 0) > 0)))) return false;
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
    var col = g.cls === 'ok' ? 'var(--ok)' : g.cls === 'info' ? 'var(--accent)' : g.cls === 'warn' ? 'var(--warn)' : 'var(--fail)';
    var tip = 'CI ' + (r.ci ? r.ci.state : '?') + ' · 最近推送 ' + relTime(r.pushedAt) + ' · 开放 Issue ' + (r.openIssues || 0) + ' · 健康分 = CI 40 + 新鲜度 30 + Issue 卫生 15 + 发布节奏 15' + (r.isArchived ? '(归档仓七折)' : '');
    return '<span class="badge ' + g.cls + '" title="' + esc(tip) + '"><span class="dot"></span>' + s + ' · ' + g.g + '</span>' +
      '<div class="scorebar" title="' + s + ' 分"><i style="width:' + s + '%;background:' + col + '"></i></div>';
  }
  function visibilityCell(r) {
    if (!r.visibility) return '<span class="muted">—</span>';
    var priv = r.visibility === 'PRIVATE';
    return '<span class="badge ' + (priv ? 'warn' : 'local-ok') + '"><span class="dot"></span>' + (priv ? '私有' : '公开') + '</span>';
  }
  function sizeCell(r) {
    return '<span class="sz" title="' + (r.size || 0) + ' KB">' + fmtSize(r.size) + '</span>';
  }
  function filesCell(r) {
    var lc = r.lastCommit;
    if (!lc || !lc.fileCount) return '<span class="muted">—</span>';
    var open = !!state.expanded[r.name];
    var head = '<button class="filetoggle" type="button" data-name="' + esc(r.name) + '" title="' + esc((lc.message || '') + (lc.at ? ' · ' + fullTime(lc.at) : '')) + '">最近 ' + lc.fileCount + ' 文件</button>';
    if (!open) return head;
    var list = '<div class="filelist">';
    for (var i = 0; i < lc.files.length; i++) {
      var f = lc.files[i];
      var stCls = f.status === 'added' ? 'add' : (f.status === 'removed' ? 'del' : 'mod');
      var stTxt = f.status === 'added' ? 'A' : (f.status === 'removed' ? 'D' : 'M');
      var num = (f.add || 0) + (f.del || 0) ? ('+' + (f.add || 0) + ' −' + (f.del || 0)) : '';
      list += '<div class="fi"><span class="st ' + stCls + '">' + stTxt + '</span>' +
        (lc.url ? '<a class="fn" href="' + esc(lc.url) + '" target="_blank" rel="noopener" title="' + esc(f.name) + '">' + esc(f.name) + '</a>' : '<span class="fn" title="' + esc(f.name) + '">' + esc(f.name) + '</span>') +
        (num ? '<span class="num">' + num + '</span>' : '') + '</div>';
    }
    list += '</div>';
    return head + list;
  }
  function trafficCell(r) {
    var t = r.traffic;
    if (!t) return '<a class="muted" href="' + esc(r.url) + '/graphs/traffic" target="_blank" rel="noopener" title="未采集流量:设环境变量 SCAN_WITH_TRAFFIC=1 后重新扫描">—</a>';
    return '<a class="muted" href="' + esc(r.url) + '/graphs/traffic" target="_blank" rel="noopener" title="近 14 天:' + t.viewUniques + ' 位访客 · ' + t.cloneUniques + ' 人克隆">' + t.views + ' 浏览 · ' + t.clones + ' 克隆</a>';
  }

  function localCell(r) {
    var d = state.data;
    if (!d || !d.localScan) return '<span class="muted" title="未启用本地扫描：点「仅扫本地」或运行 node scan.mjs --local-only">—</span>';
    var l = r.local;
    if (!l) return '<span class="badge" title="本机扫描范围内没有对应目录"><span class="dot"></span>本地缺失</span>';
    var bits = [];
    if (l.dirty) bits.push('<span class="dirty">未提交 ' + (l.dirtyCount || 0) + '</span>');
    if ((l.ahead || 0) > 0) bits.push('↑' + l.ahead);
    if ((l.behind || 0) > 0) bits.push('↓' + l.behind);
    if (!bits.length) bits.push('干净');
    var tip = esc(l.path || '') + (l.branch ? ' @ ' + esc(l.branch) : '') + ' · 基于本地缓存的远程 refs，不自动 fetch';
    return '<span class="badge local-ok" title="' + tip + '"><span class="dot"></span>本地有</span><div class="sub">' + esc(l.branch || '—') + ' · ' + bits.join(' · ') + '</div>';
  }

  function localRowHtml(lr) {
    var ghLink;
    if (lr.github && lr.github.isGitHub) {
      var ghUrl = 'https://github.com/' + lr.github.owner + '/' + lr.github.repo;
      ghLink = '<a href="' + esc(ghUrl) + '" target="_blank" rel="noopener">' + esc(lr.github.owner + '/' + lr.github.repo) + '</a>';
    } else if (lr.remoteUrl) {
      ghLink = '<span class="muted" title="' + esc(lr.remoteUrl) + '">非 GitHub 远程</span>';
    } else {
      ghLink = '<span class="muted">无远程</span>';
    }
    var st = [];
    if (lr.dirty) st.push('<span class="tag warn">未提交 ' + (lr.dirtyCount || 0) + '</span>');
    if ((lr.ahead || 0) > 0) st.push('<span class="tag" title="本地领先远程">↑ ' + lr.ahead + '</span>');
    if ((lr.behind || 0) > 0) st.push('<span class="tag" title="本地落后远程">↓ ' + lr.behind + '</span>');
    if (!st.length) st.push('<span class="tag">干净</span>');
    if (lr.error) st.push('<span class="tag warn" title="' + esc(lr.error) + '">读取异常</span>');
    var nameCell = '<span class="repo-name">' + esc(lr.name) + '</span>' + (lr.matched ? '' : ' <span class="tag">远程无对应</span>');
    return '<tr>' +
      '<td class="repo">' + nameCell + '</td>' +
      '<td class="path" title="' + esc(lr.path) + '">' + esc(lr.path) + '</td>' +
      '<td>' + esc(lr.branch || '—') + (lr.head ? ' <span class="muted">@' + esc(lr.head) + '</span>' : '') + '</td>' +
      '<td>' + st.join(' ') + '</td>' +
      '<td class="num">' + (lr.lastCommitAt ? '<span title="' + esc(fullTime(lr.lastCommitAt)) + '">' + esc(relTime(lr.lastCommitAt)) + '</span>' : '<span class="muted">—</span>') + '</td>' +
      '<td>' + ghLink + '</td>' +
      '</tr>';
  }

  function renderLocalBox() {
    var box = document.getElementById('localOnlyBox');
    var d = state.data;
    if (!d || !d.localScan) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var only = state.mode === 'both';
    if (only && d.localScan.localOnlyCount === 0) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var repos = d.localScan.repos.slice();
    if (only) repos = repos.filter(function (x) { return !x.matched; });
    repos.sort(function (a, b) { var va = a.lastCommitAt || '', vb = b.lastCommitAt || ''; return vb < va ? -1 : vb > va ? 1 : 0; });
    var label = only
      ? '本地独有仓库（' + repos.length + '）—— 本机存在、远程账号名下没有对应目录'
      : '本地 Git 仓库（' + repos.length + '）—— 只读本机 .git 状态，不做网络请求';
    box.style.display = '';
    box.innerHTML = '<div class="panel-title">' + esc(label) + '</div><div class="local-scroll"><table class="local-table"><thead><tr><th>仓库</th><th>本地路径</th><th>分支</th><th>工作区状态</th><th>最近提交</th><th>远程</th></tr></thead><tbody>' + repos.map(localRowHtml).join('') + '</tbody></table></div>';
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
      '<td>' + visibilityCell(r) + '</td>' +
      '<td>' + localCell(r) + '</td>' +
      '<td>' + scoreCell(r) + '</td>' +
      '<td>' + ciCell(r) + '</td>' +
      '<td>' + lic + '</td>' +
      '<td>' + rel + '</td>' +
      '<td class="num">' + issue + '</td>' +
      '<td>' + branch + '</td>' +
      '<td class="num">' + star + '</td>' +
      '<td class="num">' + fork + '</td>' +
      '<td><span class="lang"><span class="ldot" style="background:' + esc(r.langColor) + '"></span>' + esc(r.language || '—') + '</span></td>' +
      '<td class="num">' + sizeCell(r) + '</td>' +
      '<td class="num">' + trafficCell(r) + '</td>' +
      '<td>' + filesCell(r) + '</td>' +
      '<td class="num"><span title="' + esc(fullTime(r.pushedAt)) + '">' + esc(relTime(r.pushedAt)) + '</span></td>' +
      '<td class="num"><span title="' + esc(fullTime(r.createdAt)) + '">' + esc(relTime(r.createdAt)) + '</span></td>' +
      '</tr>';
  }

  function render() {
    var d = state.data;
    if (!d) {
      document.getElementById('scanMeta').textContent = '尚未扫描';
      document.getElementById('metrics').innerHTML = '';
      document.getElementById('tbody').innerHTML = '<tr><td class="empty" colspan="17">暂无数据 —— 点击右上角「重新扫描」开始第一次扫描（需已启动 node server.mjs）</td></tr>';
      return;
    }
    var avatar = document.getElementById('avatar');
    if (d.avatarUrl) { avatar.src = d.avatarUrl; avatar.style.display = ''; }
    document.getElementById('title').textContent = d.owner + ' · GitHub 仓库总览';
    var hasLocal = !!(d.localScan);
    var meta = '扫描时间 ' + fullTime(d.scannedAt) + ' · 共 ' + d.totals.repos + ' 个仓库（账号名下 ' + d.totals.totalRepos + ' 个） · 数据源 gh api（GraphQL + REST）';
    if (hasLocal) meta += ' · 本地对照 ' + d.localScan.count + ' 仓（' + fullTime(d.localScan.scannedAt) + '）';
    document.getElementById('scanMeta').textContent = meta;
    var t = d.totals;
    var pub = d.rows.filter(function (r) { return r.visibility === 'PUBLIC'; }).length;
    var priv = d.rows.filter(function (r) { return r.visibility === 'PRIVATE'; }).length;
    var totalSize = fmtSize(t.sizeTotal || 0);
    document.getElementById('metrics').innerHTML =
      metric(t.repos, '仓库') +
      metric(pub, '公开') +
      metric(priv, '私有') +
      metric(totalSize, '总大小') +
      metric(t.stars, 'Star 合计') +
      metric(t.forks, 'Fork 合计') +
      metric(t.openIssues + '<span class="vsub"> +' + t.openPRs + ' PR</span>', '开放 Issue') +
      metric(t.releases, '发布合计') +
      metric(t.ciOk + '<span class="vsub">/' + t.ciDone + '</span>', 'CI 通过 / 有记录') +
      metric(function () { var s = 0, n = d.rows.length || 1; for (var i = 0; i < d.rows.length; i++) s += scoreOf(d.rows[i]); return Math.round(s / n); }(), '平均健康分') +
      (hasLocal ? metric(t.localMatched + '<span class="vsub">/' + t.localTotal + '</span>', '本地对照') + metric(t.localMissing, '本地缺失') + metric(t.localOnly, '本地独有') + metric(t.localDirty, '本地未提交') : '');

    // 聚合视图：CI 失败 / 低健康分 / 未声明许可证 / 无 CI / 本地缺失 —— 点击 chip 直接套用筛选
    var ciFail = d.rows.filter(function (r) { return r.ci.cls === 'fail'; }).length;
    var ciNone = d.rows.filter(function (r) { return r.ci.cls === 'none'; }).length;
    var low = d.rows.filter(function (r) { return scoreOf(r) < 50; }).length;
    var noLicC = d.rows.filter(function (r) { return !r.license; }).length;
    var noLocalC = d.localScan ? d.rows.filter(function (r) { return !r.local; }).length : 0;
    var archivedC = d.rows.filter(function (r) { return r.isArchived; }).length;
    var chips = [];
    function chip(cls, n, label, status, plain) { if (n > 0) chips.push('<button class="alert-chip ' + cls + '" data-status="' + status + '" title="点击筛出这些仓库">' + (plain ? '' : '⚠ ') + '<span class="n">' + n + '</span> ' + label + '</button>'); }
    chip('fail', ciFail, '个仓库 CI 失败', 'fail');
    chip('warn', low, '个低健康分(&lt;50)', 'lowScore');
    chip('warn', noLicC, '个未声明许可证', 'noLic');
    chip('', ciNone, '个无 CI 记录', 'none');
    chip('', noLocalC, '个本地缺失', 'noLocal');
    chip('', archivedC, '个归档仓库', 'archived', true);
    document.getElementById('alertBox').innerHTML = chips.length ? '<span class="lbl">聚合视图：</span>' + chips.join('') : '';

    // 语言分布：按仓库数 Top 排序，条长按占比
    var langCount = {};
    var langColors = {};
    for (var li2 = 0; li2 < d.rows.length; li2++) {
      var lg = d.rows[li2].language || '未知';
      langCount[lg] = (langCount[lg] || 0) + 1;
      if (d.rows[li2].language) langColors[d.rows[li2].language] = d.rows[li2].langColor;
    }
    var langArr = Object.keys(langCount).map(function (k) { return { name: k, count: langCount[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
    var maxLang = langArr.length ? langArr[0].count : 1;
    var langHtml = langArr.map(function (x) {
      var col = langColors[x.name] || '#8b949e';
      return '<div class="lang-row"><div class="top"><span class="nm">' + esc(x.name) + '</span><span class="ct">' + x.count + ' 仓</span></div>' +
        '<div class="bar"><i style="width:' + Math.round(x.count / maxLang * 100) + '%;background:' + col + '"></i></div></div>';
    }).join('');
    document.getElementById('langBox').innerHTML = langHtml ? '<span class="lbl">语言分布（Top ' + langArr.length + '）：</span>' + langHtml : '';

    // Star 排行榜：Top 5（条长按占比）
    var starArr = d.rows.slice().sort(function (a, b) { return b.stars - a.stars; }).slice(0, 5);
    var maxStar = starArr.length ? starArr[0].stars : 1;
    var rankHtml = starArr.map(function (x, i) {
      var pct = maxStar > 0 ? Math.round(x.stars / maxStar * 100) : 0;
      return '<div class="lang-row"><div class="top"><span><span class="rk">#' + (i + 1) + '</span><a class="nm" href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></span><span class="ct">' + x.stars + ' ★</span></div>' +
        '<div class="bar"><i style="width:' + pct + '%;background:var(--accent)"></i></div></div>';
    }).join('');
    document.getElementById('rankBox').innerHTML = rankHtml ? '<span class="lbl">Star 排行 Top 5：</span>' + rankHtml : '';

    rebuildLangOptions();

    document.getElementById('modeBox').style.display = hasLocal ? '' : 'none';
    if (!hasLocal && state.mode !== 'both') state.mode = 'both';
    document.getElementById('mainScroll').style.display = state.mode === 'local' ? 'none' : '';
    var rows = visibleRows();
    document.getElementById('tbody').innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<tr><td class="empty" colspan="17">没有匹配的仓库 —— 试试清空搜索或放宽筛选条件</td></tr>';
    renderLocalBox();

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

  /* ---------- 本地扫描与视图模式 ---------- */
  function doScanLocal() {
    if (state.scanning) return;
    state.scanning = true;
    var btn = document.getElementById('scanLocalBtn');
    btn.classList.add('scanning');
    btn.querySelector('.lbl').textContent = '扫描中…';
    setHint('正在扫描本机 Git 仓库（遍历目录 + 读取 .git 状态，不访问 GitHub）…');
    fetch('/api/scan-local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
      })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'HTTP 错误');
        state.data = j.data;
        updateArr();
        setMode(state.mode, true);
        render();
        var ls = state.data.localScan;
        setHint('本地扫描完成：' + fullTime(ls.scannedAt) + ' · 本机 ' + ls.count + ' 仓 · 对上 ' + ls.matched + ' · dashboard.html 与 scan-data.json 已写入磁盘', 'okc');
      })
      .catch(function (e) {
        var m = String((e && e.message) || e);
        if (/failed to fetch|networkerror|load failed|fetch failed/i.test(m)) {
          m = '未检测到本地服务：请先运行 node server.mjs，或命令行 node scan.mjs --local-only';
        }
        setHint('本地扫描失败：' + m, 'err');
      })
      .then(function () {
        state.scanning = false;
        btn.classList.remove('scanning');
        btn.querySelector('.lbl').textContent = '仅扫本地';
      });
  }

  function setMode(m, skipRender) {
    var hasLocal = !!(state.data && state.data.localScan);
    state.mode = (m === 'local' && hasLocal) ? 'local' : 'both';
    try { localStorage.setItem(MODE_KEY, state.mode); } catch (e) {}
    document.getElementById('modeBoth').className = 'btn' + (state.mode === 'both' ? ' on' : '');
    document.getElementById('modeLocal').className = 'btn' + (state.mode === 'local' ? ' on' : '');
    if (!skipRender) render();
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
    return { q: state.q, fLang: state.fLang, fStatus: state.fStatus, noFork: state.noFork, noArchived: state.noArchived, sortKey: state.sortKey, sortDir: state.sortDir };
  }
  function applyView(v) {
    state.q = v.q || ''; document.getElementById('q').value = state.q;
    state.fLang = v.fLang || ''; document.getElementById('fLang').value = state.fLang;
    state.fStatus = v.fStatus || ''; document.getElementById('fStatus').value = state.fStatus;
    state.noFork = !!v.noFork; document.getElementById('fNoFork').checked = state.noFork;
    state.noArchived = !!v.noArchived; document.getElementById('fNoArchived').checked = state.noArchived;
    state.sortKey = SORT_VAL[v.sortKey] ? v.sortKey : 'pushedAt';
    state.sortDir = v.sortDir === 'asc' ? 'asc' : 'desc';
    saveSort(); updateArr(); rebuildLangOptions(); render();
  }

  /* ---------- 导出 CSV（当前筛选/排序结果） ---------- */
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function exportCsv() {
    var rows = visibleRows();
    var head = ['仓库', '可见性', '本地状态', '健康分', '健康等级', 'CI', '许可证', 'Release', 'Issue', 'PR', '分支', 'Star', 'Fork', '语言', '大小(KB)', '流量浏览', '流量克隆', '最近变更文件数', '最近推送', 'URL'];
    var lines = [head.map(csvCell).join(',')];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var g = gradeOf(scoreOf(r));
      var vis = r.visibility === 'PRIVATE' ? '私有' : (r.visibility === 'PUBLIC' ? '公开' : '');
      var local = r.local
        ? (r.local.dirty ? '未提交 ' + (r.local.dirtyCount || 0)
          : (((r.local.ahead || 0) > 0 || (r.local.behind || 0) > 0) ? '本地与远程不一致' : '本地有'))
        : '本地缺失';
      lines.push([
        r.name, vis, local, scoreOf(r), g.g, r.ci.state, r.license || '',
        r.latestRelease ? r.latestRelease.tag : '', r.openIssues, r.openPRs, r.branches, r.stars, r.forks,
        r.language || '', r.size || 0, r.traffic ? r.traffic.views : '', r.traffic ? r.traffic.clones : '',
        r.lastCommit ? r.lastCommit.fileCount : '', relTime(r.pushedAt), r.url,
      ].map(csvCell).join(','));
    }
    var csv = '﻿' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.data && state.data.owner ? state.data.owner : 'github') + '-repos-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setHint('已导出 ' + rows.length + ' 个仓库到 CSV（UTF-8，Excel 可直接打开）', 'okc');
  }

  /* ---------- 复制 clone 命令 ---------- */
  function copyClones() {
    var rows = visibleRows();
    if (!rows.length) { setHint('当前没有可见仓库可复制', 'err'); return; }
    var text = rows.map(function (r) { return 'git clone ' + r.url; }).join('\n');
    function done() { setHint('已复制 ' + rows.length + ' 条 git clone 命令到剪贴板', 'okc'); }
    function fb() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); done();
      } catch (e) { setHint('复制失败（浏览器限制）：可在控制台手动复制', 'err'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fb);
    else fb();
  }

  /* ---------- 启动 ---------- */
  function boot() {
    var saved = 'light';
    try { saved = localStorage.getItem(THEME_KEY) || 'light'; } catch (e) {}
    applyTheme(saved);

    document.getElementById('scanBtn').querySelector('.ico').innerHTML = SVG_SYNC;
    document.getElementById('scanBtn').addEventListener('click', doScan);
    document.getElementById('scanLocalBtn').querySelector('.ico2').innerHTML = SVG_FOLDER;
    document.getElementById('scanLocalBtn').addEventListener('click', doScanLocal);
    document.getElementById('modeBoth').addEventListener('click', function () { setMode('both'); });
    document.getElementById('modeLocal').addEventListener('click', function () { setMode('local'); });
    document.getElementById('cfgBtn').addEventListener('click', function () {
      var d = state.data || {};
      var cur = ((d.localScan && d.localScan.roots) || []).join(' ; ');
      var input = prompt('本地扫描根目录（分号分隔；留空恢复默认：主目录1层 + 桌面/文档/下载）:', cur);
      if (input === null) return;
      var roots = input.split(/[;；]/).map(function (s) { return s.trim(); }).filter(Boolean);
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ localScanRoots: roots }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || 'HTTP 错误');
          setHint(roots.length ? '本地目录已保存（' + roots.length + ' 个）：点「重新扫描」或「仅扫本地」生效' : '已清空自定义目录，恢复默认探测：点「重新扫描」或「仅扫本地」生效', 'okc');
        })
        .catch(function () {
          setHint('保存失败（需本地服务 node server.mjs）；也可命令行临时指定：node scan.mjs --local-paths "目录1;目录2"', 'err');
        });
    });
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
    var na = document.getElementById('fNoArchived');
    na.addEventListener('change', function () { state.noArchived = na.checked; render(); });
    var asEl = document.getElementById('fAutoScanStart');
    asEl.addEventListener('change', function () {
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoScanOnStart: asEl.checked ? 'always' : 'off' }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (j) {
          if (!j.ok) setHint('保存启动扫描偏好失败（需本地服务 node server.mjs）', 'err');
          else setHint(asEl.checked ? '已开启：下次启动面板将先自动扫描（约 20–40 秒）再打开页面' : '已关闭启动前自动扫描', 'okc');
        });
    });
    document.getElementById('csvBtn').addEventListener('click', exportCsv);
    document.getElementById('cloneBtn').addEventListener('click', copyClones);
    document.getElementById('alertBox').addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.alert-chip') : null;
      if (chip && chip.getAttribute('data-status')) {
        var st = chip.getAttribute('data-status');
        state.fStatus = st;
        document.getElementById('fStatus').value = st;
        render();
        setHint('已按聚合视图筛选：' + chip.textContent.replace(/^[⚠\s]+/, '').replace(/\s+/g, ' ').trim(), 'okc');
      }
    });
    document.getElementById('tbody').addEventListener('click', function (e) {
      var tgl = e.target.closest ? e.target.closest('.filetoggle') : null;
      if (tgl && tgl.getAttribute('data-name')) {
        var nm = tgl.getAttribute('data-name');
        if (state.expanded[nm]) delete state.expanded[nm]; else state.expanded[nm] = true;
        render();
      }
    });
    var au = document.getElementById('auto');
    au.addEventListener('change', function () { applyAuto(false); });
    var savedAuto = '0';
    try { savedAuto = localStorage.getItem(AUTO_KEY) || '0'; } catch (e) {}
    if (['10', '30', '60'].indexOf(savedAuto) >= 0) au.value = savedAuto;
    applyAuto(true);

    // 启动前扫描开关：从服务端配置回填复选框（无本地服务时静默跳过，默认不勾选）
    fetch('/api/config').then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (j) {
        if (j && j.ok && j.config) {
          var m = String(j.config.autoScanOnStart || 'first').toLowerCase();
          document.getElementById('fAutoScanStart').checked = (m === 'always' || m === 'stale');
        }
      }).catch(function () {});

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

    try { if (localStorage.getItem(MODE_KEY) === 'local') state.mode = 'local'; } catch (e) {}
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
