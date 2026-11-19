import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('historical CanvasAgent migration stays replayable after runtime retirement', () => {
  const sql = readFileSync(new URL('../../migrations/0031_canvas_agent.sql', import.meta.url), 'utf8')
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 6)
  assert.ok(sql.includes('ON CONFLICT DO NOTHING'))
  assert.equal((sql.match(/EXCEPTION WHEN duplicate_object THEN NULL/g) ?? []).length, 2)
  for (const clause of [
    'UNIQUE(session_id, message_id)', 'UNIQUE(session_id, seq)', 'PRIMARY KEY(session_id, job_id)',
    'UNIQUE(canvas_id, tool_call_id)', 'FOREIGN KEY(session_id, canvas_id, created_by)',
    'immutable canvas agent pending snapshot', 'immutable canvas agent turn',
    'lease_expires_at <= started_at + timeout_ms', "CHECK((status = 'submitted') = (job_id IS NOT NULL))",
    "model_config_digest text NOT NULL CHECK(model_config_digest ~ '^[0-9a-f]{64}$')",
    'enabled boolean NOT NULL DEFAULT false', 'max_tool_calls_per_turn integer NOT NULL DEFAULT 12',
    'max_jobs_per_turn integer NOT NULL DEFAULT 4', 'timeout_ms integer NOT NULL DEFAULT 120000',
    'max_auto_continuations integer NOT NULL DEFAULT 3', 'require_confirmation boolean NOT NULL DEFAULT true',
    'BETWEEN 1 AND 32', 'BETWEEN 1 AND 8', 'BETWEEN 1000 AND 300000', 'BETWEEN 0 AND 10',
  ]) assert.ok(sql.includes(clause), clause)
})
