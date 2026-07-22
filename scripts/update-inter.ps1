$ErrorActionPreference = "Stop"

$Version = "4.1"
$ArchiveSha256 = "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e"
$FontSha256 = "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3"
$LicenseSha256 = "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a"
$ArchiveName = "Inter-4.1.zip"
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$defaultCacheRoot = [IO.Path]::GetFullPath(
    (Join-Path $workspaceRoot ".codex-cache")
)
$cacheRoot = if ($env:FNSMARTZIP_CACHE_ROOT) {
    [IO.Path]::GetFullPath($env:FNSMARTZIP_CACHE_ROOT)
} else {
    $defaultCacheRoot
}
$cachePrefix = $defaultCacheRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
if (
    $cacheRoot -ne $defaultCacheRoot -and
    -not $cacheRoot.StartsWith($cachePrefix, [StringComparison]::OrdinalIgnoreCase)
) {
    throw "Refusing cache path outside workspace: $cacheRoot"
}
$downloadDir = Join-Path $cacheRoot "downloads"
$extractDir = Join-Path $cacheRoot "font-audit\inter-$Version"
$archivePath = Join-Path $downloadDir $ArchiveName
$partialArchivePath = "$archivePath.part"
$fontSource = Join-Path $extractDir "web\InterVariable.woff2"
$licenseSource = Join-Path $extractDir "LICENSE.txt"
$fontDestinationDir = Join-Path $repoRoot "app\www\fonts"
$fontDestination = Join-Path $fontDestinationDir "InterVariable.woff2"
$licenseDestination = Join-Path $fontDestinationDir "LICENSE-Inter.txt"
$downloadUrl = "https://github.com/rsms/inter/releases/download/v$Version/Inter-$Version.zip"

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Expected
    )

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        throw "Inter checksum mismatch for $Path`: $actual"
    }
}

New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

if (Test-Path -LiteralPath $archivePath) {
    try {
        Assert-Sha256 -Path $archivePath -Expected $ArchiveSha256
    } catch {
        Remove-Item -LiteralPath $archivePath -Force
        Write-Warning "Cached Inter archive failed checksum; downloading again."
    }
}

if (-not (Test-Path -LiteralPath $archivePath)) {
    Remove-Item -LiteralPath $partialArchivePath -Force -ErrorAction SilentlyContinue
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $partialArchivePath
        Assert-Sha256 -Path $partialArchivePath -Expected $ArchiveSha256
        Move-Item -LiteralPath $partialArchivePath -Destination $archivePath -Force
    } finally {
        Remove-Item -LiteralPath $partialArchivePath -Force -ErrorAction SilentlyContinue
    }
}
Assert-Sha256 -Path $archivePath -Expected $ArchiveSha256

Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
Assert-Sha256 -Path $fontSource -Expected $FontSha256
Assert-Sha256 -Path $licenseSource -Expected $LicenseSha256

New-Item -ItemType Directory -Path $fontDestinationDir -Force | Out-Null
Copy-Item -LiteralPath $fontSource -Destination $fontDestination -Force
Copy-Item -LiteralPath $licenseSource -Destination $licenseDestination -Force
Assert-Sha256 -Path $fontDestination -Expected $FontSha256
Assert-Sha256 -Path $licenseDestination -Expected $LicenseSha256

Write-Host "Inter $Version web font updated from $archivePath."
