-- @migrate transaction=false
-- Parent-filtered latest-revision reads use UNIQUE(model_id,revision) backwards.
-- Keep that constraint index; remove only the redundant non-unique ordering index.
DROP INDEX CONCURRENTLY IF EXISTS model_config_revisions_model_idx;
