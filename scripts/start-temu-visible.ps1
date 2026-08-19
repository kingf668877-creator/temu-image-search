# start-temu-visible.ps1
# 启动有窗口 Chrome，便于一次性登录 temu.com 并保持会话。
$ErrorActionPreference = 'Stop'

$ChromePath = $env:TEMU_CHROME_PATH
if (-not $ChromePath) {
  $ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
}
if (-not (Test-Path $ChromePath)) {
  Write-Error "未找到 Chrome: $ChromePath。请设置 TEMU_CHROME_PATH。"
}

$Port = if ($env:TEMU_CDP_PORT) { [int]$env:TEMU_CDP_PORT } else { 9225 }
$Profile = if ($env:TEMU_PROFILE_DIR) { $env:TEMU_PROFILE_DIR } else { "$env:LOCALAPPDATA\TemuImageSearchChrome" }
if (-not (Test-Path $Profile)) { New-Item -ItemType Directory -Path $Profile -Force | Out-Null }

$args = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$Profile`"",
  "https://www.temu.com"
)

Write-Host "[start-temu-visible] Chrome=$ChromePath Port=$Port Profile=$Profile"
& $ChromePath $args