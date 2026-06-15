param(
  [string]$CompanionPath = "$env:ProgramFiles\PrivCloud Companion\privcloud-companion.cmd",
  [string]$ChromeExtensionId = "__CHROME_EXTENSION_ID__",
  [string]$EdgeExtensionId = "__EDGE_EXTENSION_ID__",
  [ValidateSet("CurrentUser", "LocalMachine")]
  [string]$Scope = "CurrentUser"
)

$ErrorActionPreference = "Stop"

$HostName = "fr.privcloud.companion"
$ManifestRoot = Join-Path $env:ProgramData "PrivCloud\NativeMessaging"
New-Item -ItemType Directory -Force -Path $ManifestRoot | Out-Null

function Write-NativeManifest {
  param(
    [string]$Path,
    [string[]]$AllowedOrigins,
    [string[]]$AllowedExtensions
  )

  $manifest = [ordered]@{
    name = $HostName
    description = "PrivCloud Companion native host"
    path = $CompanionPath
    type = "stdio"
  }

  if ($AllowedOrigins) {
    $manifest.allowed_origins = $AllowedOrigins
  }
  if ($AllowedExtensions) {
    $manifest.allowed_extensions = $AllowedExtensions
  }

  $manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -Path $Path
}

function Register-RegistryHost {
  param(
    [string]$BrowserKey,
    [string]$ManifestPath
  )

  $root = if ($Scope -eq "LocalMachine") { "HKLM:\Software" } else { "HKCU:\Software" }
  $key = Join-Path $root "$BrowserKey\NativeMessagingHosts\$HostName"
  New-Item -Force -Path $key | Out-Null
  Set-Item -Path $key -Value $ManifestPath
}

if (-not (Test-Path -Path $CompanionPath)) {
  throw "Companion executable not found: $CompanionPath"
}

$chromeManifest = Join-Path $ManifestRoot "$HostName.chrome.json"
$edgeManifest = Join-Path $ManifestRoot "$HostName.edge.json"
$firefoxManifest = Join-Path $ManifestRoot "$HostName.firefox.json"

Write-NativeManifest `
  -Path $chromeManifest `
  -AllowedOrigins @("chrome-extension://$ChromeExtensionId/") `
  -AllowedExtensions @()

Write-NativeManifest `
  -Path $edgeManifest `
  -AllowedOrigins @("chrome-extension://$EdgeExtensionId/") `
  -AllowedExtensions @()

Write-NativeManifest `
  -Path $firefoxManifest `
  -AllowedOrigins @() `
  -AllowedExtensions @("companion@privcloud.fr")

Register-RegistryHost -BrowserKey "Google\Chrome" -ManifestPath $chromeManifest
Register-RegistryHost -BrowserKey "Microsoft\Edge" -ManifestPath $edgeManifest
Register-RegistryHost -BrowserKey "Mozilla" -ManifestPath $firefoxManifest

Write-Host "PrivCloud Companion native messaging host registered for $Scope."
