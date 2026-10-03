import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db, transaction } from '../../../../../packages/database/src/index'
import type {
  AdminPluginDocsDto,
  AdminPluginDto,
  AdminPluginPackageFile,
  AdminPluginPackageMeta,
  AdminPluginScanFinding,
  AdminPluginInstallResult,
  InstalledPluginStatus,
  JsonObject,
  MediaKind,
  PluginKind,
  PluginPackageFormat,
} from '@musecanvas/contracts'
import {
  PLUGIN_ARTIFACT_MAX_BYTES,
  PLUGIN_PACKAGE_FORMAT,
  decodePluginPackageIcon,
  globalPluginRegistry,
  globalProviderRegistry,
  inspectPluginPackage,
  pluginCredentialSpec,
  pluginIconObjectKey,
  pluginObjectKey,
  pluginPackageObjectKey,
  scanPluginSource,
  validatePluginManifest,
  type AnyProviderManifest,
  type PluginPackageIconMimeType,
  type PluginScanFinding,
} from '../../../../../packages/providers/src/index'
import { type Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { writeAudit } from '../../shared/audit'
import { parseRevisionJsonField } from '../../shared/dto'
import { deleteS3Object, getPrivateS3ObjectBytes, putPrivateS3ObjectBytes } from '../../shared/services'

// Upload surface is opt-in: an artifact is executable code, so the endpoints stay
// dark until the operator sets ALLOW_PLUGIN_UPLOAD=true (env is read directly,
// matching auth/security.ts, because this gate must work before any DB row exists).
export function pluginUploadEnabled(): boolean {
  return process.env.ALLOW_PLUGIN_UPLOAD === 'true'
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const UPLOAD_DISABLED = () => fail('PLUGIN_UPLOAD_DISABLED', '插件上传功能未启用，请联系运维设置 ALLOW_PLUGIN_UPLOAD=true')

/**
 * Non-blocking notice on every legacy `manifest` + `file` upload during the
 * transition to zip packages (plugin-package-spec §6). Response-only: the stored
 * scan report keeps describing the artifact, and `packageFormat: 'mjs'` already
 * records how the row was delivered.
 */
export const LEGACY_UPLOAD_WARNING: PluginScanFinding = {
  rule: 'PLUGIN_UPLOAD_LEGACY_FORMAT',
  severity: 'warn',
  message: '旧上传格式（manifest 字段 + 单个 .mjs）将在过渡期结束后移除，请改为上传包含 manifest.json 的 .zip 插件包',
}

/** Structural instead of `NextRequest` so the DB-free branches are unit-testable. */
export type PluginPackageRequest = { formData(): Promise<FormData> }

type UploadFile = { name: string; arrayBuffer(): Promise<ArrayBuffer> }

const isUploadFile = (value: unknown): value is UploadFile =>
  !!value && typeof value === 'object' &&
  typeof (value as UploadFile).name === 'string' &&
  typeof (value as UploadFile).arrayBuffer === 'function'

/** What a zip package adds on top of the entry bundle: archive, icon, docs. */
export type PluginPackageDetails = {
  packageBytes: Buffer
  packageSha256: string
  packageObjectKey: string
  files: AdminPluginPackageFile[]
  /** Persisted as `package_meta`; only author/license/homepage reach the DTO. */
  storedMeta: Record<string, unknown>
  icon: { bytes: Buffer; sha256: string; objectKey: string; mimeType: PluginPackageIconMimeType } | null
  readme: string | null
  changelog: string | null
  licenseText: string | null
}

export type PluginAnalysis =
  | {
    ok: true
    format: PluginPackageFormat
    manifest: AnyProviderManifest
    findings: PluginScanFinding[]
    warnings: PluginScanFinding[]
    /** The entry bundle: `object_key` / `artifact_sha256` always describe these bytes. */
    bytes: Buffer
    sha256: string
    objectKey: string
    package: PluginPackageDetails | null
  }
  | { ok: false; code: string; findings: PluginScanFinding[] }

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Artifact identity is derived from the exact bytes, so key and digest can never disagree. */
export function pluginArtifactIdentity(pluginId: string, pluginVersion: string, bytes: Buffer): { sha256: string; objectKey: string } {
  const sha256 = sha256Hex(bytes)
  return { sha256, objectKey: pluginObjectKey(pluginId, pluginVersion, sha256) }
}

/**
 * Pure package gate for the legacy upload: scan first, then the manifest. Any
 * error-severity finding aborts before a byte is stored, so a rejected upload
 * leaves no trace in S3 or in `provider_plugins`. Warn-only findings (e.g.
 * NO_DEFAULT_EXPORT) travel with the row.
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
    format: 'mjs',
    manifest,
    findings,
    warnings: findings.filter(finding => finding.severity === 'warn'),
    bytes,
    sha256,
    objectKey,
    package: null,
  }
}

/**
 * Zip package gate (plugin-package-spec §4 steps 1–7): the pure validator in
 * packages/providers does the structure, path, inventory, manifest, scan and
 * header checks; this adds what needs node — the full icon decode (sharp) and
 * the sha256 of every stored object. Nothing is written here.
 */
export async function analyzeZipPluginPackage(zipBytes: Buffer): Promise<PluginAnalysis> {
  const inspection = inspectPluginPackage(zipBytes)
  if (!inspection.ok) return inspection
  const inspected = inspection.package
  const manifest = inspected.manifest

  let icon: PluginPackageDetails['icon'] = null
  if (inspected.icon) {
    const decoded = await decodePluginPackageIcon(inspected.icon.bytes, inspected.icon.mimeType, inspected.icon)
    if (!decoded.ok) {
      return {
        ok: false,
        code: 'PLUGIN_PACKAGE_INVALID',
        findings: [{ rule: 'PLUGIN_PACKAGE_INVALID', severity: 'error', message: decoded.message, path: inspected.icon.path }],
      }
    }
    const iconSha = sha256Hex(inspected.icon.bytes)
    icon = {
      bytes: Buffer.from(inspected.icon.bytes),
      sha256: iconSha,
      objectKey: pluginIconObjectKey(manifest.id, manifest.version, iconSha, inspected.icon.extension),
      mimeType: inspected.icon.mimeType,
    }
  }

  const entryBytes = Buffer.from(inspected.entry.bytes)
  const { sha256, objectKey } = pluginArtifactIdentity(manifest.id, manifest.version, entryBytes)
  const packageSha256 = sha256Hex(zipBytes)
  const storedMeta: Record<string, unknown> = {
    format: PLUGIN_PACKAGE_FORMAT,
    entry: inspected.entry.path,
    ...inspected.meta,
    ...(inspected.readme ? { readme: inspected.readme.path } : {}),
    ...(icon && inspected.icon
      ? {
        icon: {
          path: inspected.icon.path,
          objectKey: icon.objectKey,
          sha256: icon.sha256,
          mimeType: icon.mimeType,
          width: inspected.icon.width,
          height: inspected.icon.height,
        },
      }
      : {}),
  }
  return {
    ok: true,
    format: 'zip-v1',
    manifest,
    findings: inspection.findings,
    warnings: inspection.warnings,
    bytes: entryBytes,
    sha256,
    objectKey,
    package: {
      packageBytes: zipBytes,
      packageSha256,
      packageObjectKey: pluginPackageObjectKey(manifest.id, manifest.version, packageSha256),
      files: inspected.files.map(file => ({ path: file.path, sizeBytes: file.sizeBytes, sha256: sha256Hex(file.bytes) })),
      storedMeta,
      icon,
      readme: inspected.readme?.text ?? null,
      changelog: inspected.changelog?.text ?? null,
      licenseText: inspected.license?.text ?? null,
    },
  }
}

type UploadRead =
  | { ok: true; format: 'mjs'; manifestText: string; sourceText: string; bytes: Buffer }
  | { ok: true; format: 'zip-v1'; bytes: Buffer }
  | { ok: false; response: NextResponse }

/**
 * Two accepted envelopes, never mixed:
 * - `package`: exactly one .zip file and nothing else (plugin-package-spec §6);
 * - legacy: exactly one `manifest` field and one .mjs `file`, nothing else.
 * Extra fields would be an unvalidated second artifact competing with the one
 * that gets hashed.
 */
async function readPluginUpload(request: PluginPackageRequest): Promise<UploadRead> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return failResponse('INVALID_INPUT', '上传必须使用 multipart/form-data 编码')
  }
  const keys = [...form.keys()]
  if (keys.includes('package')) {
    const extraKeys = [...new Set(keys.filter(key => key !== 'package'))]
    if (extraKeys.length > 0) return failResponse('INVALID_INPUT', `package 字段不能与其他字段同时提交：${extraKeys.join(', ')}`)
    const packageFields = form.getAll('package')
    if (packageFields.length !== 1) return failResponse('INVALID_INPUT', '插件包必须且只能有一个 .zip 文件')
    const packageField = packageFields[0]
    if (!isUploadFile(packageField)) return failResponse('INVALID_INPUT', 'package 字段必须是 .zip 文件')
    if (!packageField.name.toLowerCase().endsWith('.zip')) return failResponse('INVALID_INPUT', '插件包必须是单个 .zip 文件')
    const bytes = Buffer.from(await packageField.arrayBuffer())
    if (bytes.byteLength === 0) return failResponse('INVALID_INPUT', '插件包内容为空')
    // The 6 MiB cap is the validator's first step and answers 422 with a finding,
    // like every other package rule, rather than a bare 400 here.
    return { ok: true, format: 'zip-v1', bytes }
  }
  const extraKeys = keys.filter(key => key !== 'manifest' && key !== 'file')
  if (extraKeys.length > 0) return failResponse('INVALID_INPUT', `上传包含不允许的字段：${extraKeys.join(', ')}`)
  // getAll, so a repeated `file` cannot smuggle a second artifact that never gets hashed.
  const manifestFields = form.getAll('manifest')
  const fileFields = form.getAll('file')
  if (manifestFields.length === 0 && fileFields.length === 0) return failResponse('INVALID_INPUT', '缺少 package 字段（.zip 插件包）')
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
  return { ok: true, format: 'mjs', manifestText: manifestField, sourceText: bytes.toString('utf8'), bytes }
}

