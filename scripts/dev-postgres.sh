#!/usr/bin/env bash
# Starts a local PostgreSQL for the integration tests and prints the FORERUNNER_TEST_PG URL.
#
# Order of preference:
#   1. a server already answering on localhost:5432 with the test credentials (nothing to do)
#   2. Docker: container "forerunner-pg" from the postgres:16 image (created, or restarted when it exists)
#   3. a locally installed server: pg_ctlcluster (Debian/Ubuntu), systemctl, or pg_ctl with PGDATA
#
# Usage: bash scripts/dev-postgres.sh [--stop] [--status]
#   --stop    stop the Docker container (or the local server started here); keeps the data
#   --status  only report what is running and print the URL
#
# Environment: FORERUNNER_PG_PORT (default 5432), FORERUNNER_PG_PASSWORD (default forerunner),
#              FORERUNNER_PG_DB (default forerunner_test), FORERUNNER_PG_IMAGE (default postgres:16)
set -euo pipefail

PORT=${FORERUNNER_PG_PORT:-5432}
PASSWORD=${FORERUNNER_PG_PASSWORD:-forerunner}
DB=${FORERUNNER_PG_DB:-forerunner_test}
IMAGE=${FORERUNNER_PG_IMAGE:-postgres:16}
CONTAINER=forerunner-pg
URL="postgres://postgres:${PASSWORD}@localhost:${PORT}/${DB}"
MODE=start

for arg in "$@"; do
  case "$arg" in
    --stop) MODE=stop ;;
    --status) MODE=status ;;
    -h | --help)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "dev-postgres: unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

docker_ok() { have docker && docker info >/dev/null 2>&1; }

print_url() {
  echo
  echo "Postgres is ready for the integration tests. Export this before running them:"
  echo "    export FORERUNNER_TEST_PG=\"$URL\""
  echo "    pnpm test:integration"
}

# Can we log in with the test credentials and does the database exist?
db_ready() {
  if have psql; then
    PGPASSWORD="$PASSWORD" psql "$URL" -tAc "select 1" >/dev/null 2>&1
  elif docker_ok && docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker exec -e PGPASSWORD="$PASSWORD" "$CONTAINER" psql -U postgres -d "$DB" -tAc "select 1" >/dev/null 2>&1
  else
    return 1
  fi
}

server_listening() {
  if have pg_isready; then
    pg_isready -h localhost -p "$PORT" >/dev/null 2>&1
  elif have node; then
    node -e 'const n=require("node:net");const s=n.connect(process.argv[1],"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),2000)' "$PORT"
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
  fi
}

# Create the database and set the postgres password on a server we can reach as a superuser.
# The SQL goes in on stdin: with `su postgres -c "psql ..."` a second `-c` would replace su's
# command (bash then tried to run "ALTER USER ..." as a program, "ALTER: command not found").
ensure_db_local() {
  local psql_cmd=()
  if PGPASSWORD="$PASSWORD" psql -h localhost -p "$PORT" -U postgres -d postgres -tAc "select 1" >/dev/null 2>&1; then
    psql_cmd=(env "PGPASSWORD=$PASSWORD" psql -h localhost -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -tA)
  elif [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then
    psql_cmd=(su postgres -c "psql -p $PORT -d postgres -v ON_ERROR_STOP=1 -tA")
  elif have sudo && id postgres >/dev/null 2>&1; then
    psql_cmd=(sudo -u postgres psql -p "$PORT" -d postgres -v ON_ERROR_STOP=1 -tA)
  else
    echo "dev-postgres: a server answers on port $PORT but neither the test password nor the postgres OS user works." >&2
    echo "Set the password and create the database yourself, then export FORERUNNER_TEST_PG:" >&2
    echo "    ALTER USER postgres PASSWORD '$PASSWORD'; CREATE DATABASE $DB;" >&2
    return 1
  fi
  run_sql() { printf '%s\n' "$1" | "${psql_cmd[@]}"; }
  run_sql "ALTER USER postgres PASSWORD '$PASSWORD';" >/dev/null
  if ! run_sql "select 1 from pg_database where datname = '$DB';" | grep -q 1; then
    run_sql "CREATE DATABASE $DB;" >/dev/null
  fi
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    if db_ready; then return 0; fi
    sleep 1
  done
  return 1
}

start_docker() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      echo "dev-postgres: container $CONTAINER is already running"
    else
      echo "dev-postgres: starting the existing container $CONTAINER"
      docker start "$CONTAINER" >/dev/null
    fi
  else
    echo "dev-postgres: creating container $CONTAINER from $IMAGE on port $PORT"
    docker run -d --name "$CONTAINER" \
      -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=$DB" \
      -p "${PORT}:5432" "$IMAGE" >/dev/null
  fi
  echo "dev-postgres: waiting for the database"
  wait_ready || {
    echo "dev-postgres: the container did not become ready in 60 s; docker logs $CONTAINER" >&2
    return 1
  }
}

