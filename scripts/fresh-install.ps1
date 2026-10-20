<#
.SYNOPSIS
Forerunner fresh install for Windows 10/11. Idempotent, non-interactive, timed.

.DESCRIPTION
Every step checks before it changes anything, so running the script twice is safe. Each step
prints its elapsed seconds; the summary fails the run when the total is over the budget
(900 s, the "fresh install in under 15 minutes" release criterion).

Usage:
  pwsh -File scripts/fresh-install.ps1 [-NonInteractive] [-DryRun] [-WithDesktop] [-SkipTests]
  (Windows PowerShell 5.1 works too: powershell -ExecutionPolicy Bypass -File scripts\fresh-install.ps1 -NonInteractive)

  -NonInteractive  never prompt; install prerequisites without asking (CI, VMs)
  -DryRun          print every step and the commands it would run, change nothing
  -WithDesktop     print what the desktop build needs (Rust, WebView2, MSVC); Windows needs no extra system libraries
  -SkipTests       skip typecheck and unit tests (not allowed for the release gate)

Environment:
  FORERUNNER_REPO_URL                git URL to clone when the script is not run from a checkout
  FORERUNNER_INSTALL_DIR             where to clone (default: <home>\forerunner)
  FORERUNNER_INSTALL_BUDGET_SECONDS  time budget (default 900)
  FORERUNNER_HOME                    overrides the application directories (see platform-notes.md)

Exit codes: 0 ok, 1 a step failed, 2 configuration (no repository known), 3 over the time budget.
#>
[CmdletBinding()]
param(
  [switch]$NonInteractive,
  [switch]$DryRun,
  [switch]$WithDesktop,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
# Native commands are checked through $LASTEXITCODE by Invoke-Native; stderr output alone must
# never abort the run (PowerShell 7.4+ would otherwise turn a warning on stderr into an error).
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}
if ($NonInteractive) {
  if (-not $env:CI) { $env:CI = "true" }
}
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
$env:COREPACK_ENABLE_STRICT = "0"

$script:ScriptStart = [DateTime]::UtcNow
$script:Budget = 900
if ($env:FORERUNNER_INSTALL_BUDGET_SECONDS) { $script:Budget = [int]$env:FORERUNNER_INSTALL_BUDGET_SECONDS }
$script:StepNo = 0
$script:StepTotal = 8
$script:StepName = ""
$script:StepStart = $script:ScriptStart
$script:StepStatus = "ok"
$script:Summary = @()
$script:RepoDir = $null
$script:PnpmVersion = $null

# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
function Get-Elapsed([DateTime]$Since) {
  return [int][Math]::Round(([DateTime]::UtcNow - $Since).TotalSeconds)
}

function Say([string]$Text) {
  Write-Host "      $Text"
}

# Home directory on Windows PowerShell 5.1, pwsh on Windows and pwsh on Linux/macOS (USERPROFILE
# is empty there; the test suite runs this script under pwsh wherever it exists).
function Get-HomeDir {
  if ($env:USERPROFILE) { return $env:USERPROFILE }
  if ($env:HOME) { return $env:HOME }
  if ($HOME) { return $HOME }
  return (Get-Location).Path
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-PathFromRegistry {
  # Installers add to the machine or user PATH; the current process does not see it until refreshed.
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join [IO.Path]::PathSeparator
}

function Invoke-Native {
  # Invoke-Native <exe> <args...>: runs a native command with argv (no shell string), fails on a
  # non-zero exit code. In dry-run mode only prints the command.
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  if ($null -eq $Arguments) { $Arguments = @() }
  $display = ($File + " " + ($Arguments -join " ")).Trim()
  if ($DryRun) {
    Write-Host "      would run: $display"
    return
  }
  Write-Host "      > $display"
  $global:LASTEXITCODE = 0
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "command failed with exit code $LASTEXITCODE : $display"
  }
}