async function analyzeUpload(upload: Extract<UploadRead, { ok: true }>): Promise<PluginAnalysis> {
  return upload.format === 'zip-v1'
    ? analyzeZipPluginPackage(upload.bytes)
    : analyzePluginPackage(upload.manifestText, upload.sourceText, upload.bytes)
}

/** Warnings shown to the uploader: the artifact's own, plus the legacy-format notice. */
function responseWarnings(analysis: Extract<PluginAnalysis, { ok: true }>): AdminPluginScanFinding[] {
  return toFindings(analysis.format === 'mjs' ? [...analysis.warnings, LEGACY_UPLOAD_WARNING] : analysis.warnings)
}

function failResponse(code: string, message: string, status = 400): { ok: false; response: NextResponse } {
  return { ok: false, response: fail(code, message, status) }
}

/**
 * Every provider_plugins column except the three doc texts (each up to 256 KiB),
 * which the list replaces with presence flags; the texts come from getPluginDocs.
 */
const PLUGIN_LIST_COLUMNS = `id,plugin_id,plugin_version,kind,display_name,description,source,status,object_key,artifact_sha256,artifact_size_bytes,
  manifest,allowed_hosts,credential_schemas,scan_report,error_code,error_message,installed_by,created_at,updated_at,deleted_at,
  package_format,package_object_key,package_sha256,package_files,package_meta,
  readme IS NOT NULL AS has_readme,changelog IS NOT NULL AS has_changelog,license_text IS NOT NULL AS has_license_text`

export async function listAdminPlugins(): Promise<NextResponse> {
  const r = await db().query(
    `SELECT ${PLUGIN_LIST_COLUMNS} FROM provider_plugins WHERE deleted_at IS NULL ORDER BY plugin_id, plugin_version, created_at DESC`,
  )
  return ok(r.rows.map(pluginDtoFromRow))
}

/**
 * GET /api/admin/plugins/:id/docs — README / CHANGELOG / LICENSE text of one
 * plugin, admin-only. Author-supplied: clients render it as text, never HTML.
 * Legacy `mjs` rows have no docs and answer all-null.
 */
export async function getPluginDocs(id: string): Promise<NextResponse> {
  if (!UUID_PATTERN.test(id)) return fail('NOT_FOUND', '插件不存在', 404)
  const current = await db().query(
    'SELECT package_format, readme, changelog, license_text FROM provider_plugins WHERE id=$1 AND deleted_at IS NULL',
    [id],
  )
  const row = current.rows[0]
  if (!row) return fail('NOT_FOUND', '插件不存在', 404)
  return ok(pluginDocsFromRow(row))
}

export function pluginDocsFromRow(row: Record<string, unknown>): AdminPluginDocsDto {
  const isZip = row.package_format === 'zip-v1'
  const text = (value: unknown) => (isZip && typeof value === 'string' ? value : null)
  return { readme: text(row.readme), changelog: text(row.changelog), licenseText: text(row.license_text) }
}

