CREATE INDEX CONCURRENTLY IF NOT EXISTS model_config_revisions_model_idx
ON model_config_revisions (model_id, revision DESC);
