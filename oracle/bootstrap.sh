#!/usr/bin/env bash
set -Eeuo pipefail

: "${DISCORD_TOKEN:?DISCORD_TOKEN is required}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git
curl -fsSL https://get.docker.com | sh

if [[ -d /opt/toscana/.git ]]; then
  git -C /opt/toscana pull --ff-only
else
  git clone --depth 1 https://github.com/amateurtechnologist/toscana.git /opt/toscana
fi

cd /opt/toscana
umask 077
printf '%s\n' \
  "DISCORD_TOKEN=$DISCORD_TOKEN" \
  'CATEGORY_A_ID=1554077666573950986' \
  'CATEGORY_A_FORWARD_CHANNEL_ID=1560615321910386758' \
  'CATEGORY_B_ID=1554078902496792607' \
  'CATEGORY_B_FORWARD_CHANNEL_ID=1560615399547216042' \
  'TOSCANA_BLACKLIST_CHANNEL_IDS=' \
  'TOSCANA_BLACKLIST_GUILD_IDS=' > .env

docker compose up -d --build