export async function validatePluginPackage(request: PluginPackageRequest): Promise<NextResponse> {
  if (!pluginUploadEnabled()) return UPLOAD_DISABLED()
  const parsed = await readPluginUpload(request)
  if (!parsed.ok) return parsed.response
  const analysis = await analyzeUpload(parsed)
  if (!analysis.ok) return rejected(analysis.code, analysis.findings)
  const manifest = analysis.manifest
  const pkg = analysis.package
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
    packageFormat: analysis.format,
    packageDigest: pkg?.packageSha256 ?? null,
    packageFiles: pkg?.files ?? [],
    packageMeta: pkg ? packageMetaFrom(pkg.storedMeta) : {},
    hasIcon: !!pkg?.icon,
    warnings: responseWarnings(analysis),
  })
}

/** Provider accounts owned by shipped plugins; uploads may never claim them. */
export function builtinCredentialProviders(): Set<string> {
  return new Set(globalPluginRegistry.listManifests().map(manifest => pluginCredentialSpec(manifest).providerId))
}

/** Every object one install writes, entry bundle first. */
function storageWrites(analysis: Extract<PluginAnalysis, { ok: true }>): Array<{ key: string; bytes: Buffer; contentType: string }> {
  const writes = [{ key: analysis.objectKey, bytes: analysis.bytes, contentType: 'text/javascript' }]
  const pkg = analysis.package
  if (pkg) {
    writes.push({ key: pkg.packageObjectKey, bytes: pkg.packageBytes, contentType: 'application/zip' })
    if (pkg.icon) writes.push({ key: pkg.icon.objectKey, bytes: pkg.icon.bytes, contentType: pkg.icon.mimeType })
  }
  return writes
}

type Queryable = { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }

/**
 * I/O seams of an install. Production uses the shared pool and the private
 * bucket; tests pass fakes to assert storage keys and persisted columns without
 * Postgres or S3, the same way apps/worker's loader takes PluginLoaderDeps.
 */
export type PluginInstallDeps = {
  query: Queryable['query']
  transaction: <T>(fn: (client: Queryable) => Promise<T>) => Promise<T>
  putObject: (key: string, bytes: Buffer, contentType: string) => Promise<void>
  deleteObject: (key: string) => Promise<void>
}

const defaultInstallDeps: PluginInstallDeps = {
  query: (sql, params) => db().query(sql, params),
  transaction: fn => transaction(client => fn(client)),
  putObject: (key, bytes, contentType) => putPrivateS3ObjectBytes(key, bytes, contentType),
  deleteObject: key => deleteS3Object(key),
}

