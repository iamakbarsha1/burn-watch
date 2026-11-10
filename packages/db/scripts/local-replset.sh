#!/usr/bin/env bash
# Disposable replica set for the scripts under src/scripts. Transactions need
# a replica set, even one node; three nodes make majority commits wait on real
# replication.
#
#   scripts/local-replset.sh up     prints the MONGODB_URI to use
#   scripts/local-replset.sh down   shuts every node down; data dirs are kept
#
#   BW_MONGO_NODES=3 scripts/local-replset.sh up    three members
#   BW_MONGO_PORT    first port, one per node from there (default 27117)
#   BW_MONGO_DIR     parent of one data dir per node (default /tmp/burn-watch-rs)
#
# Needs mongod and mongosh on PATH (brew install mongodb-community).
set -euo pipefail

NODES=${BW_MONGO_NODES:-1}
PORT=${BW_MONGO_PORT:-27117}
DIR=${BW_MONGO_DIR:-/tmp/burn-watch-rs}

hosts() {
  local out=()
  for ((i = 0; i < NODES; i++)); do out+=("127.0.0.1:$((PORT + i))"); done
  local IFS=,
  echo "${out[*]}"
}

case "${1:-}" in
  up)
    members=()
    for ((i = 0; i < NODES; i++)); do
      d="$DIR/$i"
      mkdir -p "$d"
      mongod --replSet rs0 --dbpath "$d" --port "$((PORT + i))" --bind_ip 127.0.0.1 \
        --fork --logpath "$d/mongod.log" >/dev/null
      members+=("{ _id: $i, host: '127.0.0.1:$((PORT + i))' }")
    done
    config="{ _id: 'rs0', members: [$(IFS=,; echo "${members[*]}")] }"
    mongosh --quiet --port "$PORT" --eval \
      "try { rs.status().ok } catch (e) { const r = rs.initiate($config); if (!r.ok) throw new Error(JSON.stringify(r)) }" \
      >/dev/null
    for _ in $(seq 1 60); do
      if [ "$(mongosh --quiet --port "$PORT" --eval 'db.hello().isWritablePrimary')" = "true" ]; then
        echo "mongodb://$(hosts)/burnwatch_race?replicaSet=rs0"
        exit 0
      fi
      sleep 0.5
    done
    echo "no primary elected within 30s; see $DIR/*/mongod.log" >&2
    exit 1
    ;;
  down)
    for ((i = NODES - 1; i >= 0; i--)); do
      mongosh --quiet --port "$((PORT + i))" --eval "db.getSiblingDB('admin').shutdownServer({ force: true })" >/dev/null 2>&1 || true
    done
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
