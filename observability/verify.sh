#!/usr/bin/env bash
# Verify the whole demo: platform (setup.md) + observability (observability.md).
#
#   ./verify.sh              check everything, no traffic generated
#   ./verify.sh --traffic    send a few API calls first, so the observability
#                            pillars have something fresh to show
#
# Exit status is 0 only when every REQUIRED check passed.
# Checks marked [opt] are informational and never fail the run.

set -uo pipefail

# Credentials come from verify.env beside this script — NOT from defaults baked
# in here. They all rotate on a re-setup, and a stale hardcoded password fails
# every management-API check with a 401 that looks like a platform fault.
_ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify.env"
if [ -f "$_ENV_FILE" ]; then set -a; . "$_ENV_FILE"; set +a; fi
GW_USER="${GW_USER:-admin}"
GW_PASS="${GW_PASS:-}"
RAILCO_ID="${RAILCO_ID:-}"
RAILCO_SECRET="${RAILCO_SECRET:-}"
RAILCO_SUBKEY="${RAILCO_SUBKEY:-}"
if [ -z "$GW_PASS" ] || [ -z "$RAILCO_ID" ]; then
    echo "verify.env not found or incomplete at $_ENV_FILE" >&2
    echo "It must set GW_PASS, RAILCO_ID and RAILCO_SECRET (see verify-work/setup/CREDENTIALS.md)." >&2
    exit 2
fi

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
    echo "Set WK_SETUP_DIR to the directory holding the unpacked distributions," >&2
    echo "or GW_DIR to the gateway distribution itself." >&2
    exit 2
fi

pass=0; fail=0
GWAPI_ERR=""
G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; B=$'\033[1m'; N=$'\033[0m'

ok()   { printf "  ${G}PASS${N}  %-46s %s\n" "$1" "${2:-}"; pass=$((pass+1)); }
no()   { printf "  ${R}FAIL${N}  %-46s %s\n" "$1" "${2:-}"; fail=$((fail+1)); }
note() { printf "  ${Y}note${N}  %-46s %s\n" "$1" "${2:-}"; }
head_() { printf "\n${B}%s${N}\n" "$1"; }

# check <label> <expected> <actual>
check() { [ "$2" = "$3" ] && ok "$1" "$3" || no "$1" "got '$3', want '$2'"; }
# checkn <label> <min> <actual>   — numeric, actual must be >= min
checkn() {
    local a="${3:-0}"; [[ "$a" =~ ^[0-9]+$ ]] || a=0
    [ "$a" -ge "$2" ] && ok "$1" "$a" || no "$1" "got $a, want >= $2"
}

# Management API GET. Emits "<http-code>\t<body>" on one line so the caller can
# see the status WITHOUT relying on a variable set inside a command
# substitution — that runs in a subshell, so the assignment never reaches the
# parent and a real failure silently reads as an empty result.
gwapi() {
    local resp code body
    resp=$(curl -s --max-time 20 -u "$GW_USER:$GW_PASS" \
             -w '\n%{http_code}' "http://platform.gw.wso2.com:9090/api/management/v1/$1" 2>/dev/null)
    code="${resp##*$'\n'}"
    body="${resp%$'\n'*}"
    [ -n "$code" ] || code="000"
    printf '%s\t%s' "$code" "$(printf '%s' "$body" | tr -d '\n')"
}

# gwcheck <label> <min> <path> <jq-filter>
gwcheck() {
    local out code body n
    out=$(gwapi "$3")
    code="${out%%$'\t'*}"
    body="${out#*$'\t'}"
    if [ "$code" != "200" ]; then
        no "$1" "HTTP $code from /$3 — $(printf '%s' "$body" | cut -c1-90)"
        return
    fi
    n=$(printf '%s' "$body" | jq -r "$4" 2>/dev/null)
    if [ -z "$n" ] || [ "$n" = "null" ]; then
        no "$1" "200 but unparseable — $(printf '%s' "$body" | cut -c1-90)"
        return
    fi
    checkn "$1" "$2" "$n"
}

promq() { curl -s "http://localhost:9092/api/v1/query" --data-urlencode "query=$1"; }

