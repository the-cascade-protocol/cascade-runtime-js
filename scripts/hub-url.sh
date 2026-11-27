#!/usr/bin/env bash
# Prints the docs site's address, the HUB_URL that .github/workflows/check.yml sets, read as YAML, and fails when it is not an
# http(s) address. Relies on yq, which the ubuntu runner images ship.
set -euo pipefail
hub=$(yq -r '.env.HUB_URL' "$(dirname "$0")/../.github/workflows/check.yml")
case "$hub" in
  http://?* | https://?*) printf '%s\n' "$hub" ;;
  *)
    echo "::error::HUB_URL in check.yml is '${hub}', not an http(s) address" >&2
    exit 1
    ;;
esac
