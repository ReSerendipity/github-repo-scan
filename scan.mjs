#!/usr/bin/env node
/**
 * 命令行入口
 *   node scan.mjs [owner]                远程扫描 + 本地对照（默认）
 *   node scan.mjs --local-only           仅扫描本机 Git 仓库（不访问 GitHub），并入现有快照
 *   node scan.mjs --remote-only          仅远程扫描，跳过本地对照
 *   node scan.mjs --local-paths "a;b"    覆盖本地扫描根目录（分号分隔）
 *   node scan.mjs --depth 5              覆盖本地扫描深度
 *   node scan.mjs --render-only          不扫描，按现有快照重渲染面板（改样式/默认主题后用）
 * 页面内一键刷新请用：node server.mjs（或双击 启动面板.bat）
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectData, collectLocal, mergeLocalSnapshot, writeOutputs, printSummary, renderDashboard, HERE, readLocalConfig } from "./scan-core.mjs";

const args = process.argv.slice(2);
const renderOnly = args.includes("--render-only");
const localOnly = args.includes("--local-only");
const remoteOnly = args.includes("--remote-only");
const pathsIdx = args.indexOf("--local-paths");
const depthIdx = args.indexOf("--depth");
const cfg = readLocalConfig();
const depth = depthIdx >= 0 ? Number(args[depthIdx + 1]) : (Number.isFinite(cfg.localScanDepth) ? cfg.localScanDepth : 4);
const localPaths = pathsIdx >= 0
  ? String(args[pathsIdx + 1] ?? "").split(/[;；]/).map((s) => s.trim()).filter(Boolean)
  : undefined;
const ownerArg = args.find((a, i) =>
  !a.startsWith("--") &&
  (pathsIdx < 0 || i !== pathsIdx + 1) &&
  (depthIdx < 0 || i !== depthIdx + 1));

try {
  if (renderOnly) {
    const data = JSON.parse(readFileSync(join(HERE, "scan-data.json"), "utf8"));
    writeFileSync(join(HERE, "dashboard.html"), renderDashboard(data), "utf8");
    console.log("✔ 已按现有快照重新渲染 dashboard.html（未重新扫描）");
  } else if (localOnly) {
    const localScan = await collectLocal({ roots: localPaths, depth });
    const data = mergeLocalSnapshot(localScan);
    writeOutputs(data);
    printSummary(data);
  } else {
    const data = await collectData(ownerArg, { local: !remoteOnly, roots: localPaths, depth });
    writeOutputs(data);
    printSummary(data);
  }
} catch (err) {
  console.error("✖ 执行失败：" + (err?.message ?? err));
  console.error("  请确认：1) 远程扫描需要 gh CLI 已登录（gh auth login）或设 GH_TOKEN；2) 本地扫描需要 git 在 PATH 中；3) Node 版本 ≥ 18。");
  process.exit(1);
}
