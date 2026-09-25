# Aegis installer for Windows PowerShell. Needs Node.js 22.19+; git is not needed.
#   irm https://raw.githubusercontent.com/vikas53953/Ages/main/install.ps1 | iex
# Install a branch instead of main:
#   $env:AEGIS_REF = "claude/quirky-ramanujan-6bpqc3"; irm https://raw.githubusercontent.com/vikas53953/Ages/main/install.ps1 | iex
$ErrorActionPreference = "Stop"
$repo = "vikas53953/Ages"
$ref = if ($env:AEGIS_REF) { $env:AEGIS_REF } else { "main" }
$minimum = [version]"22.19.0"

function Fail($message) {
  Write-Host "aegis install: $message" -ForegroundColor Red
  exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js $minimum or newer is required. Install it with: winget install OpenJS.NodeJS.LTS  (then open a new terminal)"
}
$version = [version]((node --version).TrimStart("v"))
if ($version -lt $minimum) {
  Fail "Node.js $version is too old; Aegis needs $minimum or newer. Update with: winget upgrade OpenJS.NodeJS.LTS"
}
# A GitHub tarball, not "github:…": npm links git installs to a temporary clone it later deletes.
$url = "https://github.com/$repo/archive/$ref.tar.gz"
Write-Host "Installing Aegis from $url ..." -ForegroundColor Cyan
npm install -g $url
if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." }

$installed = aegis --version
if ($LASTEXITCODE -ne 0) { Fail "installed, but 'aegis' is not on PATH. Open a new terminal and run: aegis --version" }

Write-Host ""
Write-Host "  $installed installed." -ForegroundColor Green
Write-Host ""
Write-Host "  Start it in the folder you want it to work in:"
Write-Host "    cd C:\path\to\project"
Write-Host "    aegis"
Write-Host ""
Write-Host "  Then connect a model once (saved to ~\.aegis\.env):"
Write-Host "    /login opencode <your-key>"
Write-Host ""
