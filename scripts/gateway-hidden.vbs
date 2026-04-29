' openclaw-codex gateway hidden launcher - hidden window + auto-restart loop
Dim shell, fso, log, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Dim logDir : logDir = "C:\tmp\openclaw-codex"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
Dim logPath : logPath = logDir & "\restart.log"
cmd = "cmd /c """"C:\www\OpenClaw-Codex\scripts\gateway.cmd"""""
Do
    Set log = fso.OpenTextFile(logPath, 8, True)
    log.WriteLine Now & " starting gateway.cmd"
    log.Close
    shell.Run cmd, 0, True
    Set log = fso.OpenTextFile(logPath, 8, True)
    log.WriteLine Now & " gateway.cmd exited; sleeping 10s before restart"
    log.Close
    WScript.Sleep 10000
Loop