# ---------------------------------------------------------------- traffic ---
if [ "${1:-}" = "--traffic" ]; then
    head_ "Generating traffic"
    TOK=$(curl -sk -X POST https://is.wso2.com:9444/oauth2/token \
            -u "$RAILCO_ID:$RAILCO_SECRET" -d 'grant_type=client_credentials' | jq -r .access_token)
    sleep 3   # the portal/IS clock skew: a token is not valid for ~1s after minting
    # Subscription-Key is required now that OrderManagementAPI carries the
    # subscription-validation policy; without it every request is a 403 and the
    # pipelines fill with denials instead of real traffic.
    for i in 1 2 3; do
        curl -sk -o /dev/null -X POST https://platform.gw.wso2.com:8443/order-management/v1.0/orders \
            -H "Authorization: Bearer $TOK" -H 'X-Org-Name: railco' \
            ${RAILCO_SUBKEY:+-H "Subscription-Key: $RAILCO_SUBKEY"} \
            -H 'Content-Type: application/json' -d '{"item":"verify-probe"}'
    done
    curl -sk -o /dev/null -X POST https://platform.gw.wso2.com:8443/order-management/v1.0/orders \
        -H 'X-Org-Name: railco' -d '{}'          # a 401, to exercise the denied-request path
    # 20s, not 10: Prometheus scrapes every 15s, so a freshly recreated
    # gateway-runtime has not been scraped yet at 10s and the analytics counter
    # reads as absent — a false failure that looks like a broken publisher.
    echo "  sent 3 successful + 1 denied request; waiting 20s for the pipelines to flush"
    sleep 20
fi

# =========================================================== 1. PLATFORM ====
head_ "1. Platform (setup.md)"

check "API Manager :9443"      200 "$(curl -sk -o /dev/null -w '%{http_code}' https://am.wso2.com:9443/services/Version)"
check "Identity Server :9444"  200 "$(curl -sk -o /dev/null -w '%{http_code}' https://is.wso2.com:9444/oauth2/jwks)"
check "API Portal :9543"       302 "$(curl -sk -o /dev/null -w '%{http_code}' https://api-portal.wso2.com:9543/api-portal/public/views/default)"
check "Gateway health :9094"   healthy "$(curl -s http://platform.gw.wso2.com:9094/api/admin/v1/health | jq -r .status)"
check "Mediator health :8085"  ok "$(curl -s http://localhost:8085/health | jq -r .status)"

gwcheck "Gateway REST APIs"     4 rest-apis     '[.apis[]?.metadata.name] | length'
gwcheck "Gateway MCP proxies"   2 mcp-proxies   '[.mcpProxies[]?.metadata.name] | length'
gwcheck "Gateway subscriptions" 2 subscriptions '.count // 0'

# The controller's basic auth is bcrypt: if this endpoint is slow, everything
# that drives it (this script, the mediator) starts timing out.
MS=$(curl -s -o /dev/null --max-time 20 -u "$GW_USER:$GW_PASS" -w '%{time_total}' \
       "http://platform.gw.wso2.com:9090/api/management/v1/rest-apis" 2>/dev/null)
if awk -v t="${MS:-99}" 'BEGIN{exit !(t < 1.0)}'; then
    ok "Management API latency" "${MS}s"
else
    no "Management API latency" "${MS}s — raise the controller's cpus/mem_limit in docker-compose.yaml"
fi

check "Mediator failed events" 0 "$(curl -s http://localhost:8085/status | jq -r '.queue.failed')"

for p in 7093 7094 7095 7096; do
    c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$p/anything")
    [ "$c" = "200" ] && ok "Mock backend :$p" "200" || no "Mock backend :$p" "$c"
done

# =========================================== 2. GATEWAY VERSION / POLICY ====
head_ "2. Gateway build"

IMG=$(cd "$GW_DIR" && docker compose config 2>/dev/null | grep -m1 'wk-gateway-gateway-runtime' | awk '{print $2}')
case "$IMG" in
    *:1.2.1) ok "Runtime image is 1.2.1" "$IMG" ;;
    *)       no "Runtime image is 1.2.1" "${IMG:-not found} (OTel analytics needs >= 1.2.1)" ;;
esac
checkn "dynamic-routing policy loaded" 1 \
    "$(cd "$GW_DIR" && docker compose logs gateway-controller 2>/dev/null | grep -c 'name=dynamic-routing')"

# ====================================================== 3. TRAFFIC LOGGING ==
head_ "3. Traffic logging"

RT=$(cd "$GW_DIR" && docker compose ps -q gateway-runtime 2>/dev/null)
if [ -n "$RT" ]; then
    checkn "traffic.log lines" 1 \
        "$(docker exec "$RT" sh -c 'wc -l < /var/log/wso2/traffic/traffic.log' 2>/dev/null | tr -d ' ')"
    PERM=$(docker exec "$RT" sh -c 'stat -c %a /var/log/wso2/traffic/traffic.log' 2>/dev/null)
    check "traffic.log mode is 0600" 600 "$PERM"
    LAST=$(docker exec "$RT" sh -c 'tail -1 /var/log/wso2/traffic/traffic.log' 2>/dev/null)
    [ -n "$(echo "$LAST" | jq -r '.api.name // empty' 2>/dev/null)" ] \
        && ok "last line has API identity" "$(echo "$LAST" | jq -r '.api.name')" \
        || no "last line has API identity" "unparseable or empty"
    checkn "stdout sink active" 1 \
        "$(cd "$GW_DIR" && docker compose logs gateway-runtime 2>/dev/null | grep -c 'Traffic logging publisher added')"
