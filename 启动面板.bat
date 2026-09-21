@echo off
chcp 65001 >nul
title GitHub 仓库总览面板
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18+（https://nodejs.org）
    echo [ERROR] Node.js not found. Please install Node.js 18+ first.
    pause
    exit /b 1
)
echo 正在启动 GitHub 仓库总览面板...
echo 浏览器将自动打开；停止服务请关闭本窗口或按 Ctrl+C。
node server.mjs
echo.
echo 服务已停止。
pause
