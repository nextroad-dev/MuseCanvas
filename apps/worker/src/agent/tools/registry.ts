import { isUuid, type JsonObject, type ToolExecutionResult } from '@musecanvas/contracts'
import type { LanguageModelChatTool } from '@musecanvas/providers'
import type { AgentSqlClient, AgentTool, AgentToolBudgetPolicy, AgentToolContext, AgentToolRegistry } from '../ports'

if (typeof window !== 'undefined') throw new Error('Agent tools are server-only')

export const MAX_TOOL_INPUT_BYTES = 65_536
export const MAX_TOOL_OUTPUT_BYTES = 32_768
const MAX_DEPTH = 12
const MAX_VALUES = 4096
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
/** PostgreSQL text/jsonb cannot represent NUL or unpaired UTF-16 surrogates. */
function isSafeStorageString(value: string): boolean {
  return !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}
const builtinNames = new Set(['list_models', 'search_assets', 'get_asset'])
const mediaNames = new Set(['generate_image', 'generate_video', 'edit_image'])

export interface ToolQuery {
  query<Row extends Record<string, unknown>>(text: string, values: unknown[], decodeRow: (row: Record<string, unknown>) => Row): Promise<{ rows: Row[] }>
}
/** Keep the caller's fenced SQL client; each query supplies its own row decoder. */
export function adaptAgentToolContext(context: AgentToolContext): ToolContext {
  return { ownerId: context.scope.ownerId, signal: context.signal, query: checkedToolQuery(context.sql) }
}
function checkedToolQuery(sql: AgentSqlClient): ToolQuery {
  return { async query(text, values, decodeRow) {
    const result = await sql.query(text, values)
    return { rows: result.rows.map(row => {
      if (!plain(row)) throw new Error('Invalid tool query row')
      return decodeRow(row)
    }) }
  } }
}
export interface ToolContext {
  /** Server-authenticated owner, never copied from model arguments. */
  ownerId: string
  query: ToolQuery
  signal?: AbortSignal
}

/** Supported JSON Schema subset. Objects are closed; strings and arrays are bounded.
 * No refs, unions, coercion, defaults, regexes or implicit additional properties. */
export interface ToolSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, ToolSchema>
  required?: string[]
  additionalProperties?: false
  items?: ToolSchema
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  format?: 'uuid'
  minimum?: number
  maximum?: number
  enum?: (string | number | boolean | null)[]
}
export interface AgentToolDefinition {
  name: string
  schemaVersion: number
  description: string
  parameters: ToolSchema
  permissions: string[]
  execution: 'sync' | 'media_async'
}
export interface InstalledTool<Context extends ToolContext = ToolContext> extends AgentToolDefinition {
  execute(context: Context, args: JsonObject): Promise<ToolExecutionResult>
}
export interface ValidatedToolCall {
  toolName: string
  schemaVersion: number
  arguments: JsonObject
}
export class ToolValidationError extends Error {
  constructor(readonly code: 'INVALID_SCHEMA' | 'INVALID_ARGUMENTS' | 'UNKNOWN_TOOL' | 'TOOL_NOT_ALLOWED' | 'INVALID_REGISTRATION' | 'RESULT_TOO_LARGE') {
    super(code)
    this.name = 'ToolValidationError'
  }
}
function reject(code: ToolValidationError['code']): never { throw new ToolValidationError(code) }

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
/** Inspect descriptors before reading values: accessors/prototype tricks must never run. */
function inspectJson(value: unknown, code: 'INVALID_SCHEMA' | 'INVALID_ARGUMENTS', maxBytes: number): void {
  let count = 0
  function visit(value: unknown, depth: number): void {
    if (++count > MAX_VALUES || depth > MAX_DEPTH) reject(code)
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'string') { if (!isSafeStorageString(value)) reject(code); return }
    if (typeof value === 'number') { if (!Number.isFinite(value)) reject(code); return }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_VALUES
        || Reflect.ownKeys(value).length !== value.length + 1) reject(code)
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject(code)
        visit(descriptor.value, depth + 1)
      }
      // All own keys are now accounted for by the indexed data and length.
      return
    }
    if (!plain(value)) reject(code)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !isSafeStorageString(key) || forbiddenKeys.has(key)) reject(code)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor) || !descriptor.enumerable) reject(code)
      visit(descriptor.value, depth + 1)
    }
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) reject(code)
}

