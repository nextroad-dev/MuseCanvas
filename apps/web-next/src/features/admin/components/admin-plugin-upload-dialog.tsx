'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import type {
  AdminPluginScanFinding,
  AdminPluginUploadResponse,
  AdminPluginValidateSuccess,
  PluginKind,
} from '@/shared/types'
import { PLUGIN_ARTIFACT_MAX_BYTES, humanFileSize, postPluginPackage, shortDigest } from '../lib/plugin-upload'
import { Loader2, ShieldAlert, Upload, X } from 'lucide-react'

/**
 * Manifest prefills. Field names follow `validatePluginManifest` in
 * packages/providers/src/core/plugin-scan.ts (id ^[a-z][a-z0-9-]{1,40}$, version
 * semver x.y.z, non-empty allowedHosts / credentialSchemas / models, and per-kind
 * modalities / languageProtocols). The server validates; this is only a starting draft.
 */
const MANIFEST_TEMPLATES: Record<PluginKind, string> = {
  media: JSON.stringify(
    {
      kind: 'media',
      id: 'my-media-plugin',
      version: '1.0.0',
      displayName: '示例媒体插件',
      description: '请替换为真实插件清单',
      modalities: ['image'],
      allowedHosts: ['api.example.com'],
      credentialSchemas: ['legacy-api-key-v1'],
      models: [{ id: 'example-model', name: '示例模型', modalities: ['image'] }],
    },
    null,
    2,
  ),
  language: JSON.stringify(
    {
      kind: 'language',
      id: 'my-language-plugin',
      version: '1.0.0',
      displayName: '示例语言插件',
      description: '请替换为真实插件清单',
      languageProtocols: ['openai_chat'],
      allowedHosts: ['api.example.com'],
      credentialSchemas: ['legacy-api-key-v1'],
      models: [{ id: 'example-model', name: '示例模型' }],
    },
    null,
    2,
  ),
}

/** Worker reloads the catalog on a 5s maintenance tick; debounce typing bursts well below that. */
const VALIDATE_DEBOUNCE_MS = 400

type ValidatePhase = 'idle' | 'checking' | 'ready' | 'rejected' | 'error'

interface ValidateState {
  phase: ValidatePhase
  findings: AdminPluginScanFinding[]
  summary: AdminPluginValidateSuccess | null
  message: string
}

const IDLE: ValidateState = { phase: 'idle', findings: [], summary: null, message: '' }

interface AdminPluginUploadDialogProps {
  open: boolean
  onClose: () => void
  /** Which kernel the uploaded package targets; seeds the manifest prefill. */
  kind: PluginKind
  /** Called after a successful install so the parent can announce the `待加载` handshake. */
  onInstalled?: (plugin: { pluginId: string; pluginVersion: string }) => void
}

function FindingList({ findings }: { findings: AdminPluginScanFinding[] }) {
  if (findings.length === 0) return null
  return (
    <ul className="space-y-1">
      {findings.map((f, i) => (
        <li
          key={`${f.rule}-${f.line ?? 'x'}-${i}`}
          className={`rounded border px-2 py-1.5 text-[11px] ${
            f.severity === 'error' ? 'border-danger-soft bg-danger-soft/20 text-danger' : 'border-border bg-surface-subtle text-muted-foreground'
          }`}
        >
          {/* 严重级别以文字呈现，不依赖颜色区分 */}
          <span className="font-semibold">{f.severity === 'error' ? '错误' : '警告'}</span>
          <span className="ml-1 font-mono">{f.rule}</span>
          {typeof f.line === 'number' && <span className="ml-1 font-mono">第 {f.line} 行</span>}
          <span className="ml-1">{f.message}</span>
        </li>
      ))}
    </ul>
  )
}