async function deleteObjectsBestEffort(keys: string[], deleteObject: PluginInstallDeps['deleteObject'] = deleteS3Object): Promise<void> {
  for (const key of keys) {
    try {
      await deleteObject(key)
    } catch {
      // orphan accepted: an unreachable private-bucket key
    }
  }
}

export async function installPlugin(
  actor: Actor,
  request: PluginPackageRequest,
  deps: PluginInstallDeps = defaultInstallDeps,
): Promise<NextResponse> {
  if (!pluginUploadEnabled()) return UPLOAD_DISABLED()
  const parsed = await readPluginUpload(request)
  if (!parsed.ok) return parsed.response
  const analysis = await analyzeUpload(parsed)
  if (!analysis.ok) return rejected(analysis.code, analysis.findings)
  const manifest = analysis.manifest
  // A key the static registry already owns can never be loaded: registration is
  // first-write-wins, so the row would sit 'failed' forever. Fail fast instead.
  if (globalProviderRegistry.has(manifest.id, manifest.version)) {
    return fail('PLUGIN_ID_RESERVED', `${manifest.id}@${manifest.version} 是内置插件标识，请使用其他插件 id`)
  }
  // Credentials are shared per provider account, so an upload claiming a built-in
  // provider (declared, or derived from an id like 'openai') would be handed that
  // account's secrets. Uploaded plugins bring their own provider namespace.
  const providerId = pluginCredentialSpec(manifest).providerId
  if (builtinCredentialProviders().has(providerId)) {
    return fail('PROVIDER_ID_RESERVED', `凭据供应商 ${providerId} 属于内置插件，请在 manifest.credential.providerId 中使用其他标识`)
  }
  // VERSION IMMUTABILITY: (plugin_id, plugin_version) is write-once, even after a
  // soft delete. Both the worker's registry Map and Node's ESM module cache key on
  // that identity, so a same-key hot-swap could never take effect in an already
  // warmed process — it would silently keep serving the old bytes.
  const duplicate = await deps.query(
    'SELECT id FROM provider_plugins WHERE plugin_id=$1 AND plugin_version=$2 LIMIT 1',
    [manifest.id, manifest.version],
  )
  if (duplicate.rows[0]) return fail('PLUGIN_VERSION_IMMUTABLE', '请升级插件版本号后再上传', 409)
  const writes = storageWrites(analysis)
  const written: string[] = []
  try {
    for (const write of writes) {
      await deps.putObject(write.key, write.bytes, write.contentType)
      written.push(write.key)
    }
  } catch {
    await deleteObjectsBestEffort(written, deps.deleteObject)
    return fail('PLUGIN_ARTIFACT_STORE_FAILED', '插件包写入对象存储失败，请稍后重试', 503)
  }
  const pkg = analysis.package
  let row: Record<string, unknown>
  try {
    row = await deps.transaction(async client => {
      const inserted = await client.query(
        `INSERT INTO provider_plugins(plugin_id,plugin_version,kind,display_name,description,source,status,object_key,artifact_sha256,artifact_size_bytes,manifest,allowed_hosts,credential_schemas,scan_report,installed_by,
           package_format,package_object_key,package_sha256,package_files,package_meta,readme,changelog,license_text)
         VALUES($1,$2,$3,$4,$5,'uploaded','pending',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21) RETURNING *`,
        [
          manifest.id, manifest.version, manifest.kind, manifest.displayName,
          typeof manifest.description === 'string' ? manifest.description : null,
          analysis.objectKey, analysis.sha256, analysis.bytes.byteLength,
          JSON.stringify(manifest), JSON.stringify(manifest.allowedHosts), JSON.stringify(manifest.credentialSchemas),
          JSON.stringify(analysis.findings), actor.id,
          analysis.format, pkg?.packageObjectKey ?? null, pkg?.packageSha256 ?? null,
          JSON.stringify(pkg?.files ?? []), JSON.stringify(pkg?.storedMeta ?? {}),
          pkg?.readme ?? null, pkg?.changelog ?? null, pkg?.licenseText ?? null,
        ],
      )
      if (!inserted.rows[0]) throw new Error('PLUGIN_INSTALL_FAILED')
      // The artifact body is never logged; identity and findings only.
      await writeAudit(client, actor.id, 'plugin.install', 'provider_plugin', inserted.rows[0].id as string, {
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        sha256: analysis.sha256,
        packageFormat: analysis.format,
        ...(pkg ? { packageSha256: pkg.packageSha256 } : {}),
        findings: toFindings(analysis.findings),
      })
      return inserted.rows[0]
    })
  } catch {
    // Chosen failure mode: best-effort compensating delete. If that delete also
    // fails the object is left orphaned — an unreachable private-bucket key is an
    // acceptable cost, whereas a DB row without a verified artifact is not.
    await deleteObjectsBestEffort(written, deps.deleteObject)
    return fail('PLUGIN_INSTALL_FAILED', '插件元数据写入失败，制品已回滚删除', 503)
  }
  const result: AdminPluginInstallResult = {
    installed: true,
    plugin: pluginDtoFromRow(row),
    warnings: responseWarnings(analysis),
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
  // The row is already gone; a lingering object is harmless (unlisted, private bucket).
  await deleteObjectsBestEffort([
    deleted.object_key as string,
    ...(typeof deleted.package_object_key === 'string' ? [deleted.package_object_key] : []),
    ...(iconOf(deleted) ? [(iconOf(deleted) as StoredIcon).objectKey] : []),
  ])
  return ok({
    deleted: true,
    pinnedRevisionsRetainArtifact: true,
    note: '历史 model_config_revisions 仍以内容摘要固定并指向该插件标识，已生成的任务记录不受影响；如需再次使用该插件请重新上传新版本。',
  })
}

/**
 * GET /api/admin/plugins/:id/icon — the package icon, admin-only. Served from the
 * API (never presigned) with nosniff and a sandboxing CSP: only PNG/WebP that
 * passed a full decode is ever stored, and the browser must not reinterpret it.
 */
export async function getPluginIcon(id: string): Promise<NextResponse> {
  if (!UUID_PATTERN.test(id)) return fail('NOT_FOUND', '插件不存在', 404)
  const current = await db().query(
    'SELECT package_format, package_meta FROM provider_plugins WHERE id=$1 AND deleted_at IS NULL',
    [id],
  )
  const row = current.rows[0]
  if (!row) return fail('NOT_FOUND', '插件不存在', 404)
  const icon = row.package_format === 'zip-v1' ? iconOf(row) : null
  if (!icon) return fail('NOT_FOUND', '该插件没有图标', 404)
  let bytes: Buffer
  try {
    bytes = await getPrivateS3ObjectBytes(icon.objectKey)
  } catch {
    return fail('PLUGIN_PACKAGE_UNAVAILABLE', '插件图标暂时无法读取，请稍后重试', 503)
  }
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': icon.mimeType,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
}

/**
 * GET /api/admin/plugins/:id/package — the original zip, admin-only, as an
 * attachment. Re-verified against `package_sha256` so a swapped object is never
 * handed out under the installed plugin's name.
 */
export async function downloadPluginPackage(id: string): Promise<NextResponse> {
  if (!UUID_PATTERN.test(id)) return fail('NOT_FOUND', '插件不存在', 404)
  const current = await db().query(
    'SELECT plugin_id, plugin_version, package_format, package_object_key, package_sha256 FROM provider_plugins WHERE id=$1 AND deleted_at IS NULL',
    [id],
  )
  const row = current.rows[0]
  if (!row) return fail('NOT_FOUND', '插件不存在', 404)
  if (row.package_format !== 'zip-v1' || typeof row.package_object_key !== 'string' || typeof row.package_sha256 !== 'string') {
    return fail('NOT_FOUND', '该插件以旧格式上传，没有可下载的插件包', 404)
  }
  let bytes: Buffer
  try {
    bytes = await getPrivateS3ObjectBytes(row.package_object_key)
  } catch {
    return fail('PLUGIN_PACKAGE_UNAVAILABLE', '插件包暂时无法读取，请稍后重试', 503)
  }
  if (sha256Hex(bytes) !== row.package_sha256) return fail('PLUGIN_PACKAGE_UNAVAILABLE', '插件包校验失败', 503)
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${pluginPackageFilename(String(row.plugin_id), String(row.plugin_version))}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** Plugin id and version patterns already restrict both to [a-z0-9.-]. */
export function pluginPackageFilename(pluginId: string, pluginVersion: string): string {
  return `${pluginId}-${pluginVersion}.zip`.replace(/[^A-Za-z0-9._-]/g, '_')
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
    ...(finding.path !== undefined ? { path: finding.path } : {}),
  }))
}

