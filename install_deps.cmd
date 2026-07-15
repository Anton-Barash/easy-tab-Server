@echo off
set "NODE_DIR=c:\Users\Valeryk\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\vm\tools\node"
set "PATH=%NODE_DIR%;%PATH%"
set "NPM_CONFIG_REGISTRY=https://registry.npmmirror.com/"
cd /d "d:\neiroQC\easyTab2\easy_tab_Server"
echo Using node:
"%NODE_DIR%\node.exe" -v
echo Installing dependencies...
"%NODE_DIR%\node.exe" "%NODE_DIR%\node_modules\npm\bin\npm-cli.js" install --no-audit --no-fund
echo EXIT_CODE=%ERRORLEVEL%
