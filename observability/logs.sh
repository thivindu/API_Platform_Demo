#!/usr/bin/env bash
# View any of the demo's log streams.
#
#   ./logs.sh                 list the streams
#   ./logs.sh <stream>        show the last 30 entries
#   ./logs.sh <stream> -f     follow
#   ./logs.sh <stream> 100    show the last 100
#
# Streams:
#   access      Envoy access log        one text line per request (thin, no API identity)
#   traffic     Traffic logging         one JSON line per request (rich) — from the file sink
#   traffic-out Traffic logging         the same lines on the policy engine's stdout
#   analytics   OTLP analytics records  as the OpenTelemetry Collector received them
#   traces      Distributed traces      span summaries from Jaeger
#   runtime     gateway-runtime         everything: [rtr] Envoy + [pol] policy engine
#   controller  gateway-controller      control-plane link, policy loading, deployments
#   portal      API Portal              OIDC, webhook dispatch
#   mediator    subscription-mediator   webhook receipt -> gateway apply
#   collector   OpenTelemetry Collector export pipeline
#   fluentbit   Fluent Bit              log shipping to OpenSearch
#   apim        API Manager             Carbon log (host process)
#   is          Identity Server         Carbon log (host process)
#   opensearch  OpenSearch              aggregated container logs, newest first
set -uo pipefail

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
PORTAL_DIR="${PORTAL_DIR:-$(_first "$SETUP_DIR/wso2apip-api-portal-*")}"
MED_DIR="${MED_DIR:-$(_first "$SETUP_DIR/api-portal-platform-gateway-subscription-mediator/subscription-mediator")}"
APIM_LOG="${APIM_LOG:-$(_first "$SETUP_DIR/wso2am-*/repository/logs/wso2carbon.log")}"
IS_LOG="${IS_LOG:-$(_first "$SETUP_DIR/wso2is-*/repository/logs/wso2carbon.log")}"

# Each stream needs only its own path, so a missing one is reported when used
# rather than aborting every stream at startup.
_need() { [ -n "${1:-}" ] && [ -e "$1" ] || { echo "$2 not found under $SETUP_DIR — set WK_SETUP_DIR or the matching variable." >&2; exit 2; }; }

STREAM="${1:-}"
ARG="${2:-30}"
if [ "$ARG" = "-f" ]; then FOLLOW=1; N=30; else FOLLOW=0; N="$ARG"; fi

gwlogs() { # <service> <grep-or-empty>
    if [ "$FOLLOW" = "1" ]; then
        (cd "$GW_DIR" && docker compose logs -f --tail "$N" "$1" 2>/dev/null)
    else
        (cd "$GW_DIR" && docker compose logs --tail 2000 "$1" 2>/dev/null)
    fi
}
strip() { sed -E 's/^[a-z0-9_-]+ +\| //'; }

case "$STREAM" in
  access)
      _need "$GW_DIR" "gateway distribution"
      gwlogs gateway-runtime | strip | grep -E '^\[rtr\] \[20' | tail -n "$N" ;;

  traffic)
      _need "$GW_DIR" "gateway distribution"
      RT=$(cd "$GW_DIR" && docker compose ps -q gateway-runtime)
      if [ "$FOLLOW" = "1" ]; then
          docker exec "$RT" sh -c "tail -f -n $N /var/log/wso2/traffic/traffic.log"
      else
          docker exec "$RT" sh -c "tail -n $N /var/log/wso2/traffic/traffic.log"
      fi ;;

  traffic-out)
      gwlogs gateway-runtime | strip | grep '^{' | tail -n "$N" ;;

  analytics)
      # The collector's debug exporter. Set `verbosity: detailed` in
      # otel-collector/config*.yaml to see every attribute of every record;
      # at `normal` you get one summary line per batch.
      gwlogs otel-collector | strip | grep -iE 'wso2\.analytics|LogRecord|"logs"|log records' | tail -n "$N" ;;

  traces)
      curl -s "http://localhost:16686/api/traces?service=router&limit=$N" \
        | jq -r '.data[] | "\(.traceID)  \(.spans | length) spans  \((.spans[0].duration/1000)|floor)ms  \(.spans[0].operationName)"' ;;

  runtime)     gwlogs gateway-runtime    | tail -n "$N" ;;
  controller)  gwlogs gateway-controller | tail -n "$N" ;;
  collector)   gwlogs otel-collector     | tail -n "$N" ;;
  fluentbit)   gwlogs fluent-bit         | tail -n "$N" ;;

  portal)
      _need "$PORTAL_DIR" "portal distribution"
      if [ "$FOLLOW" = "1" ]; then (cd "$PORTAL_DIR" && docker compose logs -f --tail "$N" api-portal)
      else (cd "$PORTAL_DIR" && docker compose logs --tail "$N" api-portal); fi ;;

  mediator)
      _need "$MED_DIR" "subscription-mediator"
      if [ "$FOLLOW" = "1" ]; then (cd "$MED_DIR" && docker compose logs -f --tail "$N")
      else (cd "$MED_DIR" && docker compose logs --tail "$N"); fi ;;

  apim)
      _need "$APIM_LOG" "API Manager log"
      [ "$FOLLOW" = "1" ] && tail -f -n "$N" "$APIM_LOG" || tail -n "$N" "$APIM_LOG" ;;
  is)
      _need "$IS_LOG" "Identity Server log"
      [ "$FOLLOW" = "1" ] && tail -f -n "$N" "$IS_LOG"   || tail -n "$N" "$IS_LOG" ;;

  opensearch)
      curl -s "http://localhost:9200/gateway-logs-*/_search?size=$N" \
        -H 'Content-Type: application/json' \
        -d '{"sort":[{"@timestamp":"desc"}]}' \
      | jq -r '.hits.hits[]._source | "\(.["@timestamp"])  \(.component)  \(.api.name // .log // "" | tostring | .[0:110])"' ;;

  *)
      sed -n '/^# Streams:/,/^set -uo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      echo
      echo "UIs:  Jaeger http://localhost:16686 | Grafana http://localhost:3000 (admin/admin)"
      echo "      Prometheus http://localhost:9092 | OpenSearch Dashboards http://localhost:5601"
      exit 1 ;;
esac
