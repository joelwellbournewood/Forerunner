# Installs the Windows MSI into several places a user may choose and starts each installation with
# `--self-test` (ADR 0092, amendment of 2026-10-30): the shell finds its runtime through Tauri's
# resource_dir() exactly as a normal launch does, starts the daemon and waits for /health, /me and
# /setup. 1.0.1 died at once when installed into D:\AGENT\Forerunner (Tauri's verbatim
# \\?\D:\... path reached Node); no installer is published again without this passing.
#
# Each place is installed, tested with a fresh data folder, then uninstalled. The self-test
# reports where downloaded dependencies go (U-011); each case checks they go to
# `<install>\dependencies`. The runner's administrator account can write into any folder it
# installs to, so no place here is read-only (see the loop).
#
# Then, with Forerunner running (U-066, U-018): the installed app is started the way a person
# starts it (or, when the runner's session cannot show it, the bundled service is started the way
# the shell starts it), the same MSI is installed over it again with every file replaced, it is
# started again and uninstalled. The installer's stop step (apps/desktop/src-tauri/wix/
# stop-running.wxs) must end it first each time: msiexec exits 0 (not 3010, files in use, nor
# 1603), the step ran without an error, nothing runs from the install folder afterwards, and the
# uninstall leaves none of the files the MSI installed, nor `<install>\dependencies` (which must
# survive the reinstall) nor the person's fr:// registration (U-067, wix/uninstall-cleanup.wxs).
# Exit 1 when any required place fails.
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
  # Started over the network: a share named by the machine's name (\\localhost is no test: Node
  # turns file://localhost/D$/... into file:///D$/..., which no real share produces) and a
  # mapped drive letter, which canonicalises to \\?\UNC\... as well. Reported, not required:
  # a runner's admin shares are not guaranteed.
  @{ Name = 'network share (UNC)'; Dir = 'D:\AGENT\Forerunner'; Via = 'unc'; Required = $false },
  @{ Name = 'mapped network drive'; Dir = 'D:\AGENT\Forerunner'; Via = 'mapped'; Required = $false }
)

function Find-Exe([string]$dir) {
  Get-ChildItem -LiteralPath $dir -Filter *.exe -File |
    Where-Object { $_.Name -notmatch 'uninstall' } |
    Select-Object -First 1
}

