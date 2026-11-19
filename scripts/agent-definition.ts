/**
 * Provisions one `agent_definitions` row for the Agent Core API.
 *
 * Why this exists: a session is only admitted against an existing
 * `agent_definitions` row (apps/api/src/modules/agent/service.ts and
 * AgentCoreRepository.createSession), and the repository deliberately seeds
 * none (docs/agent-core-remaining-plan.md, decision P4). Without this CLI an
 * operator has to hand-craft SQL against an immutable table whose model policy
 * must be frozen to an exact model revision.
 *
 * Run from the repository root with DATABASE_URL already exported; like every
 * other maintenance script this one never loads .env. It needs no
 * APP_MASTER_KEY (it writes no secret) and never prints DATABASE_URL or any
 * credential:
 *
 *   pnpm --filter @musecanvas/database exec tsx ../../scripts/agent-definition.ts \
 *     --owner <user-uuid> --name 'Creation assistant' --instructions @./instructions.md \
 *     --model-config <model-config-uuid>
 *   # review the printed definition and SQL, then re-run the same command with --apply
 *
 * Flags:
 *   --owner <uuid>                  required; users row must exist, be active and not deleted
 *   --name <string>                 required; 1..80 characters; owner+name is the version key
 *   --instructions <value>          required; `@path` reads a UTF-8 file, anything else is inline
 *   --model-config <uuid>           required; language model config with a supported builtin protocol
 *   --tools <name@vN,...>           default list_models@v1,search_assets@v1,get_asset@v1,
 *                                   generate_image@v1,generate_video@v1,edit_image@v1
 *   --max-model-calls <n>           default 12     (1..1000)
 *   --max-tool-calls <n>            default 24     (0..1000)
 *   --max-media-jobs <n>            default 8      (0..1000)
 *   --max-media-outputs <n>         default 16     (0..1000)
 *   --max-input-tokens <n>          default 200000 (0..2^63-1)
 *   --max-output-tokens <n>         default 16000  (0..2^63-1)
 *   --max-concurrent-media-jobs <n> default 2      (0..1000)
 *   --max-estimated-cost <amount>@<CURRENCY>@<pricingReference>
 *                                   default: no monetary ceiling (null). Example:
 *                                   5.00@USD@catalog-2026-11
 *   --timeout-ms <n>                default 120000 (1..300000)
 *   --new-version                   allow a new row when owner+name already exists
 *   --apply                         write the row; without it the CLI is a dry run
 *   --help                          print this summary and exit 0 without connecting
 *
 * Behaviour:
 *   - Default is a dry run. All checks still run, the resolved definition and
 *     the INSERT (statement plus parameter list) are printed, nothing is written.
 *   - The owner, model config and existing-version checks and the INSERT share
 *     one transaction; any failure exits non-zero with no partial write.
 *   - The frozen `modelPolicy` is `{modelConfigId, modelRevisionId}` taken from
 *     the model config's `latest_revision_id`, and `budgetPolicy` carries the
 *     contract's quotas plus `timeoutMs` (never `deadlineAt`: a Turn freezes its
 *     own DB-clock deadline).
 *   - Re-running identical flags is idempotent: an identical active definition
 *     is reported and left untouched. Different content — or a retired latest
 *     version — fails unless `--new-version` is passed, which writes version
 *     N+1. Versions are immutable except retirement (migration 0041), so this
 *     CLI only ever inserts; it never updates or retires.
 *   - No definition is auto-provisioned: this script is the only supported path.
 *
 * Bounds mirror the admission path, not just the DDL, because the API
 * re-validates a definition on every new session and turn: instructions above
 * 16000 bytes (the limit in `validateAgentDefinition`) and tool entries outside
 * `^[a-z][a-z0-9_.-]{0,99}@v[1-9][0-9]{0,3}$` would produce a row no session
 * could ever use. Budget ranges come from `definitionBudget` in
 * apps/api/src/modules/agent/validation.ts; the CLI defaults above are
 * conservative operator choices, not values the API enforces.
 *
 * Exit codes: 0 success or idempotent no-op, 1 validation/database failure,
 * 2 usage error. `pnpm --filter ... exec` collapses any non-zero child exit to
 * 1, so run the script through a package's `tsx` directly when the distinction
 * matters.
 */
