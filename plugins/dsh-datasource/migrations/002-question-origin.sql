-- Stop the plugin and select its dedicated v4 management database before running.
-- The migration account needs ALTER and CREATE ROUTINE / ALTER ROUTINE permissions.
-- The normal plugin account does not need these migration permissions.
-- This migration preserves questions and leaves historical origins as unknown.
DELIMITER $$
CREATE PROCEDURE dsh_upgrade_question_origin()
BEGIN
  IF (SELECT COUNT(*) FROM dsh_management_migrations) <> 1
    OR (SELECT COUNT(*) FROM dsh_management_migrations WHERE version = 4) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Question origin migration requires a single v4 management version';
  END IF;

  ALTER TABLE dsh_questions
    ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'unknown',
    ADD COLUMN source_question_id VARCHAR(128) NULL;
  UPDATE dsh_management_migrations SET version = 5, applied_at = CURRENT_TIMESTAMP WHERE version = 4;
END$$
CALL dsh_upgrade_question_origin()$$
DROP PROCEDURE dsh_upgrade_question_origin$$
DELIMITER ;
