// 冒烟测试：node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { ciStateOf, relTime, fullTime, renderDashboard } from "../scan-core.mjs";

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