export function AdminPluginUploadDialog({ open, onClose, kind, onInstalled }: AdminPluginUploadDialogProps) {
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [manifestText, setManifestText] = useState(MANIFEST_TEMPLATES[kind])
  const [validate, setValidate] = useState<ValidateState>(IDLE)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const resetFields = () => {
    setFile(null)
    setManifestText(MANIFEST_TEMPLATES[kind])
    setValidate(IDLE)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const close = () => {
    resetFields()
    onClose()
  }

  // Pre-flight: whenever a file and a manifest are present, re-run POST admin/plugins/validate
  // (scan-only, writes nothing) so the admin sees findings before installing. Stale responses
  // are dropped via the AbortController owned by this effect run.
  useEffect(() => {
    if (!open) return
    if (!file || !manifestText.trim()) {
      setValidate(IDLE)
      return
    }
    if (!file.name.endsWith('.mjs')) {
      setValidate({ ...IDLE, phase: 'error', message: '插件包必须是单个 .mjs 文件（服务端同样强制）' })
      return
    }
    if (file.size > PLUGIN_ARTIFACT_MAX_BYTES) {
      setValidate({
        ...IDLE,
        phase: 'error',
        message: `插件包不能超过 ${PLUGIN_ARTIFACT_MAX_BYTES} 字节（5 MB，上限由服务端强制）`,
      })
      return
    }
    const controller = new AbortController()
    setValidate({ ...IDLE, phase: 'checking' })
    const timer = setTimeout(async () => {
      const res = await postPluginPackage<AdminPluginValidateSuccess | { ok: false; installed: false; code: string; findings: AdminPluginScanFinding[] }>(
        API_ENDPOINTS.admin.pluginValidate,
        manifestText,
        file,
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (!res.success) {
        setValidate({ ...IDLE, phase: 'error', message: `${res.error?.code ?? 'ERROR'}：${res.error?.message ?? '校验请求失败'}` })
        return
      }
      const data = res.data
      if (data && data.ok === true) {
        setValidate({ phase: 'ready', findings: data.warnings, summary: data, message: '' })
      } else if (data) {
        // HTTP 422 arrives with a success:true envelope (server `rejected()` wraps `ok()`),
        // so findings live on res.data, not res.error.
        setValidate({ phase: 'rejected', findings: data.findings, summary: null, message: `服务端拒绝：${data.code}` })
      } else {
        setValidate({ ...IDLE, phase: 'error', message: '校验响应缺少数据' })
      }
    }, VALIDATE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, file, manifestText])

  const installMutation = useMutation({
    mutationFn: async (artifact: { file: File; manifest: string }) =>
      postPluginPackage<AdminPluginUploadResponse>(API_ENDPOINTS.admin.pluginUpload, artifact.manifest, artifact.file),
    onSuccess: (res) => {
      if (!res.success) {
        // fail() envelope: PLUGIN_UPLOAD_DISABLED / PLUGIN_VERSION_IMMUTABLE /
        // PLUGIN_ID_RESERVED / INVALID_INPUT / PLUGIN_ARTIFACT_TOO_LARGE / NETWORK_ERROR…
        setValidate({ ...IDLE, phase: 'error', message: `${res.error?.code ?? 'ERROR'}：${res.error?.message ?? '上传请求失败'}` })
        return
      }
      const data = res.data
      if (data && data.installed === true) {
        // The row was created with status='pending'; it goes live only after the
        // worker pulls, verifies and re-scans the artifact on its maintenance tick.
        queryClient.invalidateQueries({ queryKey: ['admin', 'plugins'] })
        onInstalled?.({ pluginId: data.plugin.pluginId, pluginVersion: data.plugin.pluginVersion })
        close()
        return
      }
      if (data) {
        setValidate({ phase: 'rejected', findings: data.findings, summary: null, message: `服务端拒绝：${data.code}` })
      } else {
        setValidate({ ...IDLE, phase: 'error', message: '上传响应缺少数据' })
      }
    },
    onError: (err: Error) => {
      setValidate({ ...IDLE, phase: 'error', message: err.message || '上传请求失败' })
    },
  })

  if (!open) return null

  const blockingFindings = validate.findings.some((f) => f.severity === 'error')
  const canSubmit =
    !!file &&
    !!manifestText.trim() &&
    (validate.phase === 'ready' || validate.phase === 'rejected') &&
    !blockingFindings &&
    !installMutation.isPending

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={close} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-upload-dialog-title"
        className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 id="plugin-upload-dialog-title" className="font-semibold text-foreground">
            上传{kind === 'media' ? '媒体' : '语言'}插件
          </h3>
          <button type="button" onClick={close} aria-label="关闭" className="rounded p-1 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Risk disclosure — deliberately first-class content, not fine print. */}
        <div className="rounded-[var(--radius-control)] border border-danger-soft bg-danger-soft/20 p-3 text-xs text-foreground space-y-2">
          <div className="flex items-center gap-1.5 font-semibold text-danger">
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            上传前必读
          </div>
          <p>
            上传的插件代码会由 Worker 进程<strong>以该进程的全部权限直接执行</strong>（可读写任务数据、访问已配置的供应商凭据与网络）。
            仅允许受信任的管理员上传，请勿加载任何来源不明的 <code className="font-mono">.mjs</code> 文件。
          </p>
          <p>
            <strong>同版本不可覆盖，升级版本号后重新上传</strong>：插件以 <code className="font-mono">pluginId@pluginVersion</code>{' '}
            为一次性写入身份，Worker 的注册表与模块缓存都以该身份为键，同版本热替换不会生效，服务端会直接拒绝（PLUGIN_VERSION_IMMUTABLE）。
          </p>
        </div>

        <div>
          <label htmlFor="plugin-upload-file" className="mb-1 block text-xs font-medium text-foreground">
            插件包文件
          </label>
          <input
            ref={fileInputRef}
            id="plugin-upload-file"
            type="file"
            accept=".mjs,application/javascript,text/javascript"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              选择 .mjs 文件
            </button>
            {file ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {file.name}（{humanFileSize(file.size)}）
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">未选择文件</span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            单个 .mjs 文件，大小上限 5&nbsp;MB（{PLUGIN_ARTIFACT_MAX_BYTES.toLocaleString('en-US')} 字节，以服务端强制为准）。
          </p>
        </div>

        <div>
          <label htmlFor="plugin-upload-manifest" className="mb-1 block text-xs font-medium text-foreground">
            插件清单 manifest（JSON）
          </label>
          <textarea
            id="plugin-upload-manifest"
            value={manifestText}
            onChange={(e) => setManifestText(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 font-mono text-xs text-foreground outline-none"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            manifest 的 id / version 必须与插件包内注册的插件一致；字段规则由服务端校验。
          </p>
        </div>

        {/* aria-live region: pre-flight verdict + findings update without a click. */}
        <div aria-live="polite" role="status" className="space-y-2">
          {validate.phase === 'checking' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              正在服务端扫描插件包与清单（不落库）…
            </div>
          )}
          {validate.phase === 'error' && (
            <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger" role="alert">
              {validate.message}
            </div>
          )}
          {validate.phase === 'rejected' && (
            <div className="space-y-1.5" role="alert">
              <div className="text-xs font-medium text-danger">{validate.message}（修正后请调整文件或清单）</div>
              <FindingList findings={validate.findings} />
            </div>
          )}
          {validate.phase === 'ready' && validate.summary && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-success">校验通过，可提交安装。</div>
              <div className="rounded-[var(--radius-control)] bg-surface-subtle p-2 text-[11px] text-muted-foreground">
                <span className="font-mono text-foreground">
                  {validate.summary.pluginId}@{validate.summary.pluginVersion}
                </span>
                {' · '}
                {validate.summary.displayName} · {validate.summary.modelIds.length} 个模型 · 制品 sha256{' '}
                <span className="font-mono text-foreground" title={validate.summary.artifactDigest}>
                  {shortDigest(validate.summary.artifactDigest)}
                </span>
                {' · '}
                {humanFileSize(validate.summary.artifactSizeBytes)}
              </div>
              {validate.summary.warnings.length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  <div className="mb-1 font-medium">警告（不阻断安装，但请确认符合预期）：</div>
                  <FindingList findings={validate.summary.warnings} />
                </div>
              )}
            </div>
          )}
          {validate.phase === 'idle' && (
            <div className="text-[11px] text-muted-foreground">选择插件包文件后将自动进行服务端预检。</div>
          )}
        </div>

        {blockingFindings && (
          <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger" role="alert">
            存在错误级别的扫描发现，已禁止提交安装。
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={close}
            className="rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-subtle"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => file && installMutation.mutate({ file, manifest: manifestText })}
            disabled={!canSubmit}
            className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
          >
            {installMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            提交安装
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          提交成功后插件状态为「待加载」：需等待 Worker 拉取制品、核验 sha256 并重新扫描通过后才会启用，安装完成不代表即时生效。
        </p>
      </div>
    </div>
  )
}
