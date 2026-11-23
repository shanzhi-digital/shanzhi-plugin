-- Select the dedicated management database before running this initialization script.
CREATE TABLE IF NOT EXISTS dsh_management_profiles (
  profile_id VARCHAR(128) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_management_migrations (
  version INT UNSIGNED NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_sources (
  profile_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  metadata JSON NOT NULL,
  connection_version BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  enabled BOOLEAN NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (profile_id, source_id),
  FOREIGN KEY (profile_id) REFERENCES dsh_management_profiles (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_source_catalogs (
  profile_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  catalog_id VARCHAR(128) NOT NULL,
  scanned_at VARCHAR(32) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  domains JSON NOT NULL,
  domain_context LONGTEXT NOT NULL,
  PRIMARY KEY (profile_id, source_id),
  FOREIGN KEY (profile_id, source_id) REFERENCES dsh_sources (profile_id, source_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_source_tables (
  profile_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  table_id VARCHAR(128) NOT NULL,
  position INT UNSIGNED NOT NULL,
  schema_name LONGTEXT NOT NULL,
  table_name LONGTEXT NOT NULL,
  table_kind VARCHAR(32) NOT NULL,
  source_comment LONGTEXT NOT NULL,
  fields JSON NOT NULL,
  enabled BOOLEAN NOT NULL,
  domain_name VARCHAR(255) NOT NULL,
  category VARCHAR(255) NOT NULL,
  reason LONGTEXT NOT NULL,
  structure_hash VARCHAR(128) NOT NULL,
  freshness JSON NULL,
  PRIMARY KEY (profile_id, source_id, table_id),
  FOREIGN KEY (profile_id, source_id) REFERENCES dsh_source_catalogs (profile_id, source_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_questions (
  profile_id VARCHAR(128) NOT NULL,
  question_id VARCHAR(128) NOT NULL,
  question_text TEXT NOT NULL,
  answer LONGTEXT NOT NULL,
  origin VARCHAR(16) NOT NULL DEFAULT 'unknown',
  source_question_id VARCHAR(128) NULL,
  version BIGINT UNSIGNED NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (profile_id, question_id),
  FOREIGN KEY (profile_id) REFERENCES dsh_management_profiles (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_question_links (
  profile_id VARCHAR(128) NOT NULL,
  question_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  table_id VARCHAR(128) NOT NULL,
  fields JSON NOT NULL,
  reason LONGTEXT NOT NULL,
  question_version BIGINT UNSIGNED NOT NULL,
  structure_hash VARCHAR(128) NOT NULL,
  analyzed_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (profile_id, question_id, source_id, table_id),
  FOREIGN KEY (profile_id, question_id) REFERENCES dsh_questions (profile_id, question_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, source_id, table_id) REFERENCES dsh_source_tables (profile_id, source_id, table_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Bindings intentionally survive source deletion as retired sessions.
CREATE TABLE IF NOT EXISTS dsh_flow_bindings (
  profile_id VARCHAR(128) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  retired BOOLEAN NOT NULL,
  PRIMARY KEY (profile_id, session_id),
  KEY (profile_id, source_id),
  FOREIGN KEY (profile_id) REFERENCES dsh_management_profiles (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS dsh_table_annotations (
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

CREATE TABLE IF NOT EXISTS dsh_field_annotations (
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

INSERT IGNORE INTO dsh_management_migrations (version) VALUES (6);
