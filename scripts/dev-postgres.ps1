<#
.SYNOPSIS
Starts a local PostgreSQL for the integration tests and prints the FORERUNNER_TEST_PG URL.

.DESCRIPTION
Order of preference:
  1. a server already answering on localhost:5432 with the test credentials (nothing to do)
  2. Docker Desktop: container "forerunner-pg" from the postgres:16 image (created, or restarted when it exists)
  3. a locally installed server: the postgresql* Windows service, or pg_ctl with $env:PGBIN and $env:PGDATA

Usage: pwsh -File scripts/dev-postgres.ps1 [-Stop] [-Status]
  -Stop    stop the Docker container (or the local service started here); keeps the data
  -Status  only report what is running and print the URL

Environment: FORERUNNER_PG_PORT (default 5432), FORERUNNER_PG_PASSWORD (default forerunner),
             FORERUNNER_PG_DB (default forerunner_test), FORERUNNER_PG_IMAGE (default postgres:16),
             PGPASSWORD (the current superuser password of a preinstalled server, when it is not the test one)
#>
[CmdletBinding()]
param(
  [switch]$Stop,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Port = if ($env:FORERUNNER_PG_PORT) { $env:FORERUNNER_PG_PORT } else { "5432" }
$Password = if ($env:FORERUNNER_PG_PASSWORD) { $env:FORERUNNER_PG_PASSWORD } else { "forerunner" }
$Db = if ($env:FORERUNNER_PG_DB) { $env:FORERUNNER_PG_DB } else { "forerunner_test" }
$Image = if ($env:FORERUNNER_PG_IMAGE) { $env:FORERUNNER_PG_IMAGE } else { "postgres:16" }
$Container = "forerunner-pg"
$Url = "postgres://postgres:${Password}@localhost:${Port}/${Db}"

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-Psql {
  if (Test-Command psql) { return "psql" }
  if ($env:PGBIN -and (Test-Path (Join-Path $env:PGBIN "psql.exe"))) { return (Join-Path $env:PGBIN "psql.exe") }
  $candidates = @()
  if ($env:ProgramFiles) {
    $candidates = Get-ChildItem -Path (Join-Path $env:ProgramFiles "PostgreSQL") -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending
  }
  foreach ($dir in $candidates) {
    $exe = Join-Path (Join-Path $dir.FullName "bin") "psql.exe"
    if (Test-Path $exe) { return $exe }
  }
  return $null
}

function Test-DockerOk {
  if (-not (Test-Command docker)) { return $false }
  & docker info *> $null
  return ($LASTEXITCODE -eq 0)
}

function Test-ServerListening {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", [int]$Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(2000)
    if ($ok -and $client.Connected) { $client.Close(); return $true }
    $client.Close()
    return $false
  } catch {
    return $false
  }
}

function Test-DbReady {
  $psql = Get-Psql
  if ($psql) {
    $old = $env:PGPASSWORD
    $env:PGPASSWORD = $Password
    try {
      & $psql $Url -tAc "select 1" *> $null
      return ($LASTEXITCODE -eq 0)
    } finally {
      $env:PGPASSWORD = $old
    }
  }
  if ((Test-DockerOk) -and ((& docker ps --format "{{.Names}}") -contains $Container)) {
    & docker exec -e "PGPASSWORD=$Password" $Container psql -U postgres -d $Db -tAc "select 1" *> $null
    return ($LASTEXITCODE -eq 0)
  }
  return $false
}

function Invoke-Psql([string]$Psql, [string]$AdminPassword, [string[]]$Arguments) {
  $old = $env:PGPASSWORD
  $env:PGPASSWORD = $AdminPassword
  try {
    $out = & $Psql -h localhost -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 @Arguments 2>&1
    return @{ Code = $LASTEXITCODE; Output = ($out | Out-String) }
  } finally {
    $env:PGPASSWORD = $old
  }
}

function Initialize-LocalDb {
  $psql = Get-Psql
  if (-not $psql) { throw "psql.exe not found; set `$env:PGBIN to the PostgreSQL bin directory" }
  # Try the test password first, then whatever the environment says the superuser password is.
  $admin = $null
  foreach ($candidate in @($Password, $env:PGPASSWORD, "root", "postgres")) {
    if (-not $candidate) { continue }
    $r = Invoke-Psql $psql $candidate @("-tAc", "select 1")
    if ($r.Code -eq 0) { $admin = $candidate; break }
  }
  if ($null -eq $admin) {
    throw "a server answers on port $Port but no known superuser password works. Set `$env:PGPASSWORD to its postgres password and rerun, or run: ALTER USER postgres PASSWORD '$Password'; CREATE DATABASE $Db;"
  }
  $r = Invoke-Psql $psql $admin @("-c", "ALTER USER postgres PASSWORD '$Password';")
  if ($r.Code -ne 0) { throw "could not set the postgres password: $($r.Output)" }
  $r = Invoke-Psql $psql $Password @("-tAc", "select 1 from pg_database where datname = '$Db'")
  if ($r.Output.Trim() -ne "1") {
    $r = Invoke-Psql $psql $Password @("-c", "CREATE DATABASE $Db;")
    if ($r.Code -ne 0) { throw "could not create database ${Db}: $($r.Output)" }
  }
}

