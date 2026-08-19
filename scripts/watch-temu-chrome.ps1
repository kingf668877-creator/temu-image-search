# watch-temu-chrome.ps1
# 守护进程：CDP 不可达或缺少 temu.com 标签页时自动重启 headless Chrome。
$ErrorActionPreference = 'Continue'

$Port = if ($env:TEMU_CDP_PORT) { [int]$env:TEMU_CDP_PORT } else { 9225 }
$CheckIntervalSec = 15

function Test-Cdp {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 4
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Test-TemuTab {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/json" -UseBasicParsing -TimeoutSec 4
    if ($r.StatusCode -ne 200) { return $false }
    $tabs = ($r.Content | ConvertFrom-Json)
    foreach ($t in $tabs) {
      if ($t.type -eq 'page' -and $t.url -match 'temu\.com') { return $true }
    }
    return $false
  } catch { return $false }
}

Write-Host "[watch-temu-chrome] 启动守护（端口 $Port）"
while ($true) {
  if (-not (Test-Cdp)) {
    Write-Host "[watch-temu-chrome] CDP 不可达，重启 headless Chrome"
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-ExecutionPolicy','Bypass','-File',"`"$PSScriptRoot\start-temu-headless.ps1`"") -WindowStyle Hidden
    Start-Sleep -Seconds 8
    continue
  }
  if (-not (Test-TemuTab)) {
    Write-Host "[watch-temu-chrome] 没有 temu.com 标签页，请手动打开有窗口 Chrome 并登录"
  }
  Start-Sleep -Seconds $CheckIntervalSec
}