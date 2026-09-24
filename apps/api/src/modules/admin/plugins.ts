import { createHash } from 'node:crypto'
import type { NextResponse } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import type {
  AdminPluginDto,
  AdminPluginScanFinding,
  AdminPluginInstallResult,
  InstalledPluginStatus,
  JsonObject,
  MediaKind,
  PluginKind,
} from '@musecanvas/contracts'
import {
  PLUGIN_ARTIFACT_MAX_BYTES,
  globalProviderRegistry,
  pluginObjectKey,
  scanPluginSource,
  validatePluginManifest,
  type AnyProviderManifest,
  type PluginScanFinding,
} from '../../../../../packages/providers/src/index'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { writeAudit } from '../../shared/audit'
import { parseRevisionJsonField } from '../../shared/dto'
import { deleteS3Object, putPrivateS3ObjectBytes } from '../../shared/services'

// Upload surface is opt-in: an artifact is executable code, so the endpoints stay
// dark until the operator sets ALLOW_PLUGIN_UPLOAD=true (env is read directly,
// matching auth/security.ts, because this gate must work before any DB row exists).
export function pluginUploadEnabled(): boolean {
  return process.env.ALLOW_PLUGIN_UPLOAD === 'true'
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const UPLOAD_DISABLED = () => fail('PLUGIN_UPLOAD_DISABLED', '插件上传功能未启用，请联系运维设置 ALLOW_PLUGIN_UPLOAD=true')

/** Structural instead of `NextRequest` so the DB-free branches are unit-testable. */
export type PluginPackageRequest = { formData(): Promise<FormData> }

type UploadFile = { name: string; arrayBuffer(): Promise<ArrayBuffer> }

const isUploadFile = (value: unknown): value is UploadFile =>
  !!value && typeof value === 'object' &&
  typeof (value as UploadFile).name === 'string' &&
  typeof (value as UploadFile).arrayBuffer === 'function'

export type PluginAnalysis =
  | {
    ok: true
    manifest: AnyProviderManifest
    findings: PluginScanFinding[]
    warnings: PluginScanFinding[]
    bytes: Buffer
    sha256: string
    objectKey: string
  }
  | { ok: false; code: string; findings: PluginScanFinding[] }

/** Artifact identity is derived from the exact bytes, so key and digest can never disagree. */
export function pluginArtifactIdentity(pluginId: string, pluginVersion: string, bytes: Buffer): { sha256: string; objectKey: string } {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { sha256, objectKey: pluginObjectKey(pluginId, pluginVersion, sha256) }
}

/**
 * Pure package gate: scan first, then the manifest. Any error-severity finding
 * aborts before a byte is stored, so a rejected upload leaves no trace in S3 or in
 * `provider_plugins`. Warn-only findings (e.g. NO_DEFAULT_EXPORT) travel with the row.
 */
export function analyzePluginPackage(manifestText: string, sourceText: string, bytes: Buffer): PluginAnalysis {
  let manifestInput: unknown
  try {
    manifestInput = JSON.parse(manifestText)
  } catch {
    return { ok: false, code: 'INVALID_PLUGIN_MANIFEST', findings: [{ rule: 'INVALID_PLUGIN_ID', severity: 'error', message: 'manifest 字段不是合法 JSON' }] }
  }
  const scanFindings = scanPluginSource(sourceText)
  const validated = validatePluginManifest(manifestInput)
  const findings = validated.ok ? scanFindings : [...scanFindings, ...validated.findings]
  if (findings.some(finding => finding.severity === 'error')) {
    return { ok: false, code: 'PLUGIN_SCAN_FAILED', findings }
  }
  if (!validated.ok) return { ok: false, code: 'PLUGIN_SCAN_FAILED', findings }
  const manifest = validated.manifest
  const { sha256, objectKey } = pluginArtifactIdentity(manifest.id, manifest.version, bytes)
  return {
    ok: true,
    manifest,
    findings,
    warnings: findings.filter(finding => finding.severity === 'warn'),
    bytes,
    sha256,
    objectKey,
  }
}

type PackageRead =
  | { ok: true; manifestText: string; sourceText: string; bytes: Buffer }
  | { ok: false; response: NextResponse }

// Exactly one manifest field and one .mjs file, nothing else: extra fields would be
// an unvalidated second artifact competing with the one that gets hashed.
async function readPluginPackage(request: PluginPackageRequest): Promise<PackageRead> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return failResponse('INVALID_INPUT', '上传必须使用 multipart/form-data 编码')
  }
  const extraKeys = [...form.keys()].filter(key => key !== 'manifest' && key !== 'file')
  if (extraKeys.length > 0) return failResponse('INVALID_INPUT', `上传包含不允许的字段：${extraKeys.join(', ')}`)
  // getAll, so a repeated `file` cannot smuggle a second artifact that never gets hashed.
  const manifestFields = form.getAll('manifest')
  const fileFields = form.getAll('file')
  if (manifestFields.length !== 1) return failResponse('INVALID_INPUT', 'manifest 字段必须且只能有一个')
  if (fileFields.length !== 1) return failResponse('INVALID_INPUT', '插件包必须且只能有一个文件')
  const manifestField = manifestFields[0]
  if (typeof manifestField !== 'string' || !manifestField.trim()) {
    return failResponse('INVALID_INPUT', '缺少 manifest 字段（插件清单 JSON 文本）')
  }
  const fileField = fileFields[0]
  if (!isUploadFile(fileField)) return failResponse('INVALID_INPUT', 'file 字段必须是插件包文件')
  if (!fileField.name.endsWith('.mjs')) return failResponse('INVALID_INPUT', '插件包必须是单个 .mjs 文件')
  const bytes = Buffer.from(await fileField.arrayBuffer())
  if (bytes.byteLength === 0) return failResponse('INVALID_INPUT', '插件包内容为空')
  // Size cap is enforced on the decoded length before any hashing or scanning work.
  if (bytes.byteLength > PLUGIN_ARTIFACT_MAX_BYTES) {
    return failResponse('PLUGIN_ARTIFACT_TOO_LARGE', `插件包不能超过 ${PLUGIN_ARTIFACT_MAX_BYTES} 字节`)
  }
  return { ok: true, manifestText: manifestField, sourceText: bytes.toString('utf8'), bytes }
}

function failResponse(code: string, message: string, status = 400): { ok: false; response: NextResponse } {
  return { ok: false, response: fail(code, message, status) }
}

export async function listAdminPlugins(): Promise<NextResponse> {
  const r = await db().query(
    `SELECT * FROM provider_plugins WHERE deleted_at IS NULL ORDER BY plugin_id, plugin_version, created_at DESC`,
  )
  return ok(r.rows.map(pluginDtoFromRow))
}

export async function validatePluginPackage(request: PluginPackageRequest): Promise<NextResponse> {
  if (!pluginUploadEnabled()) return UPLOAD_DISABLED()
  const parsed = await readPluginPackage(request)
  if (!parsed.ok) return parsed.response
  const analysis = analyzePluginPackage(parsed.manifestText, parsed.sourceText, parsed.bytes)
  if (!analysis.ok) return rejected(analysis.code, analysis.findings)
  const manifest = analysis.manifest
  return ok({
    ok: true,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    kind: manifest.kind,
    displayName: manifest.displayName,
    modelIds: (manifest.models || []).map(model => model.id),
    allowedHosts: manifest.allowedHosts,
    artifactDigest: analysis.sha256,
    artifactSizeBytes: analysis.bytes.byteLength,
    warnings: toFindings(analysis.warnings),
  })
}

