-- Which box this monitor's site runs on (servers.id, 0000000281). Nullable: a
-- monitor with no agent (a third-party API, a CDN) has none and behaves
-- exactly as before.
--
-- Hand-written ALTER rather than a generated migration, for the reason
-- 0000000255 records: for a pre-existing table the generator emits a
-- dual-dialect table rebuild, and this app is live on SQLite. The model
-- generator also only ever emits CREATE TABLE IF NOT EXISTS per model, never
-- a column alter, so this column has nowhere else to come from.
ALTER TABLE "monitors" ADD COLUMN "server_id" INTEGER;
CREATE INDEX IF NOT EXISTS "monitors_server_id_index" ON "monitors" ("server_id");
