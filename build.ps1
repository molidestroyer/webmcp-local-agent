<#
.SYNOPSIS
  Packages the extension into dist/webmcp-local-agent-<version>.zip

.DESCRIPTION
  Validates the manifest and the syntax of the .js files (when node is
  available), copies only the shipping files into a staging folder and produces
  a zip with manifest.json at its root, which is what both "Load unpacked" and
  the Chrome Web Store expect.

.EXAMPLE
  pwsh ./build.ps1
  pwsh ./build.ps1 -SkipChecks
#>
[CmdletBinding()]
param(
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'

# Files and folders that go inside the zip. Everything else stays out.
$include = @(
  'manifest.json',
  'background.js',
  'content.js',
  'page-hook.js',
  'sidepanel.html',
  'sidepanel.css',
  'sidepanel.js',
  'lib',
  'README.md',
  'LICENSE',
  'icons',
  'demo'
)

# --- Validation ------------------------------------------------------------

$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw "manifest.json has no 'version'." }
Write-Host "WebMCP Local Agent v$version" -ForegroundColor Cyan

if (-not $SkipChecks) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    foreach ($file in @('background.js', 'content.js', 'page-hook.js', 'sidepanel.js', 'lib/webmcp-schema.js', 'lib/catalog-service.js', 'lib/copilot-service.js')) {
      & node --check (Join-Path $root $file)
      if ($LASTEXITCODE -ne 0) { throw "Syntax error in $file" }
    }
    Write-Host "  js syntax ok" -ForegroundColor DarkGray

    Push-Location $root
    try {
      & node --test
      if ($LASTEXITCODE -ne 0) { throw "Unit tests failed" }
    } finally { Pop-Location }
    Write-Host "  unit tests ok" -ForegroundColor DarkGray
  } else {
    Write-Warning "node not found: skipping the syntax check."
  }

  # Everything the manifest declares must actually exist.
  $declared = @($manifest.background.service_worker, $manifest.side_panel.default_path)
  $declared += $manifest.content_scripts.js
  $declared += $manifest.icons.PSObject.Properties.Value
  foreach ($rel in ($declared | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path (Join-Path $root $rel))) {
      throw "The manifest declares '$rel' but the file does not exist."
    }
  }
  Write-Host "  manifest references ok" -ForegroundColor DarkGray
}

# --- Packaging -------------------------------------------------------------

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("webmcp-build-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
  foreach ($item in $include) {
    $source = Join-Path $root $item
    if (-not (Test-Path $source)) { throw "'$item' is missing from the repository." }
    Copy-Item -Path $source -Destination $staging -Recurse -Force
  }

  if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
  $zip = Join-Path $dist "webmcp-local-agent-$version.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }

  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

  $size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
  Write-Host "  -> $zip ($size KB)" -ForegroundColor Green
  Write-Host ""
  Write-Host "To install: unzip it and use 'Load unpacked' on chrome://extensions." -ForegroundColor DarkGray
}
finally {
  Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
