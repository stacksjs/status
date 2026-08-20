CREATE TABLE IF NOT EXISTS "status_pages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "slug" TEXT,
  "title" TEXT,
  "custom_domain" TEXT,
  "branding" TEXT,
  "is_public" INTEGER default 1,
  "access_type" TEXT default 'public',
  "password_hash" TEXT,
  "auth_email_domains" TEXT,
  "allowed_ip_ranges" TEXT,
  "locale" TEXT default 'en',
  "force_theme" TEXT default 'system',
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