else
    no "gateway-runtime container" "not running"
fi

checkn "OpenSearch log docs" 1 \
    "$(curl -s 'http://localhost:9200/gateway-logs-*/_count' | jq -r '.count // 0')"
check  "OpenSearch Dashboards :5601" 200 "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5601/api/status)"

# Only the last 2 minutes. Fluent Bit starts flushing before OpenSearch is
# ready to accept (depends_on waits for container start, not readiness), so a
# burst of retries right after `compose up` is expected and self-healing.
# Scanning a fixed tail instead would keep failing on those long after they
# stopped mattering.
FBERR=$(cd "$GW_DIR" && docker compose logs --since 120s fluent-bit 2>/dev/null | grep -c 'failed to flush')
[ "$FBERR" -eq 0 ] && ok "Fluent Bit flushing cleanly" "0 flush errors in last 2m" \
                   || no "Fluent Bit flushing cleanly" "$FBERR flush errors in last 2m"

# ============================================================= 4. TRACING ==
head_ "4. Tracing"

SVCS=$(curl -s http://localhost:16686/api/services | jq -r '[.data[]?] | join(",")')
checkn "Jaeger services"  2 "$(curl -s http://localhost:16686/api/services | jq '[.data[]?] | length')"
note   "services" "$SVCS"
checkn "Jaeger traces (router)" 1 \
    "$(curl -s 'http://localhost:16686/api/traces?service=router&limit=200' | jq '[.data[]?] | length')"
checkn "Spans accepted by collector" 1 \
    "$(curl -s http://localhost:8889/metrics | awk '/^otelcol_receiver_accepted_spans/{print int($2)}' | head -1)"

# ============================================================= 5. METRICS ==
head_ "5. Metrics"

UP=$(curl -s http://localhost:9092/api/v1/targets | jq '[.data.activeTargets[] | select(.health=="up")] | length')
DOWN=$(curl -s http://localhost:9092/api/v1/targets | jq -r '[.data.activeTargets[] | select(.health!="up") | .labels.job] | join(",")')
check  "Prometheus targets up" 3 "$UP"
[ -n "$DOWN" ] && note "targets not up" "$DOWN"
checkn "Distinct metric names" 50 \
    "$(curl -s http://localhost:9092/api/v1/label/__name__/values | jq '.data | length')"
check  "Grafana :3000" 200 "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/login)"
checkn "Grafana dashboards" 3 \
    "$(curl -s -u admin:admin 'http://localhost:3000/api/search?type=dash-db' | jq 'length')"

# =========================================================== 6. ANALYTICS ==
head_ "6. Analytics (OpenTelemetry)"

PUB=$(promq 'policy_engine_analytics_published_total' | jq -r '.data.result[0].value[1] // 0')
DROP=$(promq 'sum(policy_engine_analytics_dropped_total)' | jq -r '.data.result[0].value[1] // 0')
checkn "Analytics records published" 1 "$PUB"
check  "Analytics records dropped"   0 "$DROP"
checkn "Log records accepted by collector" 1 \
    "$(curl -s http://localhost:8889/metrics | awk '/^otelcol_receiver_accepted_log_records/{print int($2)}' | head -1)"
check  "Log records refused by collector"  0 \
    "$(curl -s http://localhost:8889/metrics | awk '/^otelcol_receiver_refused_log_records/{print int($2)}' | head -1)"

CFG=$(grep -E '^OTEL_COLLECTOR_CONFIG=' "$GW_DIR/.env" 2>/dev/null | cut -d= -f2)
DDKEY=$(grep -E '^DD_API_KEY=' "$OBS_DIR/datadog/datadog.env" 2>/dev/null | cut -d= -f2)
if [ "$CFG" = "config-datadog.yaml" ]; then
    if [ -n "$DDKEY" ]; then
        ERRS=$(cd "$GW_DIR" && docker compose logs --tail 300 otel-collector 2>/dev/null \
                 | grep -ci 'error while validating api key\|failed to send')
        [ "$ERRS" -eq 0 ] && ok "Datadog exporter delivering" "no export errors" \
                          || no "Datadog exporter delivering" "$ERRS export errors — check DD_API_KEY / DD_SITE"
    else
        no "Datadog pipeline selected but DD_API_KEY empty" "set it in observability/datadog/datadog.env"
    fi
else
    note "[opt] Datadog pipeline" "not selected (OTEL_COLLECTOR_CONFIG=${CFG:-config.yaml})"
    [ -z "$DDKEY" ] && note "[opt] DD_API_KEY" "empty — fill datadog/datadog.env, then set config-datadog.yaml"
fi

# ============================================================== summary ====
printf "\n${B}%d passed, %d failed${N}\n" "$pass" "$fail"
[ "$fail" -eq 0 ] && printf "${G}Everything is set up.${N}\n" || printf "${R}Some checks failed (see above).${N}\n"
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