type StoredIcon = { objectKey: string; mimeType: PluginPackageIconMimeType }

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

function iconOf(row: Record<string, unknown>): StoredIcon | null {
  const icon = jsonRecord(jsonRecord(row.package_meta).icon)
  if (typeof icon.objectKey !== 'string' || !icon.objectKey) return null
  if (icon.mimeType !== 'image/png' && icon.mimeType !== 'image/webp') return null
  return { objectKey: icon.objectKey, mimeType: icon.mimeType }
}

/** Display fields only: the icon's storage key never leaves the server. */
function packageMetaFrom(value: unknown): AdminPluginPackageMeta {
  const meta = jsonRecord(value)
  return {
    ...(typeof meta.author === 'string' ? { author: meta.author } : {}),
    ...(typeof meta.license === 'string' ? { license: meta.license } : {}),
    ...(typeof meta.homepage === 'string' ? { homepage: meta.homepage } : {}),
  }
}

function packageFilesFrom(value: unknown): AdminPluginPackageFile[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value
  if (!Array.isArray(parsed)) return []
  return parsed.reduce<AdminPluginPackageFile[]>((acc, entry) => {
    const file = entry as Partial<AdminPluginPackageFile> | null
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.sha256 !== 'string') return acc
    acc.push({ path: file.path, sizeBytes: Number(file.sizeBytes) || 0, sha256: file.sha256 })
    return acc
  }, [])
}