export async function installPlugin(actor: Actor, request: PluginPackageRequest): Promise<NextResponse> {
  if (!pluginUploadEnabled()) return UPLOAD_DISABLED()
  const parsed = await readPluginPackage(request)
  if (!parsed.ok) return parsed.response
  const analysis = analyzePluginPackage(parsed.manifestText, parsed.sourceText, parsed.bytes)
  if (!analysis.ok) return rejected(analysis.code, analysis.findings)
  const manifest = analysis.manifest
  // A key the static registry already owns can never be loaded: registration is
  // first-write-wins, so the row would sit 'failed' forever. Fail fast instead.
  if (globalProviderRegistry.has(manifest.id, manifest.version)) {
    return fail('PLUGIN_ID_RESERVED', `${manifest.id}@${manifest.version} 是内置插件标识，请使用其他插件 id`)
  }
  // VERSION IMMUTABILITY: (plugin_id, plugin_version) is write-once, even after a
  // soft delete. Both the worker's registry Map and Node's ESM module cache key on
  // that identity, so a same-key hot-swap could never take effect in an already
  // warmed process — it would silently keep serving the old bytes.
  const duplicate = await db().query(
    'SELECT id FROM provider_plugins WHERE plugin_id=$1 AND plugin_version=$2 LIMIT 1',
    [manifest.id, manifest.version],
  )
  if (duplicate.rows[0]) return fail('PLUGIN_VERSION_IMMUTABLE', '请升级插件版本号后再上传', 409)
  try {
    await putPrivateS3ObjectBytes(analysis.objectKey, analysis.bytes, 'text/javascript')
  } catch {
    return fail('PLUGIN_ARTIFACT_STORE_FAILED', '插件包写入对象存储失败，请稍后重试', 503)
  }
  let row: Record<string, unknown>
  try {
    row = await transaction(async client => {
      const inserted = await client.query(
        `INSERT INTO provider_plugins(plugin_id,plugin_version,kind,display_name,description,source,status,object_key,artifact_sha256,artifact_size_bytes,manifest,allowed_hosts,credential_schemas,scan_report,installed_by)
         VALUES($1,$2,$3,$4,$5,'uploaded','pending',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13) RETURNING *`,
        [
          manifest.id, manifest.version, manifest.kind, manifest.displayName,
          typeof manifest.description === 'string' ? manifest.description : null,
          analysis.objectKey, analysis.sha256, analysis.bytes.byteLength,
          JSON.stringify(manifest), JSON.stringify(manifest.allowedHosts), JSON.stringify(manifest.credentialSchemas),
          JSON.stringify(analysis.findings), actor.id,
        ],
      )
      if (!inserted.rows[0]) throw new Error('PLUGIN_INSTALL_FAILED')
      // The artifact body is never logged; identity and findings only.
      await writeAudit(client, actor.id, 'plugin.install', 'provider_plugin', inserted.rows[0].id as string, {
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        sha256: analysis.sha256,
        findings: toFindings(analysis.findings),
      })
      return inserted.rows[0]
    })
  } catch {
    // Chosen failure mode: best-effort compensating delete. If that delete also
    // fails the object is left orphaned — an unreachable private-bucket key is an
    // acceptable cost, whereas a DB row without a verified artifact is not.
    try {
      await deleteS3Object(analysis.objectKey)
    } catch {
      // orphan accepted
    }
    return fail('PLUGIN_INSTALL_FAILED', '插件元数据写入失败，制品已回滚删除', 503)
  }
  const result: AdminPluginInstallResult = {
    installed: true,
    plugin: pluginDtoFromRow(row),
    warnings: toFindings(analysis.warnings),
  }
  return ok(result, { status: 201 })
}

export async function updatePluginStatus(actor: Actor, id: string, input: Record<string, unknown>): Promise<NextResponse> {
  const status = input.status
  if (status !== 'active' && status !== 'disabled') return fail('INVALID_INPUT', '只能切换插件的启用或停用状态')
  if (!UUID_PATTERN.test(id)) return fail('NOT_FOUND', '插件不存在', 404)
  const current = await db().query('SELECT * FROM provider_plugins WHERE id=$1 AND deleted_at IS NULL', [id])
  const row = current.rows[0]
  if (!row) return fail('NOT_FOUND', '插件不存在', 404)
  // 'failed' is terminal: the loader rejected those bytes, so re-enabling requires a
  // re-upload under a new version (see the version-immutability rule).
  if (row.status === 'failed') return fail('PLUGIN_FAILED_IMMUTABLE', '加载失败的插件不能重新启用，请以新版本重新上传', 409)
  // 'pending' belongs to the worker: until it has imported the artifact there is
  // nothing to enable, and flipping the row early would fake an activation.
  if (row.status === 'pending') return fail('PLUGIN_NOT_LOADED', '插件尚未由 Worker 加载完成，暂时不能调整状态', 409)
  if (row.status === status) return ok(pluginDtoFromRow(row))
  const updated = await transaction(async client => {
    const r = await client.query(
      "UPDATE provider_plugins SET status=$2, updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND status IN('active','disabled') RETURNING *",
      [id, status],
    )
    if (!r.rows[0]) return null
    await writeAudit(client, actor.id, 'plugin.status', 'provider_plugin', id, {
      pluginId: r.rows[0].plugin_id,
      pluginVersion: r.rows[0].plugin_version,
      sha256: r.rows[0].artifact_sha256,
      status,
    })
    return r.rows[0]
  })
  if (!updated) return fail('PLUGIN_NOT_LOADED', '插件尚未由 Worker 加载完成，暂时不能调整状态', 409)
  return ok(pluginDtoFromRow(updated))
}

