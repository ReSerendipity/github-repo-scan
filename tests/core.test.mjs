// 冒烟测试：node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { ciStateOf, relTime, fullTime, renderDashboard, scoreOf, gradeOf, applyJq, parseRemoteUrl, findGitRepos, matchLocalToRemote, applyLocalTotals, fmtSize, computeStarWeek } from "../scan-core.mjs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ciStateOf：无运行记录", () => {
  const s = ciStateOf(null);
  assert.equal(s.label, "无 CI 记录");
  assert.equal(s.cls, "none");
});

test("ciStateOf：状态映射", () => {
  assert.equal(ciStateOf({ status: "completed", conclusion: "success" }).cls, "ok");
  assert.equal(ciStateOf({ status: "completed", conclusion: "failure" }).cls, "fail");
  assert.equal(ciStateOf({ status: "completed", conclusion: "timed_out" }).cls, "fail");
  assert.equal(ciStateOf({ status: "in_progress", conclusion: null }).cls, "running");
  assert.equal(ciStateOf({ status: "queued", conclusion: null }).cls, "running");
  assert.equal(ciStateOf({ status: "completed", conclusion: "cancelled" }).label, "已取消");
  assert.equal(ciStateOf({ status: "completed", conclusion: "skipped" }).label, "跳过");
  assert.equal(ciStateOf({ status: "completed", conclusion: "whatever" }).label, "未知");
});

test("relTime：相对时间分档", () => {
  const now = Date.now();
  assert.equal(relTime(new Date(now - 2 * 86400000).toISOString()), "2 天前");
  assert.equal(relTime(new Date(now - 40 * 86400000).toISOString()), "1 个月前");
  assert.equal(relTime(new Date(now - 400 * 86400000).toISOString()), "1.1 年前");
  assert.equal(relTime(null), "—");
});

test("fullTime：固定按上海时区", () => {
  assert.ok(fullTime("2026-09-21T00:00:00Z").includes("2026/9/21"));
  assert.equal(fullTime(null), "—");
});

test("renderDashboard：内嵌数据、XSS 转义、浅色默认", () => {
  const data = {
    schema: 2,
    owner: "demo",
    avatarUrl: "",
    scannedAt: "2026-09-21T00:00:00Z",
    truncated: false,
    rate: { limit: 5000, remaining: 4999, reset: 1789999999 },
    totals: { repos: 1, totalRepos: 1, stars: 0, forks: 0, openIssues: 0, openPRs: 0, releases: 0, ciDone: 0, ciOk: 0 },
    rows: [
      {
        name: 'x</script><script>alert(1)</script>',
        url: "https://github.com/a/x",
        description: "<b>desc</b>",
        visibility: "PUBLIC",
        isArchived: false,
        isFork: false,
        createdAt: "2026-01-01T00:00:00Z",
        pushedAt: "2026-09-21T00:00:00Z",
        stars: 0,
        forks: 0,
        openIssues: 0,
        openPRs: 0,
        branches: 1,
        defaultBranch: "main",
        license: null,
        licenseUrl: null,
        releases: 0,
        latestRelease: null,
        ci: { state: "无 CI 记录", cls: "none", workflow: null, ref: null, ranAt: null, url: null, trend: [] },
        language: "Python",
        langColor: "#3572A5",
      },
    ],
  };
  const html = renderDashboard(data);
  assert.ok(html.includes('data-theme="light"'), "默认应为浅色");
  assert.ok(html.includes("__SCAN_DATA__"), "应内嵌数据");
  assert.ok(html.includes('th class="sortable"'), "应有排序表头");
  assert.ok(html.includes('id="q"'), "应有搜索框");
  // 内嵌 JSON 中的 < 必须转义为 \u003c：夹带的 </script> 不得以原样出现，
  // 全文只允许两处真实闭合标签（两个 script 块）
  assert.ok(html.includes("\\u003c"), "内嵌 JSON 的 < 应被 \\u003c 转义");
  assert.ok(!html.includes("<b>desc</b>"), "原始 HTML 不得原样出现");
  assert.ok(!html.includes("<script>alert(1)"), "夹带的 script 不得原样出现");
  assert.equal(html.match(/<\/script>/g).length, 2);
  // 配额/截断展示为客户端渲染：验证容器与内嵌配额数据
  assert.ok(html.includes('id="footExtra"'), "应有配额/截断展示容器");
  assert.ok(html.includes('"remaining":4999'), "内嵌数据应包含 API 配额");
});

