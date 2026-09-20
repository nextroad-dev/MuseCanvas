'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type {
  AdminPluginDeleteResult,
  AdminPluginDto,
  AdminPluginScanFinding,
  InstalledPluginStatus,
  PluginKind,
} from '@/shared/types'
import { humanFileSize, shortDigest } from '../lib/plugin-upload'
import { AdminPluginUploadDialog } from './admin-plugin-upload-dialog'
import { Blocks, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'

// The worker promotes `pending` rows on its maintenance loop (setInterval(runMaintenance,
// 5000) in apps/worker/src/index.ts), and a failed refresh leaves rows pending, so the
// list must keep polling while anything is pending and stop otherwise.
const PENDING_POLL_MS = 5000

const STATUS_LABEL: Record<InstalledPluginStatus, string> = {
  pending: '待加载',
  active: '已启用',
  disabled: '已停用',
  failed: '加载失败',
}

// Status is always conveyed by the Chinese label text; colour only reinforces it.
const STATUS_CHIP_CLASS: Record<InstalledPluginStatus, string> = {
  pending: 'bg-surface-subtle text-muted-foreground',
  active: 'bg-success-soft text-success',
  disabled: 'bg-surface-subtle text-muted-foreground',
  failed: 'bg-danger-soft text-danger',
}

const SECTION_COPY: Record<PluginKind, { title: string; description: string }> = {
  media: {
    title: '已安装媒体插件',
    description:
      '上传的媒体插件（provider_plugins 行）。Worker 加载激活后，插件会并入上方「供应商插件目录」，其模型作为服务端合成的预设出现在「添加模型」中，并可为其签发媒体凭据。',
  },
  language: {
    title: '已安装语言插件',
    description:
      '上传的语言模型插件（provider_plugins 行）。Worker 加载激活后，其模型由服务端合并进 GET admin/model-presets，作为预设出现在「添加新语言模型」的下拉中；客户端不伪造预设。',
  },
}

function manifestModels(plugin: AdminPluginDto): { id: string; name?: string }[] {
  const raw: unknown = plugin.manifest.models
  if (!Array.isArray(raw)) return []
  return raw.reduce<{ id: string; name?: string }[]>((acc, entry) => {
    if (!entry || typeof entry !== 'object') return acc
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || !id) return acc
    const name = (entry as { name?: unknown }).name
    acc.push({ id, name: typeof name === 'string' ? name : undefined })
    return acc
  }, [])
}

