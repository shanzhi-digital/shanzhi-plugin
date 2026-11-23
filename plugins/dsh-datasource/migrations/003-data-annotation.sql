-- Stop all plugin instances and select the dedicated v5 management database first.
-- The migration account needs CREATE ROUTINE / ALTER ROUTINE and CREATE privileges.
DELIMITER $$
CREATE PROCEDURE dsh_upgrade_data_annotation()
BEGIN
  IF (SELECT COUNT(*) FROM dsh_management_migrations) <> 1
    OR (SELECT COUNT(*) FROM dsh_management_migrations WHERE version = 5) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Data annotation migration requires a single v5 management version';
  END IF;
CREATE TABLE dsh_table_annotations (
  profile_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  table_id VARCHAR(128) NOT NULL,
  text LONGTEXT NOT NULL,
  confirmed BOOLEAN NOT NULL,
  signature VARCHAR(64) NOT NULL,
  updated_at BIGINT UNSIGNED NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (profile_id, source_id, table_id),
  FOREIGN KEY (profile_id, source_id, table_id) REFERENCES dsh_source_tables (profile_id, source_id, table_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE dsh_field_annotations (
  profile_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  table_id VARCHAR(128) NOT NULL,
  field_name VARCHAR(255) NOT NULL,
  text LONGTEXT NOT NULL,
  confirmed BOOLEAN NOT NULL,
  signature VARCHAR(64) NOT NULL,
  updated_at BIGINT UNSIGNED NULL,
  revision BIGINT UNSIGNED NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (profile_id, source_id, table_id, field_name),
  FOREIGN KEY (profile_id, source_id, table_id) REFERENCES dsh_source_tables (profile_id, source_id, table_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

UPDATE dsh_management_migrations SET version = 6, applied_at = CURRENT_TIMESTAMP WHERE version = 5;
END$$
CALL dsh_upgrade_data_annotation()$$
DROP PROCEDURE dsh_upgrade_data_annotation$$
DELIMITER ;