import { readFileSync } from 'node:fs'
import { db, transaction } from '../packages/database/src/index'
import { isBuiltinLanguagePluginKey } from '../packages/providers/src/index'
import type { AgentDecimal, AgentDefinitionBudgetPolicy, AgentEstimatedCost } from '../packages/contracts/src/agent/index'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Documented `name@vN` form for the definition's tool allowlist. */
const TOOL_ENTRY_PATTERN = /^[a-z][a-z0-9_]{0,39}@v[1-9][0-9]{0,5}$/
/** The API's own predicate; an entry outside it can never be admitted to a session. */
const API_TOOL_ENTRY_PATTERN = /^[a-z][a-z0-9_.-]{0,99}@v[1-9][0-9]{0,3}$/
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,18})$/
const COST_AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/
const COST_CURRENCY_PATTERN = /^[A-Z]{3}$/
const PRICING_REFERENCE_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
const MAX_INT64 = 9223372036854775807n
/** Admission cap enforced by `storageString(definition.instructions, 16000)`. */
const MAX_INSTRUCTIONS_BYTES = 16000
const MAX_TOOLS = 32
const DEFAULT_TOOLS = [
  'list_models@v1', 'search_assets@v1', 'get_asset@v1',
  'generate_image@v1', 'generate_video@v1', 'edit_image@v1',
].join(',')

const VALUE_FLAGS: Record<string, string | undefined> = {
  '--owner': 'owner',
  '--name': 'name',
  '--instructions': 'instructions',
  '--model-config': 'modelConfigId',
  '--tools': 'tools',
  '--max-model-calls': 'maxModelCalls',
  '--max-tool-calls': 'maxToolCalls',
  '--max-media-jobs': 'maxMediaJobs',
  '--max-media-outputs': 'maxMediaOutputs',
  '--max-input-tokens': 'maxInputTokens',
  '--max-output-tokens': 'maxOutputTokens',
  '--max-estimated-cost': 'maxEstimatedCost',
  '--max-concurrent-media-jobs': 'maxConcurrentMediaJobs',
  '--timeout-ms': 'timeoutMs',
}

const MODEL_SQL = `SELECT m.id,m.model_kind,m.language_protocol,m.plugin_id,m.plugin_version,m.plugin_source,
    m.vendor_model_id,m.enabled,m.deleted_at,m.latest_revision_id,
    r.id AS revision_id,r.revision AS revision_number,r.plugin_id AS revision_plugin_id,
    r.plugin_version AS revision_plugin_version,r.vendor_model_id AS revision_vendor_model_id
  FROM model_configs m
  LEFT JOIN model_config_revisions r ON r.id=m.latest_revision_id AND r.model_id=m.id
  WHERE m.id=$1
  FOR SHARE OF m`

const LATEST_DEFINITION_SQL = `SELECT id,version,model_policy,instructions,tool_allowlist,budget_policy,status
  FROM agent_definitions WHERE owner_id=$1 AND name=$2 ORDER BY version DESC LIMIT 1`

const INSERT_SQL = `INSERT INTO agent_definitions(owner_id,name,version,model_policy,instructions,tool_allowlist,budget_policy)
  VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb)
  RETURNING id,version`

const USAGE = `agent-definition: provision one agent_definitions row (dry run by default).

  pnpm --filter @musecanvas/database exec tsx ../../scripts/agent-definition.ts \\
    --owner <uuid> --name <string> --instructions <@file|text> --model-config <uuid> [flags]

Required:  --owner, --name, --instructions, --model-config
Optional:  --tools <name@vN,...>
           --max-model-calls --max-tool-calls --max-media-jobs --max-media-outputs
           --max-input-tokens --max-output-tokens --max-concurrent-media-jobs
           --max-estimated-cost <amount>@<CURRENCY>@<pricingReference> --timeout-ms
           --new-version  (write version N+1 when owner+name already exists)
           --apply        (write; otherwise nothing is written)
           --help

Environment: DATABASE_URL. No .env loading, no application key, no credential output.`

class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

