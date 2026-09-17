@echo off
rem ── DeepSeek Desktop 便携版启动器 ────────────────────────────────────────────
rem 双击这个文件即可使用，不需要安装。所有数据（配置/日志/运行组件/登录状态）都保存在
rem 本文件夹下的 data 目录里，删除整个文件夹即可完全卸载。
setlocal
set "DEEPSEEK_DESKTOP_PORTABLE=1"

if not exist "%~dp0portable.flag" echo portable> "%~dp0portable.flag"

if not exist "%~dp0DeepSeek Desktop.exe" (
  echo.
  echo [错误] 没有找到 "DeepSeek Desktop.exe"。
  echo 请确认已经完整解压压缩包，并且本文件与程序在同一个文件夹里。
  echo.
  pause
  exit /b 1
)

start "" "%~dp0DeepSeek Desktop.exe" %*
exit /b 0
