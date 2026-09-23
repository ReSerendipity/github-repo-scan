#!/usr/bin/env node
/**
 * 本地服务：node server.mjs [--port 8787]
 *
 * 路由：
 *   GET  /                → dashboard.html（内嵌最新快照的交互面板）
 *   GET  /dashboard.html  → 同上
 *   GET  /api/data        → 最近一次扫描数据（JSON）
 *   POST /api/scan        → 重新扫描（远程 + 本地对照，复用 gh CLI + 本机 git），原地返回最新数据并更新磁盘文件
 *   POST /api/scan-local  → 仅扫描本机 Git 仓库（不访问 GitHub），并入现有快照
 *   GET  /api/config      → 读取本地扫描配置（scan-config.json）
 *   POST /api/config      → 保存本地扫描配置（localScanRoots / localScanDepth）
 *
 * 仅监听 127.0.0.1；扫描耗时约 20–40 秒（30+ 个 GitHub API 调用）。
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { collectData, collectLocal, mergeLocalSnapshot, writeOutputs, readLocalConfig, writeLocalConfig, HERE } from "./scan-core.mjs";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const basePort = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;
let busy = false;

/* 启动前自动扫描决策：
 *   always → 每次启动都先扫描再开页面（约 20–40 秒）
 *   stale  → 仅当无快照或快照比 autoScanMaxAgeHours（默认 6）小时更旧时扫描
 *   first  → 仅当没有快照时扫描（保持旧版默认行为）
 *   off    → 从不自动扫描（页面用现有快照，无快照则显示「开始第一次扫描」）
 * CLI --scan-on-start=<mode> 优先级最高；否则读 scan-config.json 的 autoScanOnStart。
 */
