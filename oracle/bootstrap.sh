#!/usr/bin/env bash
set -Eeuo pipefail

: "${TOSCANA_DISCORD_TOKEN_SECRET_OCID:?TOSCANA_DISCORD_TOKEN_SECRET_OCID is required}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git
curl -fsSL https://get.docker.com | sh

if ! command -v oci >/dev/null 2>&1; then
  curl -fsSL https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh \
    -o /tmp/oci-cli-install.sh
  bash /tmp/oci-cli-install.sh \
    --accept-all-defaults \
    --install-dir /opt/oci-cli \
    --exec-dir /usr/local/bin
  rm -f /tmp/oci-cli-install.sh
fi

export OCI_CLI_AUTH=instance_principal
export OCI_CLI_REGION="$(curl -fsSL \
  -H 'Authorization: Bearer Oracle' \
  http://169.254.169.254/opc/v2/instance/region)"

discord_token="$(oci secrets secret-bundle get \
  --secret-id "$TOSCANA_DISCORD_TOKEN_SECRET_OCID" \
  --stage CURRENT \
  --auth instance_principal \
  --query 'data."secret-bundle-content".content' \
  --raw-output | base64 --decode)"
[[ -n "$discord_token" ]]

if [[ -d /opt/toscana/.git ]]; then
  git -C /opt/toscana pull --ff-only
else
  git clone --depth 1 https://github.com/amateurtechnologist/toscana.git /opt/toscana
fi

cd /opt/toscana
umask 077
printf '%s\n' \
  "DISCORD_TOKEN=$discord_token" \
  'CATEGORY_A_ID=1554077666573950986' \
  'CATEGORY_A_FORWARD_CHANNEL_ID=1560615321910386758' \
  'CATEGORY_B_ID=1554078902496792607' \
  'CATEGORY_B_FORWARD_CHANNEL_ID=1560615399547216042' \
  'TOSCANA_BLACKLIST_CHANNEL_IDS=' \
  'TOSCANA_BLACKLIST_GUILD_IDS=' > .env
unset discord_token

docker compose up -d --build
