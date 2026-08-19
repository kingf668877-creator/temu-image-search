# start-temu-headless.ps1
# 启动无窗口 Chrome，复用已登录 user-data-dir；适合常驻。
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
  "--headless=new",
  "--disable-gpu",
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$Profile`"",
  "about:blank"
)

Write-Host "[start-temu-headless] Chrome=$ChromePath Port=$Port Profile=$Profile"
& $ChromePath $args