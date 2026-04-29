' openclaw-codex watchdog - kicks Scheduled Task if it stops
Dim shell, fso
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Dim logPath : logPath = "C:\tmp\openclaw-codex\watchdog.log"
Sub WriteLog(msg)
    Dim f
    Set f = fso.OpenTextFile(logPath, 8, True)
    f.WriteLine Now & " " & msg
    f.Close
End Sub
Do
    Dim exec, output, isRunning
    Set exec = shell.Exec("schtasks /Query /TN ""OpenClaw-Codex Bridge"" /FO LIST /V")
    output = exec.StdOut.ReadAll
    isRunning = (InStr(output, "Status:") > 0) And (InStr(output, "Running") > 0)
    If Not isRunning Then
        WriteLog "task not running - kicking via schtasks /Run"
        shell.Run "schtasks /Run /TN ""OpenClaw-Codex Bridge""", 0, True
        WScript.Sleep 15000
        Set exec = shell.Exec("schtasks /Query /TN ""OpenClaw-Codex Bridge"" /FO LIST /V")
        output = exec.StdOut.ReadAll
        If InStr(output, "Running") > 0 Then
            WriteLog "kick succeeded"
        Else
            WriteLog "kick failed - task still not running"
        End If
    End If
    WScript.Sleep 300000
Loop