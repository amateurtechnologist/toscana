#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this bootstrap as root.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git jq
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y ca-certificates curl git jq
else
  echo 'Unsupported OCI image: apt-get or dnf is required.' >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker
fi

for deploy_user in ubuntu opc; do
  if id "$deploy_user" >/dev/null 2>&1; then
    usermod -aG docker "$deploy_user"
  fi
done

echo 'Docker bootstrap complete.'
