# Creates Windows Desktop and Start Menu shortcuts for CloudDrop (silent pythonw.exe, zero console window)
$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ScriptPath = Join-Path $RootDir "desktop\clouddrop.py"
$IconPath = Join-Path $RootDir "web\assets\icon.ico"

$PythonW = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $PythonW) {
    $Py = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($Py) {
        $Candidate = Join-Path (Split-Path $Py -Parent) "pythonw.exe"
        if (Test-Path $Candidate) { $PythonW = $Candidate } else { $PythonW = $Py }
    }
}
if (-not $PythonW) {
    Write-Error "Python 3 (pythonw.exe) not found in PATH."
    exit 1
}

$WshShell = New-Object -ComObject WScript.Shell

function New-CloudDropShortcut {
    param(
        [string]$LinkPath,
        [string]$Arguments,
        [string]$Description
    )
    $Dir = Split-Path $LinkPath -Parent
    if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
    $Sc = $WshShell.CreateShortcut($LinkPath)
    $Sc.TargetPath = $PythonW
    $Sc.Arguments = $Arguments
    $Sc.WorkingDirectory = $RootDir
    if (Test-Path $IconPath) { $Sc.IconLocation = "$IconPath,0" }
    $Sc.Description = $Description
    $Sc.WindowStyle = 7
    $Sc.Save()
    Write-Output "Created shortcut: $LinkPath"
}

$DesktopDir = [Environment]::GetFolderPath("Desktop")
$StartMenuDir = Join-Path ([Environment]::GetFolderPath("Programs")) "CloudDrop"

New-CloudDropShortcut `
    -LinkPath (Join-Path $DesktopDir "CloudDrop.lnk") `
    -Arguments "`"$ScriptPath`"" `
    -Description "CloudDrop - Cross-device cloud dropbox"

New-CloudDropShortcut `
    -LinkPath (Join-Path $StartMenuDir "CloudDrop.lnk") `
    -Arguments "`"$ScriptPath`"" `
    -Description "CloudDrop - Workspace Mode"

New-CloudDropShortcut `
    -LinkPath (Join-Path $StartMenuDir "CloudDrop Panel.lnk") `
    -Arguments "`"$ScriptPath`" --panel" `
    -Description "CloudDrop - Edge Drop Side Panel Mode"

Write-Output "All CloudDrop Windows shortcuts installed cleanly (target: $PythonW)."