export function validateToolSchema(input: unknown): asserts input is ToolSchema {
  inspectJson(input, 'INVALID_SCHEMA', MAX_TOOL_INPUT_BYTES)
  function check(value: unknown, depth: number): void {
    if (!plain(value) || depth > MAX_DEPTH) reject('INVALID_SCHEMA')
    const common = ['type', 'enum']
    const allowed: Record<string, string[]> = {
      object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'],
      string: ['minLength', 'maxLength', 'format'], number: ['minimum', 'maximum'], integer: ['minimum', 'maximum'], boolean: [], null: [],
    }
    if (typeof value.type !== 'string' || !Object.hasOwn(allowed, value.type)) reject('INVALID_SCHEMA')
    if (Object.keys(value).some(key => ![...common, ...allowed[value.type as string]].includes(key))) reject('INVALID_SCHEMA')
    const bound = (key: string, max: number, required = false) => {
      const number = value[key]
      if (number === undefined && !required) return
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > max) reject('INVALID_SCHEMA')
    }
    if (value.type === 'object') {
      if (!plain(value.properties) || value.additionalProperties !== false || !Array.isArray(value.required)) reject('INVALID_SCHEMA')
      if (new Set(value.required).size !== value.required.length || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties as object, key))) reject('INVALID_SCHEMA')
      for (const schema of Object.values(value.properties)) check(schema, depth + 1)
    } else if (value.type === 'array') {
      bound('minItems', MAX_VALUES); bound('maxItems', MAX_VALUES, true)
      if ((value.minItems as number ?? 0) > (value.maxItems as number)) reject('INVALID_SCHEMA')
      check(value.items, depth + 1)
    } else if (value.type === 'string') {
      bound('minLength', 16_000); bound('maxLength', 16_000, true)
      if ((value.minLength as number ?? 0) > (value.maxLength as number) || (value.format !== undefined && value.format !== 'uuid')) reject('INVALID_SCHEMA')
    } else if (value.type === 'number' || value.type === 'integer') {
      for (const key of ['minimum', 'maximum']) {
        if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value.type === 'integer' && !Number.isSafeInteger(value[key])))) reject('INVALID_SCHEMA')
      }
      if (value.minimum !== undefined && value.maximum !== undefined && (value.minimum as number) > (value.maximum as number)) reject('INVALID_SCHEMA')
    }
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 100 || new Set(value.enum).size !== value.enum.length || value.type === 'object' || value.type === 'array') reject('INVALID_SCHEMA')
      for (const item of value.enum) validateValue(item, { ...value, enum: undefined } as unknown as ToolSchema, 'INVALID_SCHEMA')
    }
  }
  check(input, 0)
}
function validateValue(value: unknown, schema: ToolSchema, code: 'INVALID_SCHEMA' | 'INVALID_ARGUMENTS'): void {
  switch (schema.type) {
    case 'object':
      if (!plain(value)) reject(code)
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties!, key)) reject(code)
        validateValue(value[key], schema.properties![key], code)
      }
      if (schema.required!.some(key => !Object.hasOwn(value, key))) reject(code)
      break
    case 'array':
      if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > schema.maxItems!) reject(code)
      for (const item of value) validateValue(item, schema.items!, code)
      break
    case 'string': {
      if (typeof value !== 'string') reject(code)
      const length = Array.from(value).length
      if (length < (schema.minLength ?? 0) || length > schema.maxLength! || (schema.format === 'uuid' && !isUuid(value))) reject(code)
      break
    }
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) reject(code)
      break
    case 'boolean': if (typeof value !== 'boolean') reject(code); break
    case 'null': if (value !== null) reject(code); break
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null)) reject(code)
}
export function validateToolArguments(schema: ToolSchema, input: unknown): asserts input is JsonObject {
  validateToolSchema(schema)
  if (schema.type !== 'object') reject('INVALID_SCHEMA')
  inspectJson(input, 'INVALID_ARGUMENTS', MAX_TOOL_INPUT_BYTES)
  validateValue(input, schema, 'INVALID_ARGUMENTS')
}

function validName(name: string, version: number): void {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(name) || name.includes('__v') || !Number.isSafeInteger(version) || version < 1 || version > 999_999) reject('INVALID_REGISTRATION')
}
export function toolVersionKey(name: string, schemaVersion: number): string {
  validName(name, schemaVersion)
  return `${name}@v${schemaVersion}`
}
export function toModelToolName(name: string, schemaVersion: number): string {
  validName(name, schemaVersion)
  return `${name}__v${schemaVersion}`
}
export function fromModelToolName(name: string): { name: string; schemaVersion: number } {
  const match = /^([a-z][a-z0-9_]{0,39})__v([1-9][0-9]{0,5})$/.exec(name)
  if (!match) reject('UNKNOWN_TOOL')
  validName(match[1], Number(match[2]))
  return { name: match[1], schemaVersion: Number(match[2]) }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
export function toolSchemaToJson(schema: ToolSchema): JsonObject {
  const result: JsonObject = { type: schema.type }
  if (schema.properties !== undefined) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toolSchemaToJson(value)]))
  if (schema.required !== undefined) result.required = [...schema.required]
  if (schema.additionalProperties !== undefined) result.additionalProperties = schema.additionalProperties
  if (schema.items !== undefined) result.items = toolSchemaToJson(schema.items)
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum'] as const) {
    if (schema[key] !== undefined) result[key] = schema[key]
  }
  if (schema.format !== undefined) result.format = schema.format
  if (schema.enum !== undefined) result.enum = [...schema.enum]
  return result
}
function definitionCopy(tool: AgentToolDefinition): AgentToolDefinition {
  return structuredClone({ name: tool.name, schemaVersion: tool.schemaVersion, description: tool.description,
    parameters: tool.parameters, permissions: tool.permissions, execution: tool.execution })
}
export function completedOutputBytes(result: JsonObject): number {
  return Buffer.byteLength(JSON.stringify({ kind: 'completed', result }), 'utf8')
}

