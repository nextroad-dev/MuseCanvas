-- Default media models. Incremental and rerunnable; never touches other columns.
-- Requires model_configs.model_kind IN ('image','video','language') (0012).
-- Run in the migration runner's transaction.
ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- Hygiene first: a soft-deleted row is never a default, so clear stale flags
-- before the partial unique index is built. Convergent on replay.
UPDATE model_configs SET is_default = false WHERE is_default AND deleted_at IS NOT NULL;

-- Dirty-data repair: more than one live default per media kind. Keep the
-- earliest (sort_order, created_at, id) and clear the rest, so the partial
-- unique index below can build. Convergent on replay.
UPDATE model_configs m SET is_default = false
WHERE m.is_default AND m.deleted_at IS NULL AND m.model_kind IN ('image','video')
  AND EXISTS (
    SELECT 1 FROM model_configs other
    WHERE other.is_default AND other.deleted_at IS NULL AND other.model_kind = m.model_kind AND other.id <> m.id
      AND (other.sort_order, other.created_at, other.id) < (m.sort_order, m.created_at, m.id)
  );

-- Backfill: a media kind with no live default elects the earliest enabled,
-- non-deleted row. A kind with no enabled row keeps no default (video may be
-- null). The NOT EXISTS guard makes this a no-op on replay.
UPDATE model_configs m SET is_default = true
WHERE m.deleted_at IS NULL AND m.model_kind = 'image' AND m.enabled
  AND NOT EXISTS (
    SELECT 1 FROM model_configs d
    WHERE d.is_default AND d.deleted_at IS NULL AND d.model_kind = 'image'
  )
  AND m.id = (
    SELECT o.id FROM model_configs o
    WHERE o.deleted_at IS NULL AND o.model_kind = 'image' AND o.enabled
    ORDER BY o.sort_order, o.created_at, o.id LIMIT 1
  );
UPDATE model_configs m SET is_default = true
WHERE m.deleted_at IS NULL AND m.model_kind = 'video' AND m.enabled
  AND NOT EXISTS (
    SELECT 1 FROM model_configs d
    WHERE d.is_default AND d.deleted_at IS NULL AND d.model_kind = 'video'
  )
  AND m.id = (
    SELECT o.id FROM model_configs o
    WHERE o.deleted_at IS NULL AND o.model_kind = 'video' AND o.enabled
    ORDER BY o.sort_order, o.created_at, o.id LIMIT 1
  );

-- At most one live default per media kind. Language rows are outside the
-- predicate, so a language model can never hold or contest a default.
CREATE UNIQUE INDEX IF NOT EXISTS model_configs_single_default_per_kind_idx
  ON model_configs (model_kind)
  WHERE is_default AND deleted_at IS NULL AND model_kind IN ('image','video');