test("scoreOf:健康分构成与归档折扣", () => {
  const now = Date.now();
  const healthy = {
    pushedAt: new Date(now - 2 * 86400000).toISOString(),
    openIssues: 0,
    releases: 3,
    latestRelease: { publishedAt: new Date(now - 10 * 86400000).toISOString() },
    ci: { cls: "ok", trend: [{ c: "success" }, { c: "success" }, { c: "success" }] },
  };
  assert.equal(scoreOf(healthy), 100);
  assert.deepEqual(gradeOf(100), { g: "A", cls: "ok" });
  assert.deepEqual(gradeOf(72), { g: "B", cls: "info" });
  assert.deepEqual(gradeOf(55), { g: "C", cls: "warn" });
  assert.deepEqual(gradeOf(30), { g: "D", cls: "fail" });
  const dead = { pushedAt: new Date(now - 400 * 86400000).toISOString(), openIssues: 40, releases: 0, latestRelease: null, ci: { cls: "fail", trend: [] } };
  const deadScore = scoreOf(dead);
  assert.ok(deadScore < 30);
  assert.equal(scoreOf({ ...dead, isArchived: true }), Math.round(deadScore * 0.7), "归档仓应打七折");
});

test("renderDashboard:健康分/流量/视图控件就位", () => {
  const data = { schema: 2, owner: "demo", avatarUrl: "", scannedAt: "2026-09-21T00:00:00Z", truncated: false, rate: null,
    totals: { repos: 0, totalRepos: 0, stars: 0, forks: 0, openIssues: 0, openPRs: 0, releases: 0, ciDone: 0, ciOk: 0 }, rows: [] };
  const html = renderDashboard(data);
  assert.ok(html.includes('data-key="score"'), "应有健康分表头");
  assert.ok(html.includes('data-key="traffic"'), "应有流量表头");
  assert.ok(html.includes('id="fView"'), "应有视图下拉");
  assert.ok(!html.includes('colspan="10"'), "列数扩展后不应残留 10 列占位");
});

test("applyJq:直连兜底的极简点路径", () => {
  assert.equal(applyJq({ login: "x" }, ".login"), "x");
  assert.deepEqual(applyJq({ resources: { core: { remaining: 5 } } }, ".resources.core"), { remaining: 5 });
  assert.equal(applyJq({}, ".a.b"), undefined);
});

test("parseRemoteUrl:https/ssh/scp 与非 GitHub", () => {
  assert.deepEqual(parseRemoteUrl("https://github.com/Me/My.Repo.git"), { host: "github.com", owner: "Me", repo: "My.Repo", isGitHub: true });
  assert.deepEqual(parseRemoteUrl("git@github.com:me/repo.git"), { host: "github.com", owner: "me", repo: "repo", isGitHub: true });
  assert.deepEqual(parseRemoteUrl("ssh://git@github.com/me/repo/"), { host: "github.com", owner: "me", repo: "repo", isGitHub: true });
  assert.equal(parseRemoteUrl("https://github.com/u/repo.github.io.git").repo, "repo.github.io");
  assert.equal(parseRemoteUrl("https://gitlab.com/g/r.git").isGitHub, false);
  assert.equal(parseRemoteUrl("not a url"), null);
  assert.equal(parseRemoteUrl(null), null);
});

