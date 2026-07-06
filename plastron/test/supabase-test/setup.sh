#!/usr/bin/env bash
# Re-seed the plastron supabase test backend after `supabase start` / `db reset`.
# Idempotent: creates the canonical test user and seeds their kanban tasks.
# NOTE: after `supabase db reset`, restart Kong first or you'll get 502s:
#   docker restart supabase_kong_plastron-test supabase_rest_plastron-test \
#     supabase_realtime_plastron-test supabase_storage_plastron-test
set -euo pipefail
cd "$(dirname "$0")"

eval "$(supabase status -o env 2>/dev/null | sed 's/^/LOCAL_/')"
URL="${LOCAL_API_URL:-http://127.0.0.1:54421}"
SVC="${LOCAL_SERVICE_ROLE_KEY:?run \`supabase start\` first}"

# the canonical test + demo user (used by every supabase test and the kanban demo)
EMAIL="icar@rheophile.ca"
PASS="PlastronFunTest"

code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/auth/v1/admin/users" \
  -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"email_confirm\":true}")
case "$code" in
  200|201) echo "user created: $EMAIL" ;;
  422)     echo "user exists:  $EMAIL" ;;
  *)       echo "unexpected status creating $EMAIL: $code"; exit 1 ;;
esac

# seed the demo user's kanban (owner = their uid)
docker exec -i supabase_db_plastron-test psql -U postgres -v ON_ERROR_STOP=1 <<SQL
delete from public.kanban k using auth.users u where k.owner = u.id and u.email = '$EMAIL';
insert into public.kanban (owner, title, status, position)
select u.id, t.title, t.status, t.position
from auth.users u, (values
  ('Wire up Supabase auth in plastron','done',1),
  ('Design the session SecretHandle store','done',2),
  ('Build the kanban view panel','doing',3),
  ('Hook realtime into the rev counter','doing',4),
  ('Write Playwright e2e for login','todo',5),
  ('Ship the origin-user demo segment','todo',6)
) as t(title,status,position)
where u.email = '$EMAIL';
SQL
echo "seeded kanban for $EMAIL"
