#!/bin/bash
set -euo pipefail
cd /home/ubuntu/siyi/jobs-radar
docker compose run --rm --no-deps admin backup "/data/backups/jobs-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
# Keep three verified recovery points across scheduled and pre-change backups.
python3 deploy/prune_backups.py