# Every process whose executable lies under the folder (compared as text, no wildcards).
function Get-FolderProcesses([string]$dir) {
  $prefix = $dir.TrimEnd('\') + '\'
  @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

function Describe-Processes($procs) {
  ($procs | ForEach-Object { "$($_.Name) ($($_.Id))" }) -join ', '
}

# The daemon.json under $runtime once its /health answers ok, or $null after $seconds (or as
# soon as $app, when given, has ended without bringing a service up).
function Wait-Daemon([string]$runtime, [int]$seconds, $app = $null) {
  $file = Join-Path $runtime 'daemon.json'
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ($app -and $app.HasExited -and -not (Test-Path -LiteralPath $file)) { return $null }
    if (Test-Path -LiteralPath $file) {
      try {
        $d = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        $h = Invoke-RestMethod -Uri "$($d.url)/health" -Headers @{ Authorization = "Bearer $($d.token)" } -TimeoutSec 5
        if ($h.ok) { return $d }
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  return $null
}

# Start Forerunner as a person does (the installed exe, no arguments) and wait for its service.
# A runner session may not be able to show the app; then the bundled service is started the way
# the shell starts it (install::locate_fr: <install>\runtime\node\node.exe running tsx and the
# CLI's `daemon`, the runtime as working folder, TSX_TSCONFIG_PATH set). Returns the daemon.json
# and how it was started.
function Start-Forerunner([string]$dir, [string]$exePath, [string]$runtimeDir) {
  # A daemon ended hard (the self-test's, an upgrade's) leaves its daemon.json; wait for a new one.
  Remove-Item -LiteralPath (Join-Path $runtimeDir 'daemon.json') -Force -ErrorAction SilentlyContinue
  $app = Start-Process -FilePath $exePath -PassThru
  $d = Wait-Daemon $runtimeDir 180 $app
  if ($d) { return @{ Daemon = $d; How = 'the app' } }
  Write-Host "the app did not bring its service up in this session; starting the bundled service as the shell does"
  Get-FolderProcesses $dir | Stop-Process -Force -ErrorAction SilentlyContinue
  $rt = Join-Path $dir 'runtime'
  $env:TSX_TSCONFIG_PATH = Join-Path $rt 'tsconfig.json'
  try {
    $argv = @("`"$(Join-Path $rt 'node_modules\tsx\dist\cli.mjs')`"", "`"$(Join-Path $rt 'packages\runtime\src\cli\main.ts')`"", 'daemon')
    Start-Process -FilePath (Join-Path $rt 'node\node.exe') -ArgumentList $argv -WorkingDirectory $rt -WindowStyle Hidden | Out-Null
  } finally {
    Remove-Item Env:\TSX_TSCONFIG_PATH -ErrorAction SilentlyContinue
  }
  $d = Wait-Daemon $runtimeDir 180
  if ($d) { return @{ Daemon = $d; How = 'the bundled service' } }
  throw "no daemon.json with a healthy /health within 180 s of starting Forerunner"
}

# The installer's stop step ran, and ran without an error (WixQuietExec64 logs a failed command).
function Assert-StopStep([string]$log, [string]$what) {
  if (-not (Select-String -LiteralPath $log -SimpleMatch -Pattern 'Doing action: StopRunningForerunner' -Quiet)) {
    throw "$what`: the log has no StopRunningForerunner step ($log)"
  }
  $failed = Select-String -LiteralPath $log -Pattern 'Command line returned an error|QuietExec64 Failed'
  if ($failed) {
    Get-Content -LiteralPath $log | Select-String -Pattern 'WixQuietExec64' | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
    throw "$what`: the stop step failed: $($failed[0].Line.Trim())"
  }
}

function Assert-Exit([int]$code, [string]$what, [string]$log) {
  if ($code -eq 0) { return }
  Get-Content -LiteralPath $log -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  $why = switch ($code) { 3010 { 'files were in use and need a restart' } 1603 { 'the installation failed' } default { 'see the log' } }
  throw "$what`: msiexec exit $code ($why)"
}

# U-066: reinstall and uninstall with Forerunner running; returns what happened, or throws.
function Test-WithForerunnerRunning([string]$dir, [string]$exePath, [string]$homeDir, [int]$index, [string[]]$installedFiles) {
  $runtimeDir = Join-Path $homeDir 'runtime'
  # The step reads the daemon.json of the person installing: FORERUNNER_HOME from their
  # environment, else %LOCALAPPDATA%. Custom actions get the user's own environment, not this
  # session's, so the case's data folder is set there for the run.
  $previousHome = [Environment]::GetEnvironmentVariable('FORERUNNER_HOME', 'User')
  [Environment]::SetEnvironmentVariable('FORERUNNER_HOME', $homeDir, 'User')
  try {
    $started = Start-Forerunner $dir $exePath $runtimeDir
    $running = @(Get-FolderProcesses $dir)
    Write-Host "running from $dir before the upgrade ($($started.How)): $(Describe-Processes $running)"
    if ($running.Count -eq 0) { throw 'nothing runs from the install folder, so the upgrade proves nothing' }
    # What the app downloads into the install folder (voice, U-067): it survives an upgrade and
    # goes with the uninstall.
    $marker = Join-Path $dir 'dependencies\voice\models\marker.bin'
    New-Item -ItemType File -Force -Path $marker | Out-Null

    # The same MSI again with every file replaced: the same ProductCode makes /i a maintenance
    # install, and REINSTALL=ALL makes it replace each file, as an upgrade does.
    $log = Join-Path $work "upgrade-$index.log"
    $u = Start-Process msiexec.exe -ArgumentList @('/i', "`"$Msi`"", 'REINSTALL=ALL', 'REINSTALLMODE=amus', '/qn', '/norestart', '/l*v', "`"$log`"") -Wait -PassThru
    Assert-Exit $u.ExitCode 'upgrade with Forerunner running' $log
    Assert-StopStep $log 'upgrade'
    $left = @(Get-FolderProcesses $dir)
    if ($left.Count) { throw "still running from the install folder after the upgrade: $(Describe-Processes $left)" }
    if (Get-Process -Id $started.Daemon.pid -ErrorAction SilentlyContinue) { throw "the service (pid $($started.Daemon.pid)) still runs after the upgrade" }
    if (-not (Test-Path -LiteralPath $marker)) { throw 'the upgrade removed the downloaded dependencies' }

    # The upgraded app starts, then it is uninstalled while it runs.
    $again = Start-Forerunner $dir $exePath $runtimeDir
    Write-Host "running before the uninstall ($($again.How)): $(Describe-Processes (Get-FolderProcesses $dir))"
    # The app registers fr:// for the person at every start (HKCU); when this session could not
    # run the app, register it the same way so the uninstall has something to remove.
    $link = 'HKCU:\Software\Classes\fr'
    if (-not (Test-Path -LiteralPath $link)) {
      New-Item -Path $link -Force | Out-Null
      New-ItemProperty -LiteralPath $link -Name 'URL Protocol' -Value '' -Force | Out-Null
    }
    $xlog = Join-Path $work "uninstall-$index.log"
    $x = Start-Process msiexec.exe -ArgumentList @('/x', "`"$Msi`"", '/qn', '/norestart', '/l*v', "`"$xlog`"") -Wait -PassThru
    Assert-Exit $x.ExitCode 'uninstall with Forerunner running' $xlog
    Assert-StopStep $xlog 'uninstall'
    $left = @(Get-FolderProcesses $dir)
    if ($left.Count) { throw "still running from the install folder after the uninstall: $(Describe-Processes $left)" }
    $remaining = @($installedFiles | Where-Object { Test-Path -LiteralPath $_ })
    if ($remaining.Count) { throw "the uninstall left $($remaining.Count) installed file(s), e.g. $($remaining | Select-Object -First 3)" }
    if (Test-Path -LiteralPath (Join-Path $dir 'dependencies')) { throw "the uninstall left $(Join-Path $dir 'dependencies')" }
    if (Test-Path -LiteralPath $link) { throw 'the uninstall left the fr:// registration under HKCU' }
    return "upgrade and uninstall with $($started.How) running: exit 0, nothing left running, no installed file, dependencies or fr:// registration left"
  } finally {
    [Environment]::SetEnvironmentVariable('FORERUNNER_HOME', $previousHome, 'User')
  }
}

$results = @()
$i = 0
foreach ($c in $cases) {
  $i++
  Write-Host "=== $($c.Name) ==="
  $dir = if ($c.Dir) { $c.Dir } else { Join-Path $env:ProgramFiles 'Forerunner' }
  $installed = $false
  $mapped = $false
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
    # What the MSI put there, before anything ran: the uninstall must take every one of them.
    $installedFiles = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force | ForEach-Object { $_.FullName })
    $exe = Find-Exe $dir
    if (-not $exe) { throw "no .exe in $dir" }
    $exePath = $exe.FullName
    if ($c.Via) {
      $unc = '\\' + $env:COMPUTERNAME + '\' + $dir.Substring(0, 1) + '$' + $dir.Substring(2)
      if (-not (Test-Path -LiteralPath $unc)) {
        Write-Host "skipped: $unc is not reachable on this machine"
        $results += [pscustomobject]@{ Case = $c.Name; Ok = $true; Detail = 'skipped (admin share not reachable)'; Required = $false }
        continue
      }
      $exePath = Join-Path $unc $exe.Name
      if ($c.Via -eq 'mapped') {
        $share = '\\' + $env:COMPUTERNAME + '\' + $dir.Substring(0, 1) + '$'
        & net use Z: $share | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "net use Z: $share failed" }
        $mapped = $true
        $exePath = Join-Path ('Z:' + $dir.Substring(2)) $exe.Name
      }
    }
    # No read-only case on Windows: the hosted runner's administrator account still created files
    # in the folder after a deny entry (run 41094877855) and after a read-and-run-only ACL (run
    # 41101161788, whose reset then failed and broke every later uninstall). The read-only
    # fallback is checked on Linux (.deb in /usr/lib) and in dependencies.test.ts; a run as a
    # standard user is U-012 in docs/status/UPDATE-LOG.md.
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
    # Where dependencies go (U-011): the install folder's dependencies subfolder, as the app
    # sees that folder (a share and a mapped drive both resolve to the share's \\host\D$ path).
    $folder = $null
    if ($ok) {
      $checks = ($json | ConvertFrom-Json).checks
      $folder = [string]$checks.voiceFolder
      $seen = if ($c.Via) { '\\' + $env:COMPUTERNAME + '\' + $dir.Substring(0, 1) + '$' + $dir.Substring(2) } else { $dir }
      $want = Join-Path $seen 'dependencies\voice'
      $ok = [string]::Equals($folder, $want, [StringComparison]::OrdinalIgnoreCase)
      if (-not $ok) { Write-Host "dependencies folder: $folder, expected $want" }
    }
    $detail = "exit $($t.ExitCode) from $exePath; dependencies in $folder"
    # The installer's stop step against a running Forerunner, once per local install folder (the
    # network cases run the same installation through another path).
    if ($ok -and -not $c.Via) {
      $detail += '; ' + (Test-WithForerunnerRunning $dir $exe.FullName $home_ $i $installedFiles)
      $installed = $false
    }
    $results += [pscustomobject]@{ Case = $c.Name; Ok = $ok; Detail = $detail; Required = $c.Required }
  } catch {
    Write-Host "error: $($_.Exception.Message)"
    $results += [pscustomobject]@{ Case = $c.Name; Ok = $false; Detail = $_.Exception.Message; Required = $c.Required }
  } finally {
    Remove-Item Env:\FORERUNNER_HOME -ErrorAction SilentlyContinue
    if ($mapped) { & net use Z: /delete /y | Out-Null }
    if ($installed) {
      # Whatever still runs from the folder (a failed case) must not hold the next case's files.
      Get-FolderProcesses $dir | Stop-Process -Force -ErrorAction SilentlyContinue
      $x = Start-Process msiexec.exe -ArgumentList @('/x', "`"$Msi`"", '/qn', '/norestart') -Wait -PassThru
      # 1605: not installed any more (a failed check after its own uninstall).
      if ($x.ExitCode -ne 0 -and $x.ExitCode -ne 1605) {
        $results += [pscustomobject]@{ Case = "$($c.Name): uninstall"; Ok = $false; Detail = "msiexec /x exit $($x.ExitCode)"; Required = $c.Required }
      }
    }
    # The uninstall removes it (U-067; checked above); after a failed case the next one starts
    # clean all the same.
    Remove-Item -LiteralPath (Join-Path $dir 'dependencies') -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$results | Format-Table -AutoSize | Out-String | Write-Host
if ($env:GITHUB_STEP_SUMMARY) {
  "### Installed app check (Windows)" | Out-File -Append $env:GITHUB_STEP_SUMMARY
  $results | ForEach-Object { "- $($_.Case): $(if ($_.Ok) { 'ok' } else { 'FAILED' }) ($($_.Detail))" } | Out-File -Append $env:GITHUB_STEP_SUMMARY
}
if ($results | Where-Object { $_.Required -and -not $_.Ok }) { exit 1 }
