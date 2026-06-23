#!/usr/bin/env bash
# Re-seed the plastron supabase-library test backend after `supabase start` /
# `supabase db reset`. Idempotent: creates the confirmed test user if absent.
# Keys are read live from `supabase status` so this works on any machine.
set -euo pipefail
cd "$(dirname "$0")"

eval "$(supabase status -o env 2>/dev/null | sed 's/^/LOCAL_/')"
URL="${LOCAL_API_URL:-http://127.0.0.1:54421}"
SVC="${LOCAL_SERVICE_ROLE_KEY:?run \`supabase start\` first}"

EMAIL="icar@rheophie.ca"
PASS="PlastronFunTest"

code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/auth/v1/admin/users" \
  -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"email_confirm\":true}")
case "$code" in
  200|201) echo "test user created: $EMAIL" ;;
  422)     echo "test user already exists: $EMAIL" ;;
  *)       echo "unexpected status creating test user: $code"; exit 1 ;;
esac