type DocColumn = 'readme' | 'changelog' | 'license_text'

/**
 * Doc presence from either a full row (`RETURNING *`, text column) or the list
 * query, which selects `has_<column>` booleans so the texts never leave Postgres.
 */
function hasDoc(row: Record<string, unknown>, column: DocColumn): boolean {
  const flag = row[`has_${column}`]
  if (typeof flag === 'boolean') return flag
  return typeof row[column] === 'string'
}

/** `object_key`, `package_object_key` and the icon key are deliberately absent: storage stays server-side. */
export function pluginDtoFromRow(row: Record<string, unknown>): AdminPluginDto {
  const kind = (row.kind as PluginKind) || 'media'
  const manifest = (parseRevisionJsonField(row.manifest) || {}) as JsonObject
  const modalities = kind === 'media' ? (toStringArray(manifest.modalities) as MediaKind[]) : []
  const languageProtocols = kind === 'language' ? toStringArray(manifest.languageProtocols) : []
  const packageFormat: PluginPackageFormat = row.package_format === 'zip-v1' ? 'zip-v1' : 'mjs'
  const isZip = packageFormat === 'zip-v1'
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
    packageFormat,
    packageDigest: isZip && typeof row.package_sha256 === 'string' ? row.package_sha256 : null,
    packageFiles: isZip ? packageFilesFrom(row.package_files) : [],
    packageMeta: isZip ? packageMetaFrom(row.package_meta) : {},
    hasIcon: isZip && iconOf(row) !== null,
    docs: {
      readme: isZip && hasDoc(row, 'readme'),
      changelog: isZip && hasDoc(row, 'changelog'),
      licenseText: isZip && hasDoc(row, 'license_text'),
    },
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
      ...(typeof finding.path === 'string' ? { path: finding.path } : {}),
    })
    return acc
  }, [])
}

const isoString = (value: unknown): string => new Date(value as string | number | Date).toISOString()
