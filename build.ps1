<#
.SYNOPSIS
  Empaqueta la extension en dist/webmcp-local-agent-<version>.zip

.DESCRIPTION
  Valida el manifest y la sintaxis de los .js (si hay node), copia solo los
  archivos que se distribuyen a una carpeta temporal y genera el zip con
  manifest.json en la raiz, que es lo que espera tanto "Cargar descomprimida"
  como la Chrome Web Store.

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

# Archivos y carpetas que van dentro del zip. Todo lo demas queda fuera.
$include = @(
  'manifest.json',
  'background.js',
  'content.js',
  'page-hook.js',
  'sidepanel.html',
  'sidepanel.css',
  'sidepanel.js',
  'README.md',
  'LICENSE',
  'icons',
  'demo'
)

# --- Validacion ------------------------------------------------------------

$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw "manifest.json no tiene 'version'." }
Write-Host "WebMCP Local Agent v$version" -ForegroundColor Cyan

if (-not $SkipChecks) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    foreach ($file in @('background.js', 'content.js', 'page-hook.js', 'sidepanel.js')) {
      & node --check (Join-Path $root $file)
      if ($LASTEXITCODE -ne 0) { throw "Error de sintaxis en $file" }
    }
    Write-Host "  sintaxis JS ok" -ForegroundColor DarkGray
  } else {
    Write-Warning "node no encontrado: se omite la comprobacion de sintaxis."
  }

  # Todo lo que declara el manifest tiene que existir de verdad.
  $declared = @($manifest.background.service_worker, $manifest.side_panel.default_path)
  $declared += $manifest.content_scripts.js
  $declared += $manifest.icons.PSObject.Properties.Value
  foreach ($rel in ($declared | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path (Join-Path $root $rel))) {
      throw "El manifest declara '$rel' pero el archivo no existe."
    }
  }
  Write-Host "  referencias del manifest ok" -ForegroundColor DarkGray
}

# --- Empaquetado -----------------------------------------------------------

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("webmcp-build-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
  foreach ($item in $include) {
    $source = Join-Path $root $item
    if (-not (Test-Path $source)) { throw "Falta '$item' en el repositorio." }
    Copy-Item -Path $source -Destination $staging -Recurse -Force
  }

  if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
  $zip = Join-Path $dist "webmcp-local-agent-$version.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }

  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

  $size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
  Write-Host "  -> $zip ($size KB)" -ForegroundColor Green
  Write-Host ""
  Write-Host "Para instalarlo: descomprimir y en chrome://extensions usar 'Cargar descomprimida'." -ForegroundColor DarkGray
}
finally {
  Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