/** Install only server-authored handlers. The media port accepts the three known
 * media operations; approval/budget enforcement remains the caller's responsibility. */
export class ToolRegistry<Context extends ToolContext = ToolContext> {
  readonly #tools = new Map<string, InstalledTool<Context>>()
  readonly #allowed: Set<string>
  constructor(options: { tools: InstalledTool<Context>[]; allowlist: readonly string[]; mediaTools?: InstalledTool<Context>[] }) {
    for (const [tools, media] of [[options.tools, false], [options.mediaTools ?? [], true]] as const) {
      for (const tool of tools) {
        const key = toolVersionKey(tool.name, tool.schemaVersion)
        if (this.#tools.has(key) || (media ? !mediaNames.has(tool.name) || tool.execution !== 'media_async' : !builtinNames.has(tool.name) || tool.schemaVersion !== 1 || tool.execution !== 'sync')) reject('INVALID_REGISTRATION')
        validateToolSchema(tool.parameters)
        if (tool.parameters.type !== 'object' || typeof tool.execute !== 'function' || !tool.description || !Array.isArray(tool.permissions) || tool.permissions.length === 0 || tool.permissions.some(permission => typeof permission !== 'string' || !/^[a-z_]+:[a-z_]+$/.test(permission))) reject('INVALID_REGISTRATION')
        const definition = definitionCopy(tool)
        this.#tools.set(key, Object.freeze({ ...definition, parameters: freeze(definition.parameters), permissions: freeze(definition.permissions), execute: tool.execute }))
      }
    }
    this.#allowed = new Set(options.allowlist)
    if (this.#allowed.size !== options.allowlist.length) reject('INVALID_REGISTRATION')
    for (const key of this.#allowed) if (!this.#tools.has(key)) reject('UNKNOWN_TOOL')
  }
  listDefinitions(): AgentToolDefinition[] {
    return [...this.#tools].filter(([key]) => this.#allowed.has(key)).map(([, tool]) => definitionCopy(tool))
  }
  listModelTools(): LanguageModelChatTool[] {
    return this.listDefinitions().map(tool => ({ name: toModelToolName(tool.name, tool.schemaVersion), description: tool.description, parameters: toolSchemaToJson(tool.parameters) }))
  }
  definition(name: string, schemaVersion: number): AgentToolDefinition {
    return definitionCopy(this.lookup(name, schemaVersion))
  }
  private lookup(name: string, schemaVersion: number): InstalledTool<Context> {
    const key = toolVersionKey(name, schemaVersion)
    const tool = this.#tools.get(key)
    if (!tool) reject('UNKNOWN_TOOL')
    if (!this.#allowed.has(key)) reject('TOOL_NOT_ALLOWED')
    return tool
  }
  validate(name: string, schemaVersion: number, input: unknown): ValidatedToolCall {
    validateToolArguments(this.lookup(name, schemaVersion).parameters, input)
    return { toolName: name, schemaVersion, arguments: structuredClone(input) }
  }
  validateModelCall(name: string, input: unknown): ValidatedToolCall {
    const parsed = fromModelToolName(name)
    return this.validate(parsed.name, parsed.schemaVersion, input)
  }
  async dispatch(context: Context, call: ValidatedToolCall): Promise<ToolExecutionResult> {
    // Revalidate persisted/backend calls too; a structural TS type is not authorization.
    const validated = this.validate(call.toolName, call.schemaVersion, call.arguments)
    if (!isUuid(context.ownerId)) reject('INVALID_ARGUMENTS')
    if (context.signal?.aborted) return { kind: 'failed', error: { code: 'TOOL_FAILED', message: 'Tool execution interrupted', retryable: false } }
    const tool = this.lookup(validated.toolName, validated.schemaVersion)
    try {
      const result = await tool.execute(context, validated.arguments)
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_TOOL_OUTPUT_BYTES) reject('RESULT_TOO_LARGE')
      return result
    } catch (error) {
      if (tool.execution === 'media_async' || error instanceof ToolValidationError) throw error
      // Read-only query diagnostics may contain credentials, SQL or infrastructure URLs.
      // Media errors must escape so the caller rolls back all fenced effects.
      return { kind: 'failed', error: { code: 'TOOL_FAILED', message: 'Tool execution failed', retryable: false } }
    }
  }
}

interface AgentBridgeContext extends ToolContext { readonly agent: AgentToolContext }
export interface VersionedAgentToolRegistry extends AgentToolRegistry {
  listModelTools(): LanguageModelChatTool[]
  validate(name: string, schemaVersion: number, input: unknown): ValidatedToolCall
  validateModelCall(name: string, input: unknown): ValidatedToolCall
  dispatch(context: AgentToolContext, call: ValidatedToolCall): Promise<ToolExecutionResult>
}
export interface CreateAgentToolRegistryOptions {
  readonly tools: readonly AgentTool[]
  readonly allowlist: readonly string[]
}
function budgetCopy(budget: AgentToolBudgetPolicy): AgentToolBudgetPolicy {
  if (!Number.isSafeInteger(budget.maxMediaJobs) || budget.maxMediaJobs < 0
    || !Number.isSafeInteger(budget.maxMediaOutputs) || budget.maxMediaOutputs < 0) reject('INVALID_REGISTRATION')
  return freeze(structuredClone({ maxMediaJobs: budget.maxMediaJobs, maxMediaOutputs: budget.maxMediaOutputs, maxEstimatedCost: budget.maxEstimatedCost }))
}

/** Shared-port adapter. Required approval remains visible to the Runner/M5 gate;
 * AgentToolContext carries no approval decision, so this adapter cannot grant one. */
export function createAgentToolRegistry(options: CreateAgentToolRegistryOptions): VersionedAgentToolRegistry {
  const tools: InstalledTool<AgentBridgeContext>[] = []
  const mediaTools: InstalledTool<AgentBridgeContext>[] = []
  const policies = new Map<string, { approval: AgentTool['approval']; budget: AgentToolBudgetPolicy }>()
  for (const source of options.tools) {
    if ((source.execution === 'media_async' && source.approval !== 'required')
      || !['never', 'required'].includes(source.approval)) reject('INVALID_REGISTRATION')
    const schema = source.parameters
    validateToolSchema(schema)
    const parameters = structuredClone(schema)
    if (source.execution !== 'sync' && source.execution !== 'media_async') reject('INVALID_REGISTRATION')
    const execute = source.execute.bind(source)
    const installed: InstalledTool<AgentBridgeContext> = { name: source.name, schemaVersion: source.schemaVersion,
      description: source.description, parameters, permissions: [...source.permissions], execution: source.execution,
      execute: (context, args) => execute(context.agent, args) }
    policies.set(toolVersionKey(source.name, source.schemaVersion), { approval: source.approval, budget: budgetCopy(source.budget) })
    if (source.execution === 'media_async') mediaTools.push(installed)
    else tools.push(installed)
  }
  const registry = new ToolRegistry({ tools, mediaTools, allowlist: options.allowlist })
  const dispatch = (context: AgentToolContext, call: ValidatedToolCall) => registry.dispatch({ ...adaptAgentToolContext(context), agent: context }, call)
  const exposed: readonly AgentTool[] = Object.freeze(registry.listDefinitions().map(definition => {
    const policy = policies.get(toolVersionKey(definition.name, definition.schemaVersion))!
    return Object.freeze({ name: definition.name, schemaVersion: definition.schemaVersion, description: definition.description,
      parameters: freeze(toolSchemaToJson(definition.parameters)), permissions: freeze([...definition.permissions]),
      execution: definition.execution, approval: policy.approval, budget: policy.budget,
      execute: (context: AgentToolContext, args: JsonObject) => dispatch(context, { toolName: definition.name, schemaVersion: definition.schemaVersion, arguments: args }) })
  }))
  const byVersion = new Map(exposed.map(tool => [toolVersionKey(tool.name, tool.schemaVersion), tool]))
  return Object.freeze({
    get: (name: string, schemaVersion: number) => byVersion.get(`${name}@v${schemaVersion}`) ?? null,
    list: () => exposed,
    listModelTools: () => registry.listModelTools(),
    validate: (name: string, schemaVersion: number, input: unknown) => registry.validate(name, schemaVersion, input),
    validateModelCall: (name: string, input: unknown) => registry.validateModelCall(name, input),
    dispatch,
  })
}