test("findGitRepos:深度、剪枝与去重", () => {
  const base = mkdtempSync(join(tmpdir(), "grs-test-"));
  try {
    mkdirSync(join(base, "a", "repo1", ".git"), { recursive: true });
    mkdirSync(join(base, "a", "sub", "repo2", ".git"), { recursive: true });
    mkdirSync(join(base, "a", "node_modules", "evil", ".git"), { recursive: true });
    mkdirSync(join(base, "b", "deep", "d2", "d3", "d4", "repo3", ".git"), { recursive: true });
    mkdirSync(join(base, "b", ".hidden", "repo4", ".git"), { recursive: true });
    const found = findGitRepos([base], 4);
    const names = found.map((p) => p.slice(base.length + 1));
    assert.ok(names.includes(join("a", "repo1")));
    assert.ok(names.includes(join("a", "sub", "repo2")));
    assert.ok(!names.some((p) => p.includes("node_modules")), "node_modules 应被剪枝");
    assert.ok(!names.some((p) => p.includes("repo3")), "超出深度不应找到");
    assert.ok(!names.some((p) => p.includes("hidden")), "隐藏目录应被剪枝");
    const twice = findGitRepos([base, base], 4);
    assert.equal(twice.length, found.length, "重复根不应产生重复结果");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("matchLocalToRemote:owner/repo 精准、按名兜底与本地独有", () => {
  const data = { rows: [
    { name: "a", url: "https://github.com/me/a" },
    { name: "b", url: "https://github.com/me/b" },
    { name: "dup", url: "https://github.com/me/dup" },
    { name: "dup", url: "https://github.com/me/dup2" },
  ] };
  const ls = { repos: [
    { name: "a", path: "P1", github: { owner: "me", repo: "a", isGitHub: true }, dirty: true, dirtyCount: 2, ahead: 1, behind: null },
    { name: "b", path: "P2", github: { owner: "other", repo: "b", isGitHub: true } },
    { name: "dup", path: "P3", github: { owner: "x", repo: "dup", isGitHub: true } },
    { name: "orphan", path: "P4", github: null, remoteUrl: null },
  ] };
  const res = matchLocalToRemote(data, ls);
  assert.equal(res.matched, 2);
  assert.equal(data.rows[0].local.path, "P1");
  assert.equal(data.rows[0].local.dirty, true);
  assert.equal(data.rows[1].local.path, "P2", "owner 不同时按唯一同名兜底");
  assert.equal(data.rows[2].local, null, "同名多候选不应乱配");
  assert.equal(ls.repos[2].matchType, "ambiguous");
  assert.equal(ls.localOnlyCount, 2);
  assert.equal(ls.matched, 2);
});

test("applyLocalTotals:有/无本地扫描", () => {
  const d1 = { rows: [{ local: { path: "p" } }, { local: null }], localScan: { count: 2, matched: 1, localOnlyCount: 1, repos: [{ dirty: true }, { dirty: false, ahead: 2, behind: 0 }] }, totals: {} };
  applyLocalTotals(d1);
  assert.equal(d1.totals.localTotal, 2);
  assert.equal(d1.totals.localMatched, 1);
  assert.equal(d1.totals.localMissing, 1);
  assert.equal(d1.totals.localDirty, 1);
  assert.equal(d1.totals.localDiverged, 1);
  const d2 = { rows: [], localScan: null, totals: {} };
  applyLocalTotals(d2);
  assert.equal(d2.totals.localTotal, null);
});

test("renderDashboard:本地对照列/模式切换/本地独有区块就位", () => {
  const data = { schema: 3, owner: "demo", avatarUrl: "", scannedAt: "2026-09-21T00:00:00Z", truncated: false, rate: null,
    totals: { repos: 0, totalRepos: 0, stars: 0, forks: 0, openIssues: 0, openPRs: 0, releases: 0, ciDone: 0, ciOk: 0, localTotal: 0, localMatched: 0, localMissing: 0, localOnly: 0, localDirty: 0, localDiverged: 0 },
    rows: [],
    localScan: { scannedAt: "2026-09-22T00:00:00Z", roots: ["C:\\x"], depth: 4, count: 0, matched: 0, localOnlyCount: 0, repos: [] } };
  const html = renderDashboard(data);
  assert.ok(html.includes('data-key="local"'), "应有本地列表头");
  assert.ok(html.includes('id="localOnlyBox"'), "应有本地独有区块");
  assert.ok(html.includes('id="scanLocalBtn"'), "应有仅扫本地按钮");
  assert.ok(html.includes('id="modeLocal"'), "应有模式切换");
  assert.ok(html.includes('id="cfgBtn"'), "应有本地目录设置");
  assert.ok(html.includes('id="csvBtn"'), "应有导出 CSV 按钮");
  assert.ok(html.includes('data-key="visibility"'), "应有可见性表头");
  assert.ok(html.includes('data-key="size"'), "应有大小表头");
  assert.ok(html.includes('data-key="files"'), "应有最近变更表头");
  assert.ok(html.includes('id="cloneBtn"'), "应有复制 clone 按钮");
  assert.ok(html.includes('id="alertBox"'), "应有聚合视图面板");
  assert.ok(html.includes('id="langBox"'), "应有语言分布面板");
  assert.ok(html.includes('id="rankBox"'), "应有排行榜面板");
  assert.ok(html.includes('id="archivedBox"'), "应有归档仓库分区");
  assert.ok(html.includes('rank-metric'), "排行榜应支持指标切换");
  assert.ok(html.includes('value="archived"'), "应有仅归档筛选选项");
  assert.ok(html.includes('data-key="createdAt"'), "应有创建时间表头");
  assert.ok(html.includes('colspan="17"'), "列数应为 17");
  assert.ok(!html.includes('colspan="16"'), "不应残留 16 列占位");
});

test("renderDashboard:可见性/大小/最近变更 已接入模板与脚本", () => {
  const data = {
    schema: 3, owner: "demo", avatarUrl: "", scannedAt: "2026-09-21T00:00:00Z", truncated: false, rate: null,
    totals: { repos: 2, totalRepos: 2, stars: 0, forks: 0, openIssues: 0, openPRs: 0, releases: 0, ciDone: 0, ciOk: 0, sizeTotal: 2048 },
    rows: [
      { name: "pub-repo", url: "u", description: "d", visibility: "PUBLIC", isArchived: false, isFork: false, createdAt: "2026-01-01T00:00:00Z", pushedAt: "2026-09-21T00:00:00Z", stars: 0, forks: 0, size: 1024, openIssues: 0, openPRs: 0, branches: 1, defaultBranch: "main", license: null, licenseUrl: null, releases: 0, latestRelease: null, ci: { state: "无 CI 记录", cls: "none", workflow: null, ref: null, ranAt: null, url: null, trend: [] }, language: "Python", langColor: "#3572A5", lastCommit: null },
      { name: "priv-repo", url: "u", description: "d", visibility: "PRIVATE", isArchived: false, isFork: false, createdAt: "2026-01-01T00:00:00Z", pushedAt: "2026-09-21T00:00:00Z", stars: 0, forks: 0, size: 1024, openIssues: 0, openPRs: 0, branches: 1, defaultBranch: "main", license: null, licenseUrl: null, releases: 0, latestRelease: null, ci: { state: "无 CI 记录", cls: "none", workflow: null, ref: null, ranAt: null, url: null, trend: [] }, language: "Go", langColor: "#00ADD8", lastCommit: null },
    ],
  };
  const html = renderDashboard(data);
  // 行级内容由前端 JS 渲染，静态模板里只含 thead / 控件 / 脚本；这里校验功能已正确接线
  assert.ok(html.includes('data-key="visibility"'), "应有可见性表头");
  assert.ok(html.includes('data-key="size"'), "应有大小表头");
  assert.ok(html.includes('data-key="files"'), "应有最近变更表头");
  assert.ok(html.includes('id="csvBtn"'), "应有导出 CSV 按钮");
  assert.ok(html.includes('id="fNoArchived"'), "应有隐藏归档复选框");
  assert.ok(html.includes('id="fAutoScanStart"'), "应有启动前扫描复选框");
  assert.ok(html.includes(".scorebar"), "样式中应定义健康分进度条");
  assert.ok(html.includes("visibilityCell") && html.includes("sizeCell") && html.includes("filesCell"), "脚本应含新单元格渲染函数");
  assert.ok(html.includes("exportCsv") && html.includes("fmtSize"), "脚本应含导出与大小格式化函数");
  // fmtSize 已提升为模块级导出函数，可直接单测
  assert.equal(fmtSize(0), "—");
  assert.equal(fmtSize(512), "512 KB");
  assert.equal(fmtSize(1024), "1.0 MB");
  assert.equal(fmtSize(2048), "2.0 MB");
  assert.equal(fmtSize(1048576), "1.00 GB");
});

test("computeStarWeek：基于历史快照计算近 7 天 Star 增量", () => {
  const now = "2026-09-23T00:00:00Z";
  const weekAgo = "2026-09-15T00:00:00Z";
  const data = {
    scannedAt: now,
    rows: [
      { name: "a", stars: 120 },
      { name: "b", stars: 50 },
      { name: "c", stars: 10 },
    ],
  };
  const hist = [
    { t: weekAgo, repos: { a: 100, b: 55, c: 10 } },
    { t: "2026-09-20T00:00:00Z", repos: { a: 110, b: 52, c: 10 } },
  ];
  computeStarWeek(data, hist);
  assert.equal(data.starWeekRef, weekAgo, "应取 7 天前的快照作基准");
  assert.equal(data.rows[0].starWeek, 20, "120 - 100 = +20");
  assert.equal(data.rows[1].starWeek, -5, "50 - 55 = -5");
  assert.equal(data.rows[2].starWeek, 0, "10 - 10 = 0");
});

test("computeStarWeek：历史不足 6 天应返回 null（不编造数据）", () => {
  const data = { scannedAt: "2026-09-23T00:00:00Z", rows: [{ name: "a", stars: 10 }] };
  const hist = [{ t: "2026-09-22T00:00:00Z", repos: { a: 5 } }]; // 仅 1 天前
  computeStarWeek(data, hist);
  assert.equal(data.rows[0].starWeek, null);
  assert.equal(data.starWeekRef, null);
});

test("computeStarWeek：无历史应返回 null", () => {
  const data = { scannedAt: "2026-09-23T00:00:00Z", rows: [{ name: "a", stars: 10 }] };
  computeStarWeek(data, []);
  assert.equal(data.rows[0].starWeek, null);
  assert.equal(data.starWeekRef, null);
});
