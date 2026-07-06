-- Super-admin flag: a super-admin sees every monitor / status page / incident
-- across every team, bypassing the per-team scoping the dashboard views apply
-- to normal members. Off by default so existing users are unaffected; only the
-- two operator accounts (chris@ / adelino@uptime-status.org) get it set.
--
-- Additive ALTER only. `buddy migrate` is known to mis-propose DROPs for
-- trait-injected auth/2FA columns on this table, so this is applied by hand
-- (never `buddy migrate --force`). `boolean` + `default false` parse on both
-- SQLite (NUMERIC affinity, `false` literal supported) and Postgres.
ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean not null default false;
