$ErrorActionPreference = "Stop"
$Version = "26.02"
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$compactVersion = $Version.Replace(".", "")
$cacheRoot = Join-Path $workspaceRoot ".codex-cache\7zip-$Version"

$packages = @(
    @{
        Name = "x64"
        Url = "https://www.7-zip.org/a/7z$compactVersion-linux-x64.tar.xz"
        Sha256 = "41aaba7b1235304ab5aa0624530c67ae829496cd29e875925271efdccc28c03e"
        Destination = "linux-x64"
    },
    @{
        Name = "arm64"
        Url = "https://www.7-zip.org/a/7z$compactVersion-linux-arm64.tar.xz"
        Sha256 = "70ea6cc737ae1495ea2d7eb20ef3120fe579bd3f1a83a9d2362b62ec5bde2bba"
        Destination = "linux-arm64"
    }
)

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

foreach ($package in $packages) {
    $archivePath = Join-Path $cacheRoot "$($package.Name).tar.xz"
    $extractPath = Join-Path $cacheRoot $package.Name
    if (-not (Test-Path -LiteralPath $archivePath)) {
        Invoke-WebRequest -Uri $package.Url -OutFile $archivePath
    }
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $package.Sha256) {
        throw "7-Zip $($package.Name) checksum mismatch: $actualHash"
    }
    New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
    tar.exe -xf $archivePath -C $extractPath
    $destinationDir = Join-Path $repoRoot "app\vendor\7zip\$($package.Destination)"
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $extractPath "7zzs") -Destination (Join-Path $destinationDir "7zzs") -Force
}

Copy-Item -LiteralPath (Join-Path $cacheRoot "x64\License.txt") -Destination (Join-Path $repoRoot "app\vendor\7zip\License.txt") -Force
Copy-Item -LiteralPath (Join-Path $cacheRoot "x64\readme.txt") -Destination (Join-Path $repoRoot "app\vendor\7zip\readme.txt") -Force
Write-Host "7-Zip $Version binaries updated."
