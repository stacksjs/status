PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE "_qb_tmp_status_page_monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "display_name" TEXT,
  "display_order" INTEGER default 0,
  "status_page_id" INTEGER REFERENCES "status_pages"("id"),
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "status_page_component_group_id" INTEGER REFERENCES "status_page_component_groups"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
INSERT INTO "_qb_tmp_status_page_monitors" ("id", "display_name", "display_order", "status_page_id", "monitor_id", "status_page_component_group_id", "created_at", "updated_at") SELECT "id", "display_name", "display_order", "status_page_id", "monitor_id", "status_page_component_group_id", "created_at", "updated_at" FROM "status_page_monitors";
DROP TABLE "status_page_monitors";
ALTER TABLE "_qb_tmp_status_page_monitors" RENAME TO "status_page_monitors";
PRAGMA foreign_key_check;
COMMIT;
PRAGMA foreign_keys=ON;