function decideStartupScan() {
  const idx = args.indexOf("--scan-on-start");
  let mode = null;
  if (idx >= 0 && args[idx + 1]) mode = String(args[idx + 1]).toLowerCase();
  if (!mode) mode = String(readLocalConfig().autoScanOnStart || "first").toLowerCase();
  if (mode === "off" || mode === "first") return mode === "first" && !existsSync(join(HERE, "scan-data.json"));
  if (mode === "always") return true;
  if (mode === "stale") {
    const maxAgeH = Number(readLocalConfig().autoScanMaxAgeHours) || 6;
    if (!existsSync(join(HERE, "scan-data.json"))) return true;
    try {
      const d = JSON.parse(readFileSync(join(HERE, "scan-data.json"), "utf8"));
      const ageMs = Date.now() - new Date(d.scannedAt || 0).getTime();
      return ageMs > maxAgeH * 3600 * 1000;
    } catch { return true; }
  }
  return false;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function sameOriginOk(req) {
  const origin = req.headers.origin || "";
  return !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function bootstrapPage() {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GitHub 仓库总览</title>' +
    '<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;display:grid;place-items:center;height:100vh">' +
    '<div style="text-align:center"><p>尚未生成面板数据。</p>' +
    '<button onclick="fetch(\'/api/scan\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:\'{}\'}).then(r=>r.json()).then(j=>{if(j.ok)location.reload();else alert(j.error)})" ' +
    'style="padding:10px 22px;font-size:15px;cursor:pointer">开始第一次扫描</button></div></body></html>';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    if ((url.pathname === "/" || url.pathname === "/dashboard.html") && req.method === "GET") {
      const f = join(HERE, "dashboard.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(existsSync(f) ? readFileSync(f) : bootstrapPage());
    }
    if (url.pathname === "/api/data" && req.method === "GET") {
      try {
        const data = JSON.parse(readFileSync(join(HERE, "scan-data.json"), "utf8"));
        return sendJson(res, 200, { ok: true, data });
      } catch {
        return sendJson(res, 404, { ok: false, error: "尚无扫描数据：点击页面里的「重新扫描」，或运行 node scan.mjs" });
      }
    }
    if (url.pathname === "/api/scan" && req.method === "POST") {
      // 阻断跨站触发：浏览器发起的跨域 POST 必带 Origin 头；curl 等本地客户端无 Origin，放行
      if (!sameOriginOk(req)) {
        return sendJson(res, 403, { ok: false, error: "拒绝跨域来源的扫描请求：" + (req.headers.origin || "") });
      }
      if (busy) return sendJson(res, 409, { ok: false, error: "已有一次扫描正在进行，请稍候" });
      busy = true;
      const body = await readBody(req);
      console.log("▸ [" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "] 收到扫描请求" + (body.owner ? "（账号 " + body.owner + "）" : "") + "…");
      try {
        const data = await collectData(body.owner);
        writeOutputs(data, true);
        console.log("✔ 扫描完成：" + data.totals.repos + " 个仓库 · CI 通过 " + data.totals.ciOk + "/" + data.totals.ciDone + " · dashboard.html / scan-data.json 已更新");
        return sendJson(res, 200, { ok: true, data });
      } catch (e) {
        console.error("✖ 扫描失败：" + (e?.message ?? e));
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
      } finally {
        busy = false;
      }
    }
    if (url.pathname === "/api/scan-local" && req.method === "POST") {
      if (!sameOriginOk(req)) {
        return sendJson(res, 403, { ok: false, error: "拒绝跨域来源的扫描请求：" + (req.headers.origin || "") });
      }
      if (busy) return sendJson(res, 409, { ok: false, error: "已有一次扫描正在进行，请稍候" });
      busy = true;
      const body = await readBody(req);
      console.log("▸ [" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "] 收到本地扫描请求…");
      try {
        const cfg = readLocalConfig();
        const depth = Number.isFinite(body.depth) ? body.depth : (Number.isFinite(cfg.localScanDepth) ? cfg.localScanDepth : 4);
        const roots = Array.isArray(body.paths) && body.paths.length ? body.paths : undefined;
        const localScan = await collectLocal({ roots, depth });
        const data = mergeLocalSnapshot(localScan);
        writeOutputs(data);
        console.log("✔ 本地扫描完成：" + localScan.count + " 个本地仓库 · 对照上 " + localScan.matched + " 个 · dashboard.html / scan-data.json 已更新");
        return sendJson(res, 200, { ok: true, data });
      } catch (e) {
        console.error("✖ 本地扫描失败：" + (e?.message ?? e));
        return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
      } finally {
        busy = false;
      }
    }
    if (url.pathname === "/api/config") {
      if (!sameOriginOk(req)) {
        return sendJson(res, 403, { ok: false, error: "拒绝跨域来源的请求：" + (req.headers.origin || "") });
      }
      if (req.method === "GET") return sendJson(res, 200, { ok: true, config: readLocalConfig() });
      if (req.method === "POST") {
        const body = await readBody(req);
        const patchCfg = {};
        if (body && Array.isArray(body.localScanRoots)) {
          const roots = body.localScanRoots.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
          patchCfg.localScanRoots = roots.length ? roots : null; // 清空 → 恢复默认探测
        }
        if (body && Number.isFinite(body.localScanDepth)) {
          patchCfg.localScanDepth = Math.max(1, Math.min(10, Math.floor(body.localScanDepth)));
        }
        if (body && typeof body.autoScanOnStart === "string") {
          const m = body.autoScanOnStart.toLowerCase();
          if (["always", "stale", "first", "off"].includes(m)) patchCfg.autoScanOnStart = m;
        }
        if (body && Number.isFinite(body.autoScanMaxAgeHours)) {
          patchCfg.autoScanMaxAgeHours = Math.max(1, Math.min(720, Math.floor(body.autoScanMaxAgeHours)));
        }
        const merged = { ...readLocalConfig() };
        for (const [k, v] of Object.entries(patchCfg)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        writeLocalConfig(merged);
        return sendJson(res, 200, { ok: true, config: merged });
      }
    }
    return sendJson(res, 404, { ok: false, error: "Not Found" });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

function openBrowser(url) {
  try {
    if (process.platform === "win32") spawn("explorer", [url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch { /* 打不开浏览器不影响服务 */ }
}

let fallback = false;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && !fallback) {
    fallback = true;
    console.log("▸ 端口 " + basePort + " 被占用，改用随机端口…");
    server.listen(0, "127.0.0.1");
  } else {
    console.error("✖ 服务启动失败：" + e.message);
    process.exit(1);
  }
});

// 启动前自动扫描：依据 decideStartupScan() 决定是否先扫一遍再开页面
const _scanMode = (() => {
  const idx = args.indexOf("--scan-on-start");
  if (idx >= 0 && args[idx + 1]) return String(args[idx + 1]).toLowerCase();
  return String(readLocalConfig().autoScanOnStart || "first").toLowerCase();
})();
if (decideStartupScan()) {
  console.log("▸ 启动前自动扫描（模式 " + _scanMode + "，约 20–40 秒）…");
  try {
    const d = await collectData();
    writeOutputs(d, true);
    console.log("✔ 启动前扫描完成：" + d.totals.repos + " 个仓库 · dashboard.html / scan-data.json 已更新");
  } catch (e) {
    console.error("✖ 启动前扫描失败，改用现有快照：" + (e?.message ?? e));
  }
}

server.listen(Number.isFinite(basePort) ? basePort : 8787, "127.0.0.1", () => {
  const port = server.address().port;
  const url = "http://127.0.0.1:" + port + "/";
  console.log("▸ GitHub 仓库总览服务已启动：" + url);
  console.log("▸ 页面内的「重新扫描」依赖本服务；停止服务按 Ctrl+C 或关闭窗口。");
  openBrowser(url);
});
