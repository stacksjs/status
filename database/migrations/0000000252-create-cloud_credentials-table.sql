-- Cloud-provider credentials for platform automation (currently AWS: the
-- EC2 metrics-agent provisioning that pushes the agent to a monitored box via
-- EC2 Instance Connect). One row per (team, provider); the settings page
-- upserts it. The secret access key is stored ENCRYPTED (AES-256-GCM under
-- APP_KEY — see app/Actions/Cloud/cloudCrypto.ts), never in plaintext; the
-- access key id and region are non-secret and stored as-is.
--
-- Additive create only. Applied by hand on prod like the rest (never
-- `buddy migrate --force`, which mis-proposes DROPs on trait-injected auth
-- columns). Types chosen to parse on both SQLite and Postgres.
CREATE TABLE IF NOT EXISTS "cloud_credentials" (
  "id" INTEGER PRIMARY KEY,
  "team_id" bigint not null,
  "provider" varchar(32) not null default 'aws',
  "access_key_id" varchar(255),
  "secret_access_key_encrypted" text,
  "region" varchar(64) not null default 'us-east-1',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);

CREATE UNIQUE INDEX IF NOT EXISTS "cloud_credentials_team_provider_unique"
  ON "cloud_credentials" ("team_id", "provider");
