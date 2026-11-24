-- Destructive manual reset: stop plugin instances and select the dedicated management database first.
-- Run migrations/001-management.sql after this script to create the v7 schema.
DROP TABLE IF EXISTS dsh_annotation_results;
DROP TABLE IF EXISTS dsh_relation_canvases;
DROP TABLE IF EXISTS dsh_field_annotations;
DROP TABLE IF EXISTS dsh_table_annotations;
DROP TABLE IF EXISTS dsh_question_links;
DROP TABLE IF EXISTS dsh_questions;
DROP TABLE IF EXISTS dsh_source_tables;
DROP TABLE IF EXISTS dsh_source_catalogs;
DROP TABLE IF EXISTS dsh_flow_receipts;
DROP TABLE IF EXISTS dsh_flow_batches;
DROP TABLE IF EXISTS dsh_flow_runs;
DROP TABLE IF EXISTS dsh_legacy_imports;
DROP TABLE IF EXISTS dsh_flow_bindings;
DROP TABLE IF EXISTS dsh_flow_entities;
DROP TABLE IF EXISTS dsh_flow_states;
DROP TABLE IF EXISTS dsh_sources;
DROP TABLE IF EXISTS dsh_management_profiles;
DROP TABLE IF EXISTS dsh_management_migrations;
