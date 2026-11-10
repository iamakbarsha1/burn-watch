#!/usr/bin/env bash
# Disposable single-node replica set for the scripts under src/scripts.
# Transactions need a replica set, even one node.
#
#   scripts/local-replset.sh up     prints the MONGODB_URI to use
#   scripts/local-replset.sh down   shuts it down; the data dir is left for inspection
#
# Needs mongod and mongosh on PATH (brew install mongodb-community).
set -euo pipefail

PORT=${BW_MONGO_PORT:-27117}
DIR=${BW_MONGO_DIR:-/tmp/burn-watch-rs0}

case "${1:-}" in
  up)
    mkdir -p "$DIR"
    mongod --replSet rs0 --dbpath "$DIR" --port "$PORT" --bind_ip 127.0.0.1 \
      --fork --logpath "$DIR/mongod.log" >/dev/null
    mongosh --quiet --port "$PORT" --eval \
      "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:$PORT' }] }).ok }" \
      >/dev/null
    echo "mongodb://127.0.0.1:$PORT/burnwatch_race?replicaSet=rs0"
    ;;
  down)
    mongosh --quiet --port "$PORT" --eval "db.getSiblingDB('admin').shutdownServer()" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
