#!/usr/bin/env node
/**
 * 命令行入口
 *   node scan.mjs [owner]         扫描并重新生成 dashboard.html + scan-data.json
 *   node scan.mjs --render-only   不重新扫描，按现有快照重渲染面板（改样式/默认主题后用）
 * 页面内一键刷新请用：node server.mjs（或双击 启动面板.bat）
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectData, writeOutputs, printSummary, renderDashboard, HERE } from "./scan-core.mjs";

const args = process.argv.slice(2);
const renderOnly = args.includes("--render-only");
const ownerArg = args.find((a) => !a.startsWith("--"));

try {
  if (renderOnly) {
    const data = JSON.parse(readFileSync(join(HERE, "scan-data.json"), "utf8"));
    writeFileSync(join(HERE, "dashboard.html"), renderDashboard(data), "utf8");
    console.log("✔ 已按现有快照重新渲染 dashboard.html（未重新扫描）");
  } else {
    const data = await collectData(ownerArg);
    writeOutputs(data);
    printSummary(data);
  }
} catch (err) {
  console.error("✖ 执行失败：" + (err?.message ?? err));
  console.error("  请确认：1) 已安装并登录 gh CLI（gh auth login）；2) Node 版本 ≥ 18。");
  process.exit(1);
}
