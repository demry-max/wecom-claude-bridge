' 隐藏窗口启动桥接服务（登录自启用；日志写到项目根目录 bridge.log）
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c npm start >> """ & root & "\bridge.log"" 2>&1", 0, False
