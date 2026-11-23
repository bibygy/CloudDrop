# Generates a persistent Android APK signing keystore using local JDK keytool (no Android Studio needed).
# Output is stored OUTSIDE the git repo at %USERPROFILE%\.clouddrop\signing\clouddrop.jks
# and its Base64 is copied to your clipboard for pasting into GitHub Secret: ANDROID_KEYSTORE_BASE64
$ErrorActionPreference = "Stop"

function Find-Keytool {
    # Prefer JDK 17/21 for 100% compatibility with GitHub Actions Temurin Java 17
    $SearchDirs = @(
        "C:\Program Files\Java",
        "C:\Program Files\Eclipse Adoptium",
        "C:\Program Files\Microsoft",
        "C:\Program Files\Zulu"
    )
    if ($env:JAVA_HOME) {
        $jh = Join-Path $env:JAVA_HOME "bin\keytool.exe"
        if (Test-Path $jh) { return $jh }
    }
    $Found = @()
    foreach ($dir in $SearchDirs) {
        if (Test-Path $dir) {
            $Found += Get-ChildItem $dir -Recurse -Filter "keytool.exe" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
        }
    }
    $Jdk17 = $Found | Where-Object { $_ -match "jdk-?17" } | Select-Object -First 1
    if ($Jdk17) { return $Jdk17 }
    $Jdk21 = $Found | Where-Object { $_ -match "jdk-?21" } | Select-Object -First 1
    if ($Jdk21) { return $Jdk21 }
    if ($Found.Count -gt 0) { return $Found[0] }

    $FromPath = (Get-Command keytool -ErrorAction SilentlyContinue).Source
    if ($FromPath) { return $FromPath }
    return $null
}

$Keytool = Find-Keytool
if (-not $Keytool) {
    Write-Error "JDK keytool.exe not found in PATH or C:\Program Files\Java. Please install Java JDK 17+."
    exit 1
}
Write-Output "Using keytool: $Keytool"

$OutDir = Join-Path $env:USERPROFILE ".clouddrop\signing"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$JksPath = Join-Path $OutDir "clouddrop.jks"
$B64Path = Join-Path $OutDir "ANDROID_KEYSTORE_BASE64.txt"

if (-not (Test-Path $JksPath)) {
    & $Keytool -genkeypair -v `
        -keystore $JksPath `
        -storetype PKCS12 `
        -alias clouddrop `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass clouddrop -keypass clouddrop `
        -dname "CN=CloudDrop, OU=Personal, O=CloudDrop, L=Local, S=Local, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed with exit code $LASTEXITCODE" }
    Write-Output "Generated persistent keystore: $JksPath"
} else {
    Write-Output "Reusing existing keystore: $JksPath"
}

$Bytes = [System.IO.File]::ReadAllBytes($JksPath)
$B64 = [System.Convert]::ToBase64String($Bytes)
[System.IO.File]::WriteAllText($B64Path, $B64)
Set-Clipboard -Value $B64

Write-Output ""
Write-Output "================================================================"
Write-Output "Base64 copied to clipboard AND saved to:"
Write-Output "  $B64Path"
Write-Output ""
Write-Output "Next step (30 seconds, once only):"
Write-Output "  GitHub Repo -> Settings -> Secrets and variables -> Actions"
Write-Output "  -> New repository secret"
Write-Output "  Name  : ANDROID_KEYSTORE_BASE64"
Write-Output "  Secret: (Ctrl+V paste)"
Write-Output "================================================================"