function Wait-DbReady([int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-DbReady) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-DockerPostgres {
  $all = @(& docker ps -a --format "{{.Names}}")
  $running = @(& docker ps --format "{{.Names}}")
  if ($running -contains $Container) {
    Write-Host "dev-postgres: container $Container is already running"
  } elseif ($all -contains $Container) {
    Write-Host "dev-postgres: starting the existing container $Container"
    & docker start $Container | Out-Null
  } else {
    Write-Host "dev-postgres: creating container $Container from $Image on port $Port"
    & docker run -d --name $Container -e "POSTGRES_PASSWORD=$Password" -e "POSTGRES_DB=$Db" -p "${Port}:5432" $Image | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker run failed" }
  }
  Write-Host "dev-postgres: waiting for the database"
  if (-not (Wait-DbReady 60)) { throw "the container did not become ready in 60 s; docker logs $Container" }
}

function Start-LocalPostgres {
  $svc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc) {
    Write-Host "dev-postgres: starting Windows service $($svc.Name)"
    if ($svc.StartType -eq "Disabled") { Set-Service -Name $svc.Name -StartupType Manual }
    if ($svc.Status -ne "Running") { Start-Service -Name $svc.Name }
  } elseif ($env:PGBIN -and $env:PGDATA) {
    Write-Host "dev-postgres: starting pg_ctl -D $env:PGDATA"
    & (Join-Path $env:PGBIN "pg_ctl.exe") -D $env:PGDATA -w start
    if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed" }
  } else {
    throw "no Docker daemon and no local PostgreSQL found. Install Docker Desktop (https://docs.docker.com/desktop/) or PostgreSQL 16 (winget install PostgreSQL.PostgreSQL.16) and rerun."
  }
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-ServerListening) { break }
    Start-Sleep -Seconds 1
  }
  if (-not (Test-ServerListening)) { throw "the local server is not listening on port $Port" }
  Initialize-LocalDb
}

function Stop-All {
  if ((Test-DockerOk) -and ((& docker ps --format "{{.Names}}") -contains $Container)) {
    & docker stop $Container | Out-Null
    Write-Host "dev-postgres: stopped container $Container (data kept; docker rm $Container to delete)"
    return
  }
  $svc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc -and $svc.Status -eq "Running") {
    Stop-Service -Name $svc.Name
    Write-Host "dev-postgres: stopped service $($svc.Name)"
    return
  }
  if ($env:PGBIN -and $env:PGDATA) {
    & (Join-Path $env:PGBIN "pg_ctl.exe") -D $env:PGDATA stop
    return
  }
  Write-Host "dev-postgres: nothing to stop"
}

function Write-Url {
  Write-Host ""
  Write-Host "Postgres is ready for the integration tests. Set this before running them:"
  Write-Host "    `$env:FORERUNNER_TEST_PG = `"$Url`""
  Write-Host "    pnpm test:integration"
}

try {
  if ($Stop) {
    Stop-All
    exit 0
  }
  if ($Status) {
    if (Test-DbReady) {
      Write-Host "dev-postgres: a server answers on port $Port with the test credentials"
      Write-Url
      exit 0
    } elseif (Test-ServerListening) {
      Write-Host "dev-postgres: a server listens on port $Port but the test database or password is not set up (run without -Status to fix)"
      exit 1
    } else {
      Write-Host "dev-postgres: nothing listens on port $Port"
      exit 1
    }
  }

  if (Test-DbReady) {
    Write-Host "dev-postgres: a server already answers on port $Port with the test credentials"
  } elseif (Test-ServerListening) {
    Write-Host "dev-postgres: a server already listens on port $Port; creating the test database"
    Initialize-LocalDb
  } elseif (Test-DockerOk) {
    Start-DockerPostgres
  } else {
    if (Test-Command docker) { Write-Host "dev-postgres: docker is installed but the daemon is not reachable (start Docker Desktop); trying a local server" }
    Start-LocalPostgres
  }
  if (-not (Test-DbReady)) { throw "the database is not reachable with $Url" }
  Write-Url
  exit 0
} catch {
  Write-Host "dev-postgres: $($_.Exception.Message)"
  exit 1
}