export async function deletePlugin(actor: Actor, id: string): Promise<NextResponse> {
  if (!UUID_PATTERN.test(id)) return fail('NOT_FOUND', '插件不存在', 404)
  const current = await db().query('SELECT * FROM provider_plugins WHERE id=$1 AND deleted_at IS NULL', [id])
  const row = current.rows[0]
  if (!row) return fail('NOT_FOUND', '插件不存在', 404)
  const inUse = await db().query(
    'SELECT id FROM model_configs WHERE plugin_id=$1 AND plugin_version=$2 AND deleted_at IS NULL LIMIT 1',
    [row.plugin_id, row.plugin_version],
  )
  if (inUse.rows[0]) return fail('PLUGIN_IN_USE', '该插件版本仍被模型配置引用，请先调整模型后再删除', 409)
  const deleted = await transaction(async client => {
    const r = await client.query(
      "UPDATE provider_plugins SET deleted_at=now(), status='disabled', updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *",
      [id],
    )
    if (!r.rows[0]) return null
    await writeAudit(client, actor.id, 'plugin.delete', 'provider_plugin', id, {
      pluginId: r.rows[0].plugin_id,
      pluginVersion: r.rows[0].plugin_version,
      sha256: r.rows[0].artifact_sha256,
      findings: [],
    })
    return r.rows[0]
  })
  if (!deleted) return fail('NOT_FOUND', '插件不存在', 404)
  try {
    await deleteS3Object(deleted.object_key as string)
  } catch {
    // The row is already gone; a lingering object is harmless (unlisted, private bucket).
  }
  return ok({
    deleted: true,
    pinnedRevisionsRetainArtifact: true,
    note: '历史 model_config_revisions 仍以内容摘要固定并指向该插件标识，已生成的任务记录不受影响；如需再次使用该插件请重新上传新版本。',
  })
}

/** Scan/validation rejection carries the findings verbatim — the UI renders them, it never guesses. */
function rejected(code: string, findings: PluginScanFinding[]): NextResponse {
  return ok({ installed: false, ok: false, code, findings: toFindings(findings) }, { status: 422 })
}

function toStringArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  return Array.isArray(parsed) ? parsed.map(String) : []
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toFindings(findings: PluginScanFinding[]): AdminPluginScanFinding[] {
  return findings.map(finding => ({
    rule: finding.rule,
    severity: finding.severity,
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.column !== undefined ? { column: finding.column } : {}),
    message: finding.message,
  }))
}

/** `object_key` is deliberately absent: the artifact is worker-only. */
function pluginDtoFromRow(row: Record<string, unknown>): AdminPluginDto {
  const kind = (row.kind as PluginKind) || 'media'
  const manifest = (parseRevisionJsonField(row.manifest) || {}) as JsonObject
  const modalities = kind === 'media' ? (toStringArray(manifest.modalities) as MediaKind[]) : []
  const languageProtocols = kind === 'language' ? toStringArray(manifest.languageProtocols) : []
  return {
    id: row.id as string,
    pluginId: row.plugin_id as string,
    pluginVersion: row.plugin_version as string,
    kind,
    displayName: row.display_name as string,
    description: (row.description as string) ?? null,
    status: (row.status as InstalledPluginStatus) || 'pending',
    source: (row.source as 'builtin' | 'uploaded') || 'uploaded',
    allowedHosts: toStringArray(row.allowed_hosts),
    credentialSchemas: toStringArray(row.credential_schemas),
    modalities,
    languageProtocols,
    manifest,
    artifactDigest: row.artifact_sha256 as string,
    artifactSizeBytes: Number(row.artifact_size_bytes || 0),
    scanReport: findingsFromRow(row.scan_report),
    errorCode: (row.error_code as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  }
}

function findingsFromRow(value: unknown): AdminPluginScanFinding[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  if (!Array.isArray(parsed)) return []
  return parsed.reduce<AdminPluginScanFinding[]>((acc, entry) => {
    const finding = entry as Partial<AdminPluginScanFinding> | null
    if (!finding || typeof finding !== 'object' || typeof finding.rule !== 'string' || typeof finding.message !== 'string') return acc
    acc.push({
      rule: finding.rule,
      severity: finding.severity === 'warn' ? 'warn' : 'error',
      ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
      ...(typeof finding.column === 'number' ? { column: finding.column } : {}),
      message: finding.message,
    })
    return acc
  }, [])
}

const isoString = (value: unknown): string => new Date(value as string | number | Date).toISOString()
