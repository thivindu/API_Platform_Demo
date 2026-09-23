#!/usr/bin/env bash
# Copy the observability configs that must live inside the gateway distribution
# into place, then show what changed.
#
# Everything else (prometheus, grafana, fluent-bit, otel-collector, datadog) is
# mounted straight out of this directory by the gateway's docker-compose.yaml
# via ../../observability/... — only config.toml has to be copied, because the
# gateway reads it from configs/ inside the distribution.
#
#   ./apply.sh          copy and diff
#   ./apply.sh --restart  copy, then restart the gateway stack
set -euo pipefail

# ------------------------------------------------------------------ paths ---
# Nothing below is pinned to a version-numbered directory name or to a fixed
# layout: the distributions change version each release, and this directory is
# committed to a repo that may be checked out anywhere. Every path is derived by
# glob and can be overridden by environment variable:
#
#   WK_SETUP_DIR  root holding the unpacked distributions (default: ../setup
#                 relative to this script, which is the verify-work layout)
#   GW_DIR        gateway distribution      PORTAL_DIR  portal distribution
#   MED_DIR       subscription-mediator     APIM_LOG / IS_LOG  Carbon logs
OBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_DIR="${WK_SETUP_DIR:-$OBS_DIR/../setup}"

# First existing match of a glob, or empty.
_first() { local g; for g in $1; do [ -e "$g" ] && { printf '%s' "$g"; return 0; }; done; return 1; }
GW_DIR="${GW_DIR:-$(_first "$SETUP_DIR/wso2apip-api-gateway-*")}"
if [ -z "${GW_DIR:-}" ] || [ ! -d "$GW_DIR" ]; then
    echo "gateway distribution not found under $SETUP_DIR" >&2
    echo "Set WK_SETUP_DIR, or GW_DIR to the gateway distribution itself." >&2
    exit 1
fi

if [ -f "$GW_DIR/configs/config.toml" ] && ! cmp -s "$OBS_DIR/gateway/config.toml" "$GW_DIR/configs/config.toml"; then
    cp "$GW_DIR/configs/config.toml" "$GW_DIR/configs/config.toml.bak"
    echo "backed up existing config.toml -> configs/config.toml.bak"
fi

cp "$OBS_DIR/gateway/config.toml" "$GW_DIR/configs/config.toml"
echo "installed gateway/config.toml -> $GW_DIR/configs/config.toml"

if [ "${1:-}" = "--restart" ]; then
    echo "restarting the gateway stack ..."
    ( cd "$GW_DIR" && docker compose up -d )
fi
