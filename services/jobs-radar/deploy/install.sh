#!/bin/bash
set -euo pipefail
test "$(pwd)" = /home/ubuntu/siyi/jobs-radar
test -f compose.yaml
test -f deploy/jobs-radar-collect.timer
sudo install -d -m 0700 -o 10001 -g 10001 data
docker compose build mcp
docker compose up -d mcp
sudo install -m 0644 deploy/jobs-radar-collect.service deploy/jobs-radar-collect.timer deploy/jobs-radar-backup.service deploy/jobs-radar-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jobs-radar-collect.timer jobs-radar-backup.timer
docker compose ps