class UsageError extends CliError {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

interface Options {
  owner: string
  name: string
  instructions: string
  modelConfigId: string
  tools: string[]
  budget: AgentDefinitionBudgetPolicy
  apply: boolean
  newVersion: boolean
}

interface ModelRow {
  model_kind: string
  language_protocol: string | null
  plugin_id: string | null
  plugin_version: string | null
  plugin_source: string
  vendor_model_id: string | null
  enabled: boolean
  deleted_at: Date | string | null
  latest_revision_id: string | null
  revision_id: string | null
  revision_number: number | null
  revision_plugin_id: string | null
  revision_plugin_version: string | null
  revision_vendor_model_id: string | null
}

interface ResolvedModel {
  revisionId: string
  revision: number
  protocol: 'openai_chat' | 'anthropic_messages'
  plugin: string
}

interface DefinitionRow {
  id: string
  version: number
  model_policy: unknown
  instructions: unknown
  tool_allowlist: unknown
  budget_policy: unknown
  status: string
}

type TxClient = Parameters<Parameters<typeof transaction>[0]>[0]

let pool: ReturnType<typeof db> | undefined

function requiredValue(values: Record<string, string>, key: string, flag: string): string {
  const value = values[key]
  if (value === undefined) throw new UsageError(`${flag} is required`)
  return value
}

function uuidValue(values: Record<string, string>, key: string, flag: string): string {
  const value = requiredValue(values, key, flag)
  if (!UUID_PATTERN.test(value)) throw new UsageError(`${flag} must be a UUID`)
  return value.toLowerCase()
}

function integerValue(values: Record<string, string>, key: string, flag: string, fallback: number, min: number, max: number): number {
  const raw = values[key]
  if (raw === undefined) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new UsageError(`${flag} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new UsageError(`${flag} must be between ${min} and ${max}`)
  return value
}

function decimalValue(values: Record<string, string>, key: string, flag: string, fallback: AgentDecimal): AgentDecimal {
  const raw = values[key]
  if (raw === undefined) return fallback
  if (!DECIMAL_PATTERN.test(raw)) throw new UsageError(`${flag} must be a non-negative integer without leading zeros`)
  if (BigInt(raw) > MAX_INT64) throw new UsageError(`${flag} must not exceed ${MAX_INT64}`)
  return raw as AgentDecimal
}

function estimatedCost(raw: string): AgentEstimatedCost {
  const parts = raw.split('@')
  if (parts.length !== 3) throw new UsageError('--max-estimated-cost expects <amount>@<CURRENCY>@<pricingReference>, e.g. 5.00@USD@catalog-2026-11')
  const [amount, currency, pricingReference] = parts as [string, string, string]
  if (!COST_AMOUNT_PATTERN.test(amount)) throw new UsageError('--max-estimated-cost amount must be a non-negative decimal with at most 9 fraction digits')
  if (!COST_CURRENCY_PATTERN.test(currency)) throw new UsageError('--max-estimated-cost currency must be a three-letter uppercase code, e.g. USD')
  if (!PRICING_REFERENCE_PATTERN.test(pricingReference)) throw new UsageError('--max-estimated-cost pricing reference must match ^[A-Za-z0-9:_-]{1,128}$')
  return { amount, currency, pricingReference }
}

function instructionsText(raw: string): string {
  const text = raw.startsWith('@') ? readInstructionsFile(raw.slice(1)) : raw
  if (!text.length) throw new UsageError('--instructions must not be empty')
  if (text.includes('\0')) throw new UsageError('--instructions must not contain NUL')
  if (LONE_SURROGATE_PATTERN.test(text)) throw new UsageError('--instructions must be valid UTF-8 (unpaired surrogate found)')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_INSTRUCTIONS_BYTES) {
    throw new UsageError(`--instructions are ${bytes} bytes; the API admits at most ${MAX_INSTRUCTIONS_BYTES} (longer text makes the definition unusable)`)
  }
  return text
}

function readInstructionsFile(path: string): string {
  if (!path) throw new UsageError('--instructions @ needs a file path')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new CliError(`cannot read --instructions file ${path}`)
  }
}

function definitionName(raw: string): string {
  if (raw.includes('\0')) throw new UsageError('--name must not contain NUL')
  const length = [...raw].length
  if (length < 1 || length > 80) throw new UsageError('--name must be 1..80 characters')
  return raw
}

function toolAllowlist(raw: string): string[] {
  const entries = raw.split(',')
  if (entries.length > MAX_TOOLS) throw new UsageError(`--tools accepts at most ${MAX_TOOLS} entries`)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!TOOL_ENTRY_PATTERN.test(entry)) throw new UsageError(`--tools entry "${entry}" must match name@vN (^[a-z][a-z0-9_]{0,39}@v[1-9][0-9]{0,5}$)`)
    if (!API_TOOL_ENTRY_PATTERN.test(entry)) throw new UsageError(`--tools entry "${entry}" has a version the API validator rejects; versions are v1..v9999`)
    if (seen.has(entry)) throw new UsageError(`--tools entry "${entry}" is listed twice`)
    seen.add(entry)
  }
  return entries
}

function parseArgs(argv: string[]): { help: true } | { help: false; options: Options } {
  if (argv.some(argument => argument === '--help' || argument === '-h')) return { help: true }
  const values: Record<string, string> = {}
  let apply = false
  let newVersion = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') {
      if (apply) throw new UsageError('--apply was given twice')
      apply = true
      continue
    }
    if (token === '--new-version') {
      if (newVersion) throw new UsageError('--new-version was given twice')
      newVersion = true
      continue
    }
    const key = VALUE_FLAGS[token]
    if (key === undefined) throw new UsageError(token.startsWith('--') ? `${token} is not a known flag` : `unexpected argument ${token}`)
    if (values[key] !== undefined) throw new UsageError(`${token} was given twice`)
    const value = argv[index + 1]
    if (value === undefined) throw new UsageError(`${token} needs a value`)
    values[key] = value
    index += 1
  }
  const options: Options = {
    owner: uuidValue(values, 'owner', '--owner'),
    name: definitionName(requiredValue(values, 'name', '--name')),
    instructions: instructionsText(requiredValue(values, 'instructions', '--instructions')),
    modelConfigId: uuidValue(values, 'modelConfigId', '--model-config'),
    tools: toolAllowlist(values.tools ?? DEFAULT_TOOLS),
    budget: {
      maxModelCalls: integerValue(values, 'maxModelCalls', '--max-model-calls', 12, 1, 1000),
      maxToolCalls: integerValue(values, 'maxToolCalls', '--max-tool-calls', 24, 0, 1000),
      maxMediaJobs: integerValue(values, 'maxMediaJobs', '--max-media-jobs', 8, 0, 1000),
      maxMediaOutputs: integerValue(values, 'maxMediaOutputs', '--max-media-outputs', 16, 0, 1000),
      maxInputTokens: decimalValue(values, 'maxInputTokens', '--max-input-tokens', '200000'),
      maxOutputTokens: decimalValue(values, 'maxOutputTokens', '--max-output-tokens', '16000'),
      maxEstimatedCost: values.maxEstimatedCost === undefined ? null : estimatedCost(values.maxEstimatedCost),
      maxConcurrentMediaJobs: integerValue(values, 'maxConcurrentMediaJobs', '--max-concurrent-media-jobs', 2, 0, 1000),
      timeoutMs: integerValue(values, 'timeoutMs', '--timeout-ms', 120000, 1, 300000),
    },
    apply,
    newVersion,
  }
  return { help: false, options }
}

/** Mirrors the identity/plugin checks `validateAgentDefinition` applies at admission. */
function resolveModel(row: ModelRow | undefined, modelConfigId: string): ResolvedModel {
  if (!row) throw new CliError(`model config ${modelConfigId} does not exist`)
  if (!row.enabled) throw new CliError(`model config ${modelConfigId} is disabled`)
  if (row.deleted_at !== null) throw new CliError(`model config ${modelConfigId} is deleted`)
  if (row.model_kind !== 'language') throw new CliError(`model config ${modelConfigId} is not a language model`)
  if (!row.latest_revision_id || !row.revision_id) throw new CliError(`model config ${modelConfigId} has no latest revision`)
  if (row.language_protocol !== 'openai_chat' && row.language_protocol !== 'anthropic_messages') {
    throw new CliError(`model config ${modelConfigId} uses unsupported protocol ${row.language_protocol ?? 'none'}; expected openai_chat or anthropic_messages`)
  }
  if (row.plugin_source !== 'builtin') throw new CliError(`model config ${modelConfigId} uses a non-builtin plugin (${row.plugin_source})`)
  if (!isBuiltinLanguagePluginKey(row.plugin_id, row.plugin_version)) {
    throw new CliError(`model config ${modelConfigId} uses unsupported language plugin ${row.plugin_id ?? 'none'}@${row.plugin_version ?? 'none'}`)
  }
  const expectedPlugin = row.language_protocol === 'openai_chat' ? 'openai-language' : 'anthropic-language'
  if (row.plugin_id !== expectedPlugin) {
    throw new CliError(`model config ${modelConfigId} declares ${row.language_protocol} with plugin ${row.plugin_id}; expected ${expectedPlugin}`)
  }
  if (row.plugin_id !== row.revision_plugin_id || row.plugin_version !== row.revision_plugin_version
    || row.vendor_model_id !== row.revision_vendor_model_id) {
    throw new CliError(`model config ${modelConfigId} latest revision does not match the model identity; re-save the model config before provisioning`)
  }
  if (typeof row.revision_number !== 'number') throw new CliError(`model config ${modelConfigId} latest revision has no revision number`)
  return { revisionId: row.revision_id, revision: row.revision_number, protocol: row.language_protocol, plugin: `${row.plugin_id}@${row.plugin_version}` }
}

/** Key-order independent comparison: stored jsonb does not preserve key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameDefinition(row: DefinitionRow, options: Options, modelPolicy: { modelConfigId: string; modelRevisionId: string }): boolean {
  return canonical({ modelPolicy: row.model_policy, instructions: row.instructions, toolAllowlist: row.tool_allowlist, budgetPolicy: row.budget_policy })
    === canonical({ modelPolicy, instructions: options.instructions, toolAllowlist: options.tools, budgetPolicy: options.budget })
}

function printPlan(version: number, options: Options, model: ResolvedModel, modelPolicy: object): void {
  console.log(`agent-definition${options.apply ? '' : ' (dry run)'}`)
  console.log(`  owner:         ${options.owner}`)
  console.log(`  name:          ${options.name}`)
  console.log(`  version:       ${version}`)
  console.log(`  modelConfig:   ${options.modelConfigId}`)
  console.log(`  modelPolicy:   ${JSON.stringify(modelPolicy)}`)
  console.log(`  modelRevision: revision ${model.revision} (${model.protocol}, ${model.plugin})`)
  console.log(`  tools:         ${options.tools.join(', ')}`)
  console.log(`  budgetPolicy:  ${JSON.stringify(options.budget)}`)
  console.log(`  instructions:  ${Buffer.byteLength(options.instructions, 'utf8')} bytes`)
  if (options.apply) return
  console.log('  instructions text:')
  console.log(options.instructions)
  console.log(`  sql: ${INSERT_SQL}`)
  console.log('  parameters (owner,name,version,modelPolicy,instructions,tools,budgetPolicy):')
  console.log(JSON.stringify([options.owner, options.name, version, modelPolicy, options.instructions, options.tools, options.budget], null, 2))
}

async function provision(options: Options): Promise<number> {
  return transaction(async (client: TxClient) => {
    // Two concurrent applies for the same owner+name must not pick the same next
    // version; the lock is released with this transaction.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent_definitions:${options.owner}:${options.name}`])
    const owner = await client.query(`SELECT id FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR KEY SHARE`, [options.owner])
    if (!owner.rows[0]) throw new CliError(`owner ${options.owner} is missing, disabled, or deleted`)

