# 移除登录自启
$lnk = [IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup', 'wecom-claude-bridge.lnk')
Remove-Item $lnk -ErrorAction SilentlyContinue
Write-Host '已移除登录自启（如服务正在运行，请在任务管理器结束对应 node 进程）'
