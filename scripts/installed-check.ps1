# Installs the Windows MSI into several places a user may choose and starts each installation with
# `--self-test` (ADR 0092, amendment of 2026-10-30): the shell finds its runtime through Tauri's
# resource_dir() exactly as a normal launch does, starts the daemon and waits for /health, /me and
# /setup. 1.0.1 died at once when installed into D:\AGENT\Forerunner (Tauri's verbatim
# \\?\D:\... path reached Node); no installer is published again without this passing.
#
# Each place is installed, made read-only for this user (an install folder is not writable by the
# app; everything it writes goes to the data folder), tested with a data folder on another drive,
# then uninstalled. Exit 1 when any required place fails.
#
# Usage: pwsh -File scripts/installed-check.ps1 -Msi <path to the .msi>
param([Parameter(Mandatory = $true)][string]$Msi)
$ErrorActionPreference = 'Stop'
$Msi = (Resolve-Path $Msi).Path
$work = Join-Path $env:RUNNER_TEMP 'fr-installed-check'
if (-not $env:RUNNER_TEMP) { $work = Join-Path ([IO.Path]::GetTempPath()) 'fr-installed-check' }
New-Item -ItemType Directory -Force -Path $work | Out-Null

# About 100 characters: with the runtime's deepest file (about 125 more) it stays under the
# 260-character limit Windows Installer itself works within.
$long = 'D:\' + (('a-rather-long-folder-name-for-forerunner') * 2) + '\Forerunner'
$cases = @(
  @{ Name = 'default (Program Files)'; Dir = $null; Required = $true },
  @{ Name = 'another drive'; Dir = 'D:\AGENT\Forerunner'; Required = $true },
  @{ Name = 'spaces and non-ASCII'; Dir = 'D:\My Apps\Forer' + [char]0x00FC + 'nner ' + [char]0x00C4; Required = $true },
  @{ Name = 'long path'; Dir = $long; Required = $true },
  @{ Name = 'network share (UNC)'; Dir = 'D:\AGENT\Forerunner'; Unc = $true; Required = $false }
)

function Find-Exe([string]$dir) {
  Get-ChildItem -LiteralPath $dir -Filter *.exe -File |
    Where-Object { $_.Name -notmatch 'uninstall' } |
    Select-Object -First 1
}

$results = @()
$i = 0
foreach ($c in $cases) {
  $i++
  Write-Host "=== $($c.Name) ==="
  $dir = if ($c.Dir) { $c.Dir } else { Join-Path $env:ProgramFiles 'Forerunner' }
  $installed = $false
  $denied = $false
  try {
    $log = Join-Path $work "install-$i.log"
    $msiArgs = @('/i', "`"$Msi`"", '/qn', '/norestart', '/l*v', "`"$log`"")
    if ($c.Dir) { $msiArgs += "INSTALLDIR=`"$($c.Dir)`"" }
    $p = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
    if ($p.ExitCode -ne 0) {
      Get-Content $log -Tail 40
      throw "install failed (msiexec exit $($p.ExitCode))"
    }
    $installed = $true
    $exe = Find-Exe $dir
    if (-not $exe) { throw "no .exe in $dir" }
    $exePath = $exe.FullName
    if ($c.Unc) {
      $unc = '\\localhost\' + $dir.Substring(0, 1) + '$' + $dir.Substring(2)
      if (-not (Test-Path -LiteralPath $unc)) {
        Write-Host "skipped: $unc is not reachable on this machine"
        $results += [pscustomobject]@{ Case = $c.Name; Ok = $true; Detail = 'skipped (admin share not reachable)'; Required = $false }
        continue
      }
      $exePath = Join-Path $unc $exe.Name
    }
    # Read-only for this user, like a folder the app cannot write to. Only the specific write
    # rights: icacls' W and D are generic rights that also carry SYNCHRONIZE and READ_CONTROL,
    # and denying those stops Windows from starting any program in the folder.
    & icacls $dir /deny "$($env:USERNAME):(OI)(CI)(WD,AD,WEA,WA,DE,DC)" | Out-Null
    $denied = $true
    $home_ = Join-Path $work "home-$i"
    New-Item -ItemType Directory -Force -Path $home_ | Out-Null
    $report = Join-Path $work "report-$i.json"
    $env:FORERUNNER_HOME = $home_
    Write-Host "running: $exePath --self-test (data in $home_)"
    $t = Start-Process -FilePath $exePath -ArgumentList @('--self-test', '--report', "`"$report`"") -PassThru
    $null = $t.Handle # without it ExitCode stays empty after the wait
    if (-not $t.WaitForExit(240000)) {
      $t.Kill($true)
      throw "self-test still running after 240 s"
    }
    $json = if (Test-Path $report) { Get-Content $report -Raw } else { '{}' }
    Write-Host $json
    $ok = ($t.ExitCode -eq 0) -and ($json -match '"ok":\s*true')
    $results += [pscustomobject]@{ Case = $c.Name; Ok = $ok; Detail = "exit $($t.ExitCode) from $exePath"; Required = $c.Required }
  } catch {
    Write-Host "error: $($_.Exception.Message)"
    $results += [pscustomobject]@{ Case = $c.Name; Ok = $false; Detail = $_.Exception.Message; Required = $c.Required }
  } finally {
    Remove-Item Env:\FORERUNNER_HOME -ErrorAction SilentlyContinue
    if ($denied) { & icacls $dir /remove:d "$($env:USERNAME)" | Out-Null }
    if ($installed) { Start-Process msiexec.exe -ArgumentList @('/x', "`"$Msi`"", '/qn', '/norestart') -Wait | Out-Null }
  }
}

$results | Format-Table -AutoSize | Out-String | Write-Host
if ($env:GITHUB_STEP_SUMMARY) {
  "### Installed app check (Windows)" | Out-File -Append $env:GITHUB_STEP_SUMMARY
  $results | ForEach-Object { "- $($_.Case): $(if ($_.Ok) { 'ok' } else { 'FAILED' }) ($($_.Detail))" } | Out-File -Append $env:GITHUB_STEP_SUMMARY
}
if ($results | Where-Object { $_.Required -and -not $_.Ok }) { exit 1 }
