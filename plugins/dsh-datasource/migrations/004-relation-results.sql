-- Stop all plugin instances, back up the dedicated v6 database, and select it first.
-- Requires CREATE ROUTINE / ALTER ROUTINE and CREATE privileges.
-- MySQL DDL commits implicitly: this script cannot roll back partial table creation.
DELIMITER $$
CREATE PROCEDURE dsh_upgrade_relation_results()
BEGIN
  IF (SELECT COUNT(*) FROM dsh_management_migrations) <> 1
    OR (SELECT COUNT(*) FROM dsh_management_migrations WHERE version = 6) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Relation results migration requires a single v6 management version';
  END IF;
CREATE TABLE dsh_relation_canvases (
  profile_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  canvas_id VARCHAR(128) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  content JSON NOT NULL,
  layout JSON NOT NULL,
  confirmed BOOLEAN NOT NULL,
  signature CHAR(64) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (profile_id, source_id, canvas_id),
  FOREIGN KEY (profile_id, source_id) REFERENCES dsh_source_catalogs (profile_id, source_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE dsh_annotation_results (
  profile_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  saved_fingerprint CHAR(64) NULL,
  saved_at BIGINT UNSIGNED NULL,
  PRIMARY KEY (profile_id, source_id),
  FOREIGN KEY (profile_id, source_id) REFERENCES dsh_sources (profile_id, source_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

UPDATE dsh_management_migrations SET version = 7, applied_at = CURRENT_TIMESTAMP WHERE version = 6;
END$$
CALL dsh_upgrade_relation_results()$$
DROP PROCEDURE dsh_upgrade_relation_results$$
DELIMITER ;
