# Installs the burnwatch agent from the latest GitHub release.
#
#   powershell -c "irm https://raw.githubusercontent.com/iamakbarsha1/burn-watch/main/scripts/install.ps1 | iex"
#
# Overrides: $env:BURNWATCH_INSTALL_DIR (default ~\.local\bin),
# $env:BURNWATCH_VERSION (default latest).
$ErrorActionPreference = 'Stop'

$repo = 'iamakbarsha1/burn-watch'
$asset = 'burnwatch-windows-x64.exe'
$installDir = if ($env:BURNWATCH_INSTALL_DIR) { $env:BURNWATCH_INSTALL_DIR } else { "$HOME\.local\bin" }
$version = if ($env:BURNWATCH_VERSION) { $env:BURNWATCH_VERSION } else { 'latest' }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "burnwatch: no prebuilt binary for 32-bit Windows. Build from source: https://github.com/$repo/blob/main/docs/INSTALL.md"
}

$base = if ($version -eq 'latest') {
  "https://github.com/$repo/releases/latest/download"
} else {
  "https://github.com/$repo/releases/download/$version"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "burnwatch: downloading $asset ($version)"
  $exe = Join-Path $tmp 'burnwatch.exe'
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $exe -UseBasicParsing
  $sums = Join-Path $tmp 'checksums.txt'
  Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile $sums -UseBasicParsing

  # Refusing to install beats installing a binary nobody checked.
  $expected = (Get-Content $sums | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" } |
    ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1)
  if (-not $expected) { throw "burnwatch: checksums.txt has no entry for $asset" }
  $actual = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
  if ($expected.ToLower() -ne $actual) {
    throw "burnwatch: checksum mismatch for $asset (expected $expected, got $actual)"
  }

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Move-Item -Force $exe (Join-Path $installDir 'burnwatch.exe')
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host "burnwatch: installed to $installDir\burnwatch.exe"

# A machine already holding a config has been through register before — this
# run is an upgrade, not a first install, so repeating the hint reads as if
# nothing was remembered.
$alreadyRegistered = Test-Path (Join-Path $HOME '.burnwatch\config.json')

# PATH is read when a shell starts, so this takes effect in the next window.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$installDir", 'User')
  if ($alreadyRegistered) {
    Write-Host "burnwatch: added $installDir to your PATH. Reopen PowerShell — upgrade complete, no need to register again."
  } else {
    Write-Host "burnwatch: added $installDir to your PATH. Reopen PowerShell, then run  burnwatch register"
  }
} elseif ($alreadyRegistered) {
  Write-Host 'burnwatch: upgraded in place. No need to register again.'
} else {
  Write-Host 'burnwatch: next, run  burnwatch register'
}
