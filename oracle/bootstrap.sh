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

if [[ -n "${TOSCANA_RUNNER_USER:-}" ]]; then
  runner_user="$TOSCANA_RUNNER_USER"
elif id ubuntu >/dev/null 2>&1; then
  runner_user=ubuntu
elif id opc >/dev/null 2>&1; then
  runner_user=opc
else
  echo 'Set TOSCANA_RUNNER_USER to an existing non-root VM user.' >&2
  exit 1
fi

[[ "$runner_user" != root ]] || {
  echo 'The GitHub Runner must use a non-root user.' >&2
  exit 1
}

runner_dir=/opt/toscana-runner
install -d -m 0755 -o "$runner_user" -g "$runner_user" "$runner_dir"

if [[ ! -f "$runner_dir/.runner" ]]; then
  : "${TOSCANA_RUNNER_TOKEN:?TOSCANA_RUNNER_TOKEN is required for first setup}"
  runner_metadata="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
  runner_url="$(jq -r '.assets[] | select(.name | test("^actions-runner-linux-x64-[0-9.]+\\.tar\\.gz$")) | .browser_download_url' <<<"$runner_metadata" | head -n 1)"
  runner_digest="$(jq -r '.assets[] | select(.name | test("^actions-runner-linux-x64-[0-9.]+\\.tar\\.gz$")) | .digest' <<<"$runner_metadata" | head -n 1)"
  [[ -n "$runner_url" && "$runner_url" != null ]]

  curl -fsSL "$runner_url" -o /tmp/toscana-runner.tar.gz
  if [[ "$runner_digest" == sha256:* ]]; then
    expected_digest="${runner_digest#sha256:}"
    actual_digest="$(sha256sum /tmp/toscana-runner.tar.gz | awk '{print $1}')"
    [[ "$actual_digest" == "$expected_digest" ]]
  fi
  tar -xzf /tmp/toscana-runner.tar.gz -C "$runner_dir"
  rm -f /tmp/toscana-runner.tar.gz
  "$runner_dir/bin/installdependencies.sh"
  chown -R "$runner_user:$runner_user" "$runner_dir"

  runuser -u "$runner_user" -- "$runner_dir/config.sh" \
    --unattended \
    --url "${TOSCANA_REPOSITORY:-https://github.com/amateurtechnologist/toscana}" \
    --token "$TOSCANA_RUNNER_TOKEN" \
    --name "${TOSCANA_RUNNER_NAME:-toscana-oci}" \
    --labels 'toscana,oci' \
    --work '_work'
  unset TOSCANA_RUNNER_TOKEN
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo 'systemd is required to keep the GitHub Runner online.' >&2
  exit 1
fi

service_file="$(find /etc/systemd/system -maxdepth 1 -type f -name 'actions.runner.*.service' -print -quit)"
if [[ -z "$service_file" ]]; then
  "$runner_dir/svc.sh" install "$runner_user" >/dev/null
fi
"$runner_dir/svc.sh" start >/dev/null

echo "GitHub Actions Runner is online as $runner_user."
