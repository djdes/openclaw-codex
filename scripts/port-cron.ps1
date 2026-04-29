# port-cron.ps1
# Reads C:\Users\djdes\.clawdbot\cron\jobs.json and creates a Windows
# Scheduled Task per enabled job. Each task invokes codex via a wrapper
# .cmd file that tells the agent to read a prompt file (full multi-line
# original payload.text). Re-runnable: existing tasks are recreated (/F).
#
# Cron translation (the 5 fields are MIN HOUR DAY MONTH DOW):
#   * * * * *           -> /SC DAILY /ST <when next>
#   M H * * *           -> /SC DAILY /ST H:M
#   M H D * *           -> /SC MONTHLY /D D /ST H:M
#   M H D Mo *          -> /SC MONTHLY /M <Mon> /D D /ST H:M  (yearly)
#   M H * * Dow         -> /SC WEEKLY /D <DOW> /ST H:M
#   */N H1-H2 * * *     -> /SC MINUTE /MO N /ST H1:M /DU (H2-H1+1):00
# Anything else: skipped, listed in summary.

param(
    [string]$JobsPath    = "C:\Users\djdes\.clawdbot\cron\jobs.json",
    [string]$WorkspaceDir = "C:\Users\djdes\clawd",
    [string]$CodexBinary  = "C:\Users\djdes\AppData\Roaming\npm\codex.cmd",
    [string]$PromptDir    = "C:\Users\djdes\.openclaw-codex\cron-prompts",
    [string]$TaskPrefix   = "OpenClaw-Codex Cron - "
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $JobsPath)) { Write-Error "jobs.json not found: $JobsPath"; exit 1 }
New-Item -ItemType Directory -Force -Path $PromptDir | Out-Null

$data = Get-Content $JobsPath -Raw | ConvertFrom-Json
$skipped = @()
$created = @()

foreach ($job in $data.jobs) {
    if (-not $job.enabled) { continue }
    if ($job.payload.kind -ne 'systemEvent') {
        $skipped += "$($job.name) (payload kind: $($job.payload.kind))"
        continue
    }

    # Save prompt to file (UTF-8 no BOM)
    $promptFile = Join-Path $PromptDir "$($job.name).txt"
    [System.IO.File]::WriteAllText($promptFile, $job.payload.text, [System.Text.UTF8Encoding]::new($false))

    # Wrapper .cmd that tells codex to read the prompt file and execute
    $wrapper = Join-Path $PromptDir "$($job.name).cmd"
    $wrapperBody = @"
@echo off
"$CodexBinary" exec --cd "$WorkspaceDir" --full-auto "Read instructions from $promptFile and execute them. The job name is $($job.name)."
"@
    [System.IO.File]::WriteAllText($wrapper, $wrapperBody, [System.Text.ASCIIEncoding]::new())

    # Parse cron
    $parts = $job.schedule.expr -split '\s+'
    if ($parts.Count -ne 5) { $skipped += "$($job.name) (cron parse: $($job.schedule.expr))"; continue }
    $min, $hr, $dom, $mon, $dow = $parts

    $taskName = "$TaskPrefix$($job.name)"
    $tr = "`"$wrapper`""

    # Try in priority order: yearly -> monthly -> weekly -> daily -> minute-window
    $schtasksArgs = $null

    if ($mon -ne '*' -and $dom -ne '*' -and $dow -eq '*' -and $min -notmatch '/' -and $hr -notmatch '-') {
        $monthAbbr = @('JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC')[[int]$mon - 1]
        $schtasksArgs = @('/SC','MONTHLY','/M',$monthAbbr,'/D',$dom,'/ST',('{0:D2}:{1:D2}' -f [int]$hr,[int]$min))
    }
    elseif ($mon -eq '*' -and $dom -ne '*' -and $dow -eq '*' -and $min -notmatch '/' -and $hr -notmatch '-') {
        $schtasksArgs = @('/SC','MONTHLY','/D',$dom,'/ST',('{0:D2}:{1:D2}' -f [int]$hr,[int]$min))
    }
    elseif ($dow -ne '*' -and $dom -eq '*' -and $min -notmatch '/' -and $hr -notmatch '-') {
        $dowMap = @{ '0'='SUN'; '1'='MON'; '2'='TUE'; '3'='WED'; '4'='THU'; '5'='FRI'; '6'='SAT' }
        $schtasksArgs = @('/SC','WEEKLY','/D',$dowMap[$dow],'/ST',('{0:D2}:{1:D2}' -f [int]$hr,[int]$min))
    }
    elseif ($min -match '^\*/(\d+)$' -and $hr -match '^(\d+)-(\d+)$' -and $dom -eq '*' -and $mon -eq '*' -and $dow -eq '*') {
        $stepMin = [int]$Matches[1]
        $hrStart = [int]$Matches[1]
        # re-match for hr range
        $null = $hr -match '^(\d+)-(\d+)$'
        $h1 = [int]$Matches[1]; $h2 = [int]$Matches[2]
        $duHours = $h2 - $h1 + 1
        $schtasksArgs = @('/SC','MINUTE','/MO',$stepMin,'/ST',('{0:D2}:00' -f $h1),'/DU',('{0:D2}:00' -f $duHours),'/K')
    }
    elseif ($dom -eq '*' -and $mon -eq '*' -and $dow -eq '*' -and $min -notmatch '/' -and $hr -notmatch '-') {
        $schtasksArgs = @('/SC','DAILY','/ST',('{0:D2}:{1:D2}' -f [int]$hr,[int]$min))
    }
    else {
        $skipped += "$($job.name) (unsupported cron: $($job.schedule.expr))"
        continue
    }

    schtasks /Create /TN "$taskName" /TR $tr @schtasksArgs /F | Out-Null
    $created += $taskName
}

Write-Host ""
Write-Host "Created $($created.Count) tasks:" -ForegroundColor Green
$created | ForEach-Object { Write-Host "  $_" }
if ($skipped.Count -gt 0) {
    Write-Host ""
    Write-Host "Skipped $($skipped.Count) (review manually):" -ForegroundColor Yellow
    $skipped | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}