start_local() {
  if have pg_ctlcluster && have pg_lsclusters; then
    # Debian/Ubuntu packaging: "version cluster port status ..." per line.
    local line version cluster
    line=$(pg_lsclusters --no-header 2>/dev/null | head -n 1 || true)
    if [ -n "$line" ]; then
      version=$(echo "$line" | awk '{print $1}')
      cluster=$(echo "$line" | awk '{print $2}')
      echo "dev-postgres: starting cluster $version/$cluster with pg_ctlcluster"
      if [ "$(id -u)" = 0 ]; then pg_ctlcluster "$version" "$cluster" start || true
      else sudo pg_ctlcluster "$version" "$cluster" start || true; fi
    fi
  elif have systemctl && systemctl list-unit-files 2>/dev/null | grep -q '^postgresql'; then
    echo "dev-postgres: starting postgresql with systemctl"
    if [ "$(id -u)" = 0 ]; then systemctl start postgresql; else sudo systemctl start postgresql; fi
  elif have pg_ctl && [ -n "${PGDATA:-}" ]; then
    echo "dev-postgres: starting pg_ctl -D $PGDATA"
    pg_ctl -D "$PGDATA" -w start
  elif have service; then
    echo "dev-postgres: starting postgresql with service"
    if [ "$(id -u)" = 0 ]; then service postgresql start; else sudo service postgresql start; fi
  else
    echo "dev-postgres: no Docker daemon and no local PostgreSQL found." >&2
    echo "Install Docker (https://docs.docker.com/engine/install/) or PostgreSQL 16 (apt install postgresql-16 / dnf install postgresql-server) and rerun." >&2
    return 1
  fi
  local i
  for i in $(seq 1 30); do
    if server_listening; then break; fi
    sleep 1
  done
  server_listening || {
    echo "dev-postgres: the local server is not listening on port $PORT" >&2
    return 1
  }
  ensure_db_local
}

stop_all() {
  if docker_ok && docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker stop "$CONTAINER" >/dev/null
    echo "dev-postgres: stopped container $CONTAINER (data kept; docker rm $CONTAINER to delete)"
    return 0
  fi
  if have pg_ctlcluster && have pg_lsclusters; then
    local line version cluster
    line=$(pg_lsclusters --no-header 2>/dev/null | grep -E '\bonline\b' | head -n 1 || true)
    if [ -n "$line" ]; then
      version=$(echo "$line" | awk '{print $1}')
      cluster=$(echo "$line" | awk '{print $2}')
      if [ "$(id -u)" = 0 ]; then pg_ctlcluster "$version" "$cluster" stop; else sudo pg_ctlcluster "$version" "$cluster" stop; fi
      echo "dev-postgres: stopped cluster $version/$cluster"
      return 0
    fi
  fi
  if have pg_ctl && [ -n "${PGDATA:-}" ]; then
    pg_ctl -D "$PGDATA" stop
    return 0
  fi
  echo "dev-postgres: nothing to stop"
}

case "$MODE" in
  stop)
    stop_all
    exit 0
    ;;
  status)
    if db_ready; then
      echo "dev-postgres: a server answers on port $PORT with the test credentials"
      print_url
    elif server_listening; then
      echo "dev-postgres: a server listens on port $PORT but the test database or password is not set up (run without --status to fix)"
      exit 1
    else
      echo "dev-postgres: nothing listens on port $PORT"
      exit 1
    fi
    exit 0
    ;;
esac

if db_ready; then
  echo "dev-postgres: a server already answers on port $PORT with the test credentials"
elif server_listening; then
  echo "dev-postgres: a server already listens on port $PORT; creating the test database"
  ensure_db_local
elif docker_ok; then
  start_docker
else
  if have docker; then echo "dev-postgres: docker is installed but the daemon is not reachable; trying a local server"; fi
  start_local
fi

db_ready || {
  echo "dev-postgres: the database is not reachable with $URL" >&2
  exit 1
}
print_url
