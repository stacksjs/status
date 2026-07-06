CREATE TABLE IF NOT EXISTS "status_pages" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "slug" varchar(255),
  "title" varchar(255),
  "custom_domain" varchar(255),
  "branding" varchar(255),
  "is_public" boolean default true,
  "access_type" access_type_type default 'public',
  "password_hash" varchar(255),
  "auth_email_domains" varchar(255),
  "allowed_ip_ranges" varchar(255),
  "locale" varchar(255) default 'en',
  "force_theme" force_theme_type default 'system',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