function FindingList({ findings, emptyText }: { findings: AdminPluginScanFinding[]; emptyText?: string }) {
  if (findings.length === 0) {
    return emptyText ? <div className="text-[11px] text-muted-foreground">{emptyText}</div> : null
  }
  return (
    <ul className="space-y-1">
      {findings.map((f, i) => (
        <li
          key={`${f.rule}-${f.line ?? 'x'}-${i}`}
          className={`rounded border px-2 py-1 text-[11px] ${
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

interface AdminInstalledPluginsProps {
  /** Rows are filtered server-side by nothing; the section scopes `kind` client-side (media on 媒体模型, language on 语言模型). */
  kind: PluginKind
}

/**
 * Shared installed-plugins console for both admin model pages: list (polled while any
 * row is `pending`), enable/disable, delete, refresh and the upload entry point.
 * Built-in plugins are NOT listed here — GET admin/plugins only returns installed rows;
 * built-ins keep rendering as template cards above.
 */
export function AdminInstalledPlugins({ kind }: AdminInstalledPluginsProps) {
  const queryClient = useQueryClient()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [statusNote, setStatusNote] = useState('')
  const hadPendingRef = useRef(false)

  const {
    data: plugins = [],
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['admin', 'plugins'],
    queryFn: async () => {
      // The list endpoint returns a bare AdminPluginDto[] (no { items } wrapper) —
      // `ok(rows.map(pluginDtoFromRow))` in apps/api/src/modules/admin/plugins.ts.
      const res = await api<AdminPluginDto[]>(API_ENDPOINTS.admin.plugins)
      if (!res.success) throw new Error(res.error?.message || '加载已安装插件失败')
      return res.data || []
    },
    refetchInterval: (query) =>
      (query.state.data || []).some((p) => p.status === 'pending') ? PENDING_POLL_MS : false,
  })

  // Once the last pending row settles, the merged catalogs (plugin directory +
  // synthetic presets) changed server-side; pull them back into sync.
  useEffect(() => {
    const pending = plugins.some((p) => p.status === 'pending')
    if (hadPendingRef.current && !pending) {
      queryClient.invalidateQueries({ queryKey: ['admin', 'model-presets'] })
      queryClient.invalidateQueries({ queryKey: ['admin', 'provider-templates'] })
    }
    hadPendingRef.current = pending
  }, [plugins, queryClient])

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'active' | 'disabled' }) => {
      // Only 'active' <-> 'disabled' is accepted; 'failed' answers PLUGIN_FAILED_IMMUTABLE
      // and 'pending' answers PLUGIN_NOT_LOADED — both messages surface verbatim below.
      const res = await api<AdminPluginDto>(API_ENDPOINTS.admin.plugin(id), { method: 'PATCH', body: { status } })
      if (!res.success) throw new Error(res.error?.message || '更新插件状态失败')
      return res.data
    },
    onSuccess: () => {
      setActionError('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'plugins'] })
    },
    onError: (err: Error) => setActionError(err.message || '更新插件状态失败'),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api<AdminPluginDeleteResult>(API_ENDPOINTS.admin.plugin(id), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除插件失败')
      return res.data
    },
    onSuccess: (data) => {
      setActionError('')
      // The server explains the retention contract on success; show it verbatim.
      setStatusNote(data?.note || '插件已删除。')
      queryClient.invalidateQueries({ queryKey: ['admin', 'plugins'] })
    },
    // PLUGIN_IN_USE ("该插件版本仍被模型配置引用…") surfaces here unmodified.
    onError: (err: Error) => setActionError(err.message || '删除插件失败'),
  })

  const scopedPlugins = plugins.filter((p) => p.kind === kind)
  const copy = SECTION_COPY[kind]

  return (
    <section className="space-y-3" aria-labelledby={`installed-plugins-${kind}-heading`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id={`installed-plugins-${kind}-heading`} className="text-sm font-semibold text-foreground">
            {copy.title}
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">{copy.description}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setActionError('')
              setStatusNote('')
              setUploadOpen(true)
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            上传插件
          </button>
          <button
            type="button"
            onClick={() => {
              setActionError('')
              refetch()
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            刷新
          </button>
        </div>
      </div>

      {actionError && (
        <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger" role="alert">
          {actionError}
        </div>
      )}
      {statusNote && (
        <div className="rounded border border-border bg-surface-subtle p-2 text-xs text-muted-foreground" role="status">
          {statusNote}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden="true" />
          <span className="sr-only">正在加载已安装插件</span>
        </div>
      ) : error ? (
        <div className="rounded-[var(--radius-card)] border border-danger-soft bg-danger-soft/20 p-4 text-xs text-danger" role="alert">
          {error.message || '加载已安装插件失败'}
        </div>
      ) : scopedPlugins.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-xs text-muted-foreground">
          尚未安装任何{kind === 'media' ? '媒体' : '语言'}插件；内置插件以卡片形式展示在上方目录中，不在此列表内。
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {scopedPlugins.map((p) => {
            const models = manifestModels(p)
            return (
              <div key={p.id} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Blocks className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <h3 className="truncate text-sm font-semibold text-foreground">{p.displayName}</h3>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {p.pluginId}@{p.pluginVersion}
                    </div>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${STATUS_CHIP_CLASS[p.status]}`}>
                    {p.status === 'pending' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                    {STATUS_LABEL[p.status]}
                  </span>
                </div>

                {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}

                {p.status === 'pending' && (
                  <p className="rounded-[var(--radius-control)] bg-surface-subtle p-2 text-[11px] text-muted-foreground" role="status">
                    Worker 正在拉取制品、核验 sha256 并重新扫描（约 5 秒一轮）；若对象存储或 ALLOW_PLUGIN_UPLOAD 未配置，此状态可能持续。
                  </p>
                )}
                {p.status === 'failed' && (
                  <div className="rounded-[var(--radius-control)] border border-danger-soft bg-danger-soft/20 p-2 text-[11px] text-danger" role="alert">
                    <div className="font-mono font-semibold">{p.errorCode || 'PLUGIN_LOAD_FAILED'}</div>
                    <div>{p.errorMessage || 'Worker 加载该插件失败'}</div>
                    <div className="mt-1 text-muted-foreground">加载失败的字节不可重新启用，请以新版本号重新上传。</div>
                  </div>
                )}

                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                  <dt className="text-muted-foreground">Allowed hosts</dt>
                  <dd className="flex flex-wrap gap-1">
                    {p.allowedHosts.length > 0 ? (
                      p.allowedHosts.map((host) => (
                        <span key={host} className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-foreground">
                          {host}
                        </span>
                      ))
                    ) : (
                      <span className="font-mono text-muted-foreground">-</span>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">凭据 Schema</dt>
                  <dd className="flex flex-wrap gap-1">
                    {p.credentialSchemas.map((schema) => (
                      <span key={schema} className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-foreground">
                        {schema}
                      </span>
                    ))}
                  </dd>
                  {p.kind === 'media' && p.modalities.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">模态</dt>
                      <dd className="font-mono text-foreground">{p.modalities.join(', ')}</dd>
                    </>
                  )}
                  {p.kind === 'language' && p.languageProtocols.length > 0 && (
                    <>
                      <dt className="text-muted-foreground">协议</dt>
                      <dd className="font-mono text-foreground">{p.languageProtocols.join(', ')}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">制品</dt>
                  <dd className="font-mono text-foreground">
                    sha256:{' '}
                    <span title={p.artifactDigest}>{shortDigest(p.artifactDigest)}</span>
                    <span className="ml-1 text-muted-foreground">· {humanFileSize(p.artifactSizeBytes)}</span>
                  </dd>
                </dl>

                <div className="space-y-1 text-[11px]">
                  <div className="text-muted-foreground">支持模型（{models.length}）</div>
                  <div className="flex flex-wrap gap-1">
                    {models.map((model) => (
                      <span key={model.id} className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-foreground" title={model.name}>
                        {model.id}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="space-y-1 text-[11px]">
                  <div className="text-muted-foreground">扫描报告（{p.scanReport.length}）</div>
                  <FindingList findings={p.scanReport} emptyText="安装时未发现任何问题" />
                </div>

                <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-1">
                  {/* pending belongs to the worker, failed is terminal: no toggle offered,
                      the server would answer PLUGIN_NOT_LOADED / PLUGIN_FAILED_IMMUTABLE. */}
                  {(p.status === 'active' || p.status === 'disabled') && (
                    <button
                      type="button"
                      onClick={() => {
                        setStatusNote('')
                        statusMutation.mutate({ id: p.id, status: p.status === 'active' ? 'disabled' : 'active' })
                      }}
                      disabled={statusMutation.isPending}
                      aria-label={p.status === 'active' ? `停用插件 ${p.displayName}` : `启用插件 ${p.displayName}`}
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                        p.status === 'active'
                          ? 'bg-success-soft text-success hover:bg-success-soft/80'
                          : 'bg-surface-subtle text-muted-foreground hover:bg-surface-subtle-strong'
                      }`}
                    >
                      {p.status === 'active' ? '点击停用' : '点击启用'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`确认删除插件 ${p.displayName}（${p.pluginId}@${p.pluginVersion}）？`)) {
                        setStatusNote('')
                        deleteMutation.mutate(p.id)
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    aria-label={`删除插件 ${p.displayName} ${p.pluginVersion}`}
                    className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-border p-1.5 text-danger hover:bg-danger-soft/20 disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <AdminPluginUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        kind={kind}
        onInstalled={({ pluginId, pluginVersion }) =>
          setStatusNote(`已提交 ${pluginId}@${pluginVersion}：当前状态「待加载」，需等待 Worker 拉取制品、核验 sha256 并重新扫描通过后才会启用。`)
        }
      />
    </section>
  )
}
