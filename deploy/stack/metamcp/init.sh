#!/bin/sh
# One-shot MetaMCP hardening (LBV2-2): create the admin account, then close
# self-registration. MetaMCP 2.4.22 ships with open UI + SSO signup and has no
# env switch for it; the setting lives in its `config` table.
set -eu

until wget -q -O /dev/null http://metamcp:12008/api/auth/get-session; do sleep 2; done

if [ "$(psql -tA -c "select count(*) from users where email = '$METAMCP_ADMIN_EMAIL'")" = "0" ]; then
  psql -q -c "delete from config where id in ('DISABLE_SIGNUP','DISABLE_SSO_SIGNUP')"
  wget -q -O /dev/null --header 'content-type: application/json' \
    --post-data "{\"email\":\"$METAMCP_ADMIN_EMAIL\",\"password\":\"$METAMCP_ADMIN_PASS\",\"name\":\"Lokyy Admin\"}" \
    http://metamcp:12008/api/auth/sign-up/email
  echo "admin account created"
fi

psql -q -c "insert into config (id, value, description) values
  ('DISABLE_SIGNUP', 'true', 'Self-registration closed by lokyy-stack init'),
  ('DISABLE_SSO_SIGNUP', 'true', 'SSO self-registration closed by lokyy-stack init')
  on conflict (id) do update set value = 'true', updated_at = now()"
echo "signup disabled; users: $(psql -tA -c 'select count(*) from users')"
