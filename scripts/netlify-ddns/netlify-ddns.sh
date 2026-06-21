#!/usr/bin/env bash
# netlify-ddns.sh — keep a Netlify DNS A record pointed at this host's current
# public IPv4. Safe to run every minute; only hits the Netlify API on a change.
#
# Config comes from the environment (see netlify-ddns.env.example):
#   NETLIFY_TOKEN  Netlify personal access token (account-wide — keep it secret)
#   DOMAIN         the zone you manage in Netlify DNS, e.g. yourdomain.com
#   RECORD         the FQDN to keep updated   (default: notes.$DOMAIN)
#   TTL            record TTL in seconds       (default: 300)
set -euo pipefail

: "${NETLIFY_TOKEN:?set NETLIFY_TOKEN}"
DOMAIN="${DOMAIN:?set DOMAIN, e.g. yourdomain.com}"
RECORD="${RECORD:-notes.$DOMAIN}"
TTL="${TTL:-300}"
STATE_FILE="${STATE_FILE:-/var/lib/netlify-ddns/$RECORD.ip}"
API="https://api.netlify.com/api/v1"
auth=(-H "Authorization: Bearer $NETLIFY_TOKEN")
log() { printf '%s netlify-ddns: %s\n' "$(date -Is)" "$*"; }

# 1. current public IP (two providers for resilience)
ip="$(curl -fsS --ipv4 --max-time 10 https://api.ipify.org \
   || curl -fsS --ipv4 --max-time 10 https://icanhazip.com)" || { log "no public IP"; exit 0; }
ip="${ip//[$'\r\n ']/}"
[[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { log "bad IP '$ip'"; exit 0; }

# 2. skip if unchanged since last run
mkdir -p "$(dirname "$STATE_FILE")"
[[ -f "$STATE_FILE" && "$(cat "$STATE_FILE")" == "$ip" ]] && exit 0

# 3. resolve the zone + any existing A record for RECORD
zone_id="$(curl -fsS "${auth[@]}" "$API/dns_zones" \
  | jq -r --arg d "$DOMAIN" 'first(.[] | select(.name==$d) | .id) // empty')"
[[ -n "$zone_id" ]] || { log "no Netlify DNS zone for $DOMAIN"; exit 1; }
records="$(curl -fsS "${auth[@]}" "$API/dns_zones/$zone_id/dns_records")"
current="$(jq -r --arg h "$RECORD" \
  'first(.[] | select(.type=="A" and .hostname==$h) | .value) // empty' <<<"$records")"

if [[ "$current" == "$ip" ]]; then
  echo "$ip" > "$STATE_FILE"; exit 0   # Netlify already correct; just cache
fi

# 4. delete old A record(s), then create the new one (no in-place update on Netlify)
while read -r rid; do
  [[ -n "$rid" ]] && curl -fsS -X DELETE "${auth[@]}" "$API/dns_zones/$zone_id/dns_records/$rid" >/dev/null
done < <(jq -r --arg h "$RECORD" '.[] | select(.type=="A" and .hostname==$h) | .id' <<<"$records")

curl -fsS -X POST "${auth[@]}" -H 'Content-Type: application/json' \
  "$API/dns_zones/$zone_id/dns_records" \
  -d "$(jq -nc --arg h "$RECORD" --arg v "$ip" --argjson ttl "$TTL" \
        '{type:"A",hostname:$h,value:$v,ttl:$ttl}')" >/dev/null

echo "$ip" > "$STATE_FILE"
log "updated $RECORD -> $ip"
