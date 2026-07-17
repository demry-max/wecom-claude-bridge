# 注册登录自启（当前用户启动文件夹快捷方式，无需管理员）
$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$startup = [IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startup 'wecom-claude-bridge.lnk'))
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + $vbs + '"'
$lnk.WorkingDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$lnk.Save()
Write-Host "已注册登录自启。立即启动：wscript `"$vbs`"（日志见项目根目录 bridge.log）"
