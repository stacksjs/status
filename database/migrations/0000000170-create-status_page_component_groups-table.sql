CREATE TABLE IF NOT EXISTS "status_page_component_groups" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT,
  "display_order" INTEGER default 0,
  "status_page_id" INTEGER REFERENCES "status_pages"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