function Test-NativeOk {
  # Like Invoke-Native but returns $true/$false instead of throwing (for "try A, else B" chains).
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  if ($null -eq $Arguments) { $Arguments = @() }
  if ($DryRun) {
    Write-Host "      would run: $File $($Arguments -join ' ')"
    return $true
  }
  try {
    Invoke-Native $File @Arguments
    return $true
  } catch {
    Say "failed: $($_.Exception.Message)"
    return $false
  }
}

function Confirm-Action([string]$Question) {
  if ($NonInteractive -or $DryRun) { return $true }
  $answer = Read-Host "      $Question [Y/n]"
  if (-not $answer) { return $true }
  return $answer -match '^(y|yes)$'
}

function Start-Step([string]$Name) {
  $script:StepNo++
  $script:StepName = $Name
  $script:StepStart = [DateTime]::UtcNow
  $script:StepStatus = "ok"
  Write-Host ("[{0}/{1}] {2}" -f $script:StepNo, $script:StepTotal, $Name)
}

function Stop-Step {
  $elapsed = Get-Elapsed $script:StepStart
  Write-Host ("      {0} in {1}s (total {2}s)" -f $script:StepStatus, $elapsed, (Get-Elapsed $script:ScriptStart))
  $script:Summary += [pscustomobject]@{ Step = $script:StepName; Seconds = $elapsed; Status = $script:StepStatus }
}

function Write-Summary {
  $total = Get-Elapsed $script:ScriptStart
  $mode = ""
  if ($DryRun) { $mode = ", dry run" }
  Write-Host ""
  $os = if ($IsLinux) { "linux" } elseif ($IsMacOS) { "macos" } else { "windows" }
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  Write-Host ("Forerunner fresh install summary ({0} {1}{2})" -f $os, $arch, $mode)
  Write-Host ("  {0,-48} {1,6}  {2}" -f "step", "secs", "status")
  foreach ($row in $script:Summary) {
    Write-Host ("  {0,-48} {1,5}s  {2}" -f $row.Step, $row.Seconds, $row.Status)
  }
  Write-Host ("  {0,-48} {1,5}s  budget {2}s" -f "total", $total, $script:Budget)
}

function Test-NodeOk {
  if (-not (Test-Command node)) { return $false }
  $version = (& node -p "process.versions.node" 2>$null)
  if (-not $version) { return $false }
  $parts = $version.Trim().Split(".")
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 13)
}

function Install-WithPackageManager {
  # Install-WithPackageManager -WingetIds <id,...> -ChocoPackage <name> -What <text>
  param([string[]]$WingetIds, [string]$ChocoPackage, [string]$What)
  if (Test-Command winget) {
    foreach ($id in $WingetIds) {
      Say "winget install $id"
      if (Test-NativeOk winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity) {
        Update-PathFromRegistry
        return
      }
    }
    throw "winget could not install $What (tried: $($WingetIds -join ', '))"
  }
  if (Test-Command choco) {
    Invoke-Native choco install $ChocoPackage --yes --no-progress
    Update-PathFromRegistry
    return
  }
  throw "$What is missing and neither winget nor choco is available. Install it by hand and run this script again."
}

function Test-Checkout([string]$Dir) {
  if (-not $Dir) { return $false }
  return (Test-Path (Join-Path $Dir "pnpm-workspace.yaml")) -and
         (Test-Path (Join-Path $Dir "AGENTS.md")) -and
         (Test-Path (Join-Path $Dir ".git"))
}

function Read-PnpmVersion([string]$Dir) {
  $pkg = Join-Path $Dir "package.json"
  if (-not (Test-Path $pkg)) { return $null }
  try {
    $json = Get-Content -Raw -Path $pkg | ConvertFrom-Json
    $pm = [string]$json.packageManager
    if ($pm -and $pm.Contains("@")) { return $pm.Split("@")[1] }
  } catch {
    return $null
  }
  return $null
}

function Stop-WithFailure([string]$Message, [int]$Code) {
  $elapsed = Get-Elapsed $script:StepStart
  Write-Host ""
  Write-Host ("fresh-install: FAILED at step {0} ({1}) after {2}s, total {3}s" -f $script:StepNo, $script:StepName, $elapsed, (Get-Elapsed $script:ScriptStart))
  Write-Host "fresh-install: $Message"
  $script:Summary += [pscustomobject]@{ Step = $script:StepName; Seconds = $elapsed; Status = "FAILED" }
  Write-Summary
  exit $Code
}