    const model = await client.query(MODEL_SQL, [options.modelConfigId])
    const resolved = resolveModel(model.rows[0] as ModelRow | undefined, options.modelConfigId)
    const modelPolicy = { modelConfigId: options.modelConfigId, modelRevisionId: resolved.revisionId }

    const latest = (await client.query(LATEST_DEFINITION_SQL, [options.owner, options.name])).rows[0] as DefinitionRow | undefined
    const version = latest ? latest.version + 1 : 1
    if (latest) {
      if (latest.status === 'active' && sameDefinition(latest, options, modelPolicy)) {
        console.log(`agent-definition: ${latest.id} version ${latest.version} already matches; nothing changed`)
        return 0
      }
      if (!options.newVersion) {
        const reason = latest.status === 'active' ? 'different content' : 'status retired'
        throw new CliError(`definition "${options.name}" already exists at version ${latest.version} (${latest.id}) with ${reason}; pass --new-version to write version ${version} (versions are immutable), or choose another --name`)
      }
    }

    printPlan(version, options, resolved, modelPolicy)
    if (!options.apply) return 0

    const inserted = await client.query(INSERT_SQL, [
      options.owner, options.name, version, JSON.stringify(modelPolicy),
      options.instructions, JSON.stringify(options.tools), JSON.stringify(options.budget),
    ])
    const created = inserted.rows[0] as { id: string; version: number }
    console.log(`agent-definition: created ${created.id} version ${created.version} for owner ${options.owner}`)
    return 0
  })
}

/**
 * Never echo driver messages: a PostgreSQL connection error can carry host,
 * database and user details. Our own messages and SQLSTATE/errno codes are safe.
 */
function describe(error: unknown): string {
  if (error instanceof CliError) return error.message
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && /^[0-9A-Z_]{5,32}$/.test(code)) return `database error ${code}`
  return `unexpected failure (${error instanceof Error ? error.name : typeof error})`
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    console.log(USAGE)
    return 0
  }
  if (!process.env.DATABASE_URL) throw new CliError('DATABASE_URL is not set; this script reads it from the environment and never loads .env')
  pool = db()
  return provision(parsed.options)
}

main()
  .catch((error: unknown) => {
    console.error(`agent-definition: ${describe(error)}`)
    return error instanceof UsageError ? 2 : 1
  })
  .then(async (exitCode) => {
    if (pool) await pool.end()
    process.exit(exitCode)
  })