# ---------------------------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------------------------
try {
  Start-Step "Prerequisites: git, Node.js 22, corepack"
  if (Test-Command git) {
    Say ("git " + ((& git --version) -replace "git version ", ""))
  } else {
    Say "git not found"
    if (-not (Confirm-Action "Install Git with winget/choco?")) { throw "cannot continue without git" }
    Install-WithPackageManager -WingetIds @("Git.Git") -ChocoPackage "git" -What "Git"
  }
  if ($DryRun -or (Test-NativeOk git config --global core.longpaths true)) {
    Say "git core.longpaths enabled (pnpm stores nest deeply)"
  }
  if (Test-NodeOk) {
    Say ("node " + (& node --version) + " ok (>= 22.13)")
  } else {
    $found = "not found"
    if (Test-Command node) { $found = (& node --version) }
    Say "node $found; need 22.13 or newer"
    if (-not (Confirm-Action "Install Node.js 22 with winget/choco?")) { throw "cannot continue without Node.js 22" }
    Install-WithPackageManager -WingetIds @("OpenJS.NodeJS.22", "OpenJS.NodeJS.LTS") -ChocoPackage "nodejs-lts" -What "Node.js 22"
    if (-not $DryRun -and -not (Test-NodeOk)) { throw "Node.js is still older than 22.13 after the install" }
  }
  if (Test-Command corepack) {
    Say ("corepack " + (& corepack --version))
  } elseif (Test-Command npm) {
    Say "corepack is not bundled with this Node.js; installing it with npm"
    Invoke-Native npm install --global corepack
    Update-PathFromRegistry
  }
  Stop-Step

  Start-Step "Repository (this checkout or FORERUNNER_REPO_URL)"
  $scriptDir = Split-Path -Parent $PSCommandPath
  $candidate = Split-Path -Parent $scriptDir
  $installDir = $env:FORERUNNER_INSTALL_DIR
  if (-not $installDir) { $installDir = Join-Path (Get-HomeDir) "forerunner" }
  $top = $null
  if (Test-Command git) {
    try { $top = (& git rev-parse --show-toplevel 2>$null) } catch { $top = $null }
    if ($LASTEXITCODE -ne 0) { $top = $null }
  }
  if (Test-Checkout $candidate) {
    $script:RepoDir = (Resolve-Path $candidate).Path
    Say "using the checkout this script lives in: $($script:RepoDir)"
  } elseif ($top -and (Test-Checkout $top)) {
    $script:RepoDir = (Resolve-Path $top).Path
    Say "using the checkout of the current directory: $($script:RepoDir)"
  } elseif (Test-Checkout $installDir) {
    $script:RepoDir = (Resolve-Path $installDir).Path
    Say "using the existing install directory: $($script:RepoDir) (not updated; run git pull yourself)"
  } elseif ($env:FORERUNNER_REPO_URL) {
    Say "cloning $($env:FORERUNNER_REPO_URL) into $installDir"
    Invoke-Native git clone --depth 1 $env:FORERUNNER_REPO_URL $installDir
    $script:RepoDir = $installDir
  } else {
    Write-Host ""
    Write-Host "fresh-install: no Forerunner repository found."
    Write-Host "Either run this script from inside a checkout (pwsh -File scripts\fresh-install.ps1), or tell it"
    Write-Host "where to clone from:"
    Write-Host '    $env:FORERUNNER_REPO_URL = "https://<git host>/<owner>/forerunner.git"; pwsh -File fresh-install.ps1 -NonInteractive'
    Write-Host 'Optional: $env:FORERUNNER_INSTALL_DIR = "<dir>" (default $env:USERPROFILE\forerunner).'
    exit 2
  }
  if (-not $DryRun) {
    Set-Location $script:RepoDir
    $commit = "unknown"
    try { $commit = (& git rev-parse --short HEAD 2>$null) } catch { $commit = "unknown" }
    Say "commit $commit"
  }
  Stop-Step

  Start-Step "pnpm via corepack (package.json version)"
  if ($script:RepoDir -and (Test-Command node)) { $script:PnpmVersion = Read-PnpmVersion $script:RepoDir }
  if (-not $script:PnpmVersion) {
    $script:PnpmVersion = "10"
    Say "package.json not readable yet; falling back to pnpm major $($script:PnpmVersion)"
  }
  $pnpmNow = $null
  if (Test-Command pnpm) {
    try { $pnpmNow = (& pnpm --version 2>$null) } catch { $pnpmNow = $null }
    if ($pnpmNow) { $pnpmNow = $pnpmNow.Trim() }
  }
  if ($pnpmNow -eq $script:PnpmVersion) {
    Say "pnpm $($script:PnpmVersion) already active"
  } elseif ((Test-Command corepack) -and (Test-NativeOk corepack enable) -and (Test-NativeOk corepack prepare "pnpm@$($script:PnpmVersion)" --activate)) {
    Update-PathFromRegistry
  } else {
    Say "corepack unavailable or not permitted (Program Files needs admin); installing pnpm with npm"
    Invoke-Native npm install --global "pnpm@$($script:PnpmVersion)"
    Update-PathFromRegistry
  }
  if (-not $DryRun) { Say ("pnpm " + (& pnpm --version)) }
  Stop-Step

  Start-Step "pnpm install --frozen-lockfile"
  Invoke-Native pnpm install --frozen-lockfile
  Stop-Step

  if ($SkipTests) {
    Start-Step "pnpm typecheck"
    Say "skipped (-SkipTests)"
    $script:StepStatus = "skipped"
    Stop-Step
    Start-Step "pnpm test:unit"
    Say "skipped (-SkipTests)"
    $script:StepStatus = "skipped"
    Stop-Step
  } else {
    Start-Step "pnpm typecheck"
    Invoke-Native pnpm typecheck
    Stop-Step
    Start-Step "pnpm test:unit"
    Invoke-Native pnpm test:unit
    Stop-Step
  }

  Start-Step "Desktop (Tauri) prerequisites"
  if ($WithDesktop) {
    Say "Windows needs no extra system libraries for the app itself."
    Say "Building the desktop app needs: Rust (winget install Rustlang.Rustup), the MSVC build tools"
    Say "(Microsoft.VisualStudio.2022.BuildTools with the C++ workload) and the WebView2 runtime"
    Say "(preinstalled on Windows 11; Microsoft.EdgeWebView2Runtime on Windows 10). See docs/maintainers/release.md."
    $script:StepStatus = "info"
  } else {
    Say "skipped (pass -WithDesktop to print what the desktop build needs)"
    $script:StepStatus = "skipped"
  }
  Stop-Step

  Start-Step "App directories (fr setup --profile install-check)"
  $hasSetup = $false
  if ($DryRun) {
    $hasSetup = $true
  } else {
    try {
      $help = (& pnpm fr --help 2>$null) -join "`n"
      $hasSetup = $help -match "(?m)^\s+setup\b"
    } catch {
      $hasSetup = $false
    }
  }
  if ($hasSetup) {
    Invoke-Native pnpm fr setup --non-interactive --profile install-check
    Invoke-Native pnpm fr dirs
  } else {
    Say "NOTE: the fr CLI has no setup command yet; printing its help instead"
    Test-NativeOk pnpm fr --help | Out-Null
  }
  Stop-Step
} catch {
  Stop-WithFailure $_.Exception.Message 1
}

Write-Summary
$totalSeconds = Get-Elapsed $script:ScriptStart
if ($totalSeconds -gt $script:Budget) {
  Write-Host "fresh-install: took ${totalSeconds}s, over the $($script:Budget)s budget"
  exit 3
}
if ($DryRun) {
  Write-Host "fresh-install: dry run complete (nothing was changed)"
} else {
  Write-Host "fresh-install: complete in ${totalSeconds}s. Next: pnpm fr setup (credentials) or pnpm --filter @forerunner/desktop tauri dev"
}
exit 0
