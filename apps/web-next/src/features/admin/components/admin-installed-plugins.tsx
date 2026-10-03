'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type {
  AdminPluginDeleteResult,
  AdminPluginDocsDto,
  AdminPluginDto,
  InstalledPluginStatus,
  PluginKind,
} from '@/shared/types'
import { humanFileSize, resolveApiUrl, shortDigest } from '../lib/plugin-upload'
import { AdminPluginUploadDialog } from './admin-plugin-upload-dialog'
import { PluginFindingList } from './plugin-finding-list'
import { Blocks, Download, ExternalLink, RefreshCw, Trash2, Upload } from 'lucide-react'
import {
  Alert,
  Badge,
  Button,
  buttonVariants,
  Card,
  EmptyState,
  IconButton,
  SkeletonText,
  SkeletonTile,
  Spinner,
  Switch,
} from '@/shared/components/ui'
import type { BadgeTone } from '@/shared/components/ui'

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

// Status is always conveyed by the Chinese label text; the Badge tone only reinforces it.
const STATUS_TONE: Record<InstalledPluginStatus, BadgeTone> = {
  pending: 'neutral',
  active: 'success',
  disabled: 'neutral',
  failed: 'danger',
}

const SECTION_COPY: Record<PluginKind, { title: string; description: string; objectName: string }> = {
  media: {
    title: '已安装媒体插件',
    description:
      '上传的媒体插件（provider_plugins 行）。Worker 加载激活后，插件会并入上方「供应商插件目录」，其模型作为服务端合成的预设出现在「创建模型」中，并可为其签发媒体凭据。',
    objectName: '媒体插件',
  },
  language: {
    title: '已安装语言插件',
    description:
      '上传的语言模型插件（provider_plugins 行）。Worker 加载激活后，其模型由服务端合并进 GET admin/model-presets，作为预设出现在「创建新语言模型」的下拉中；客户端不伪造预设。',
    objectName: '语言插件',
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

/**
 * Package icon, fetched by the browser from GET admin/plugins/{id}/icon through the
 * same-origin proxy (the session cookie rides along). Only requested when `hasIcon`;
 * any load failure (404, decode error) falls back to the generic glyph. Packages may
 * only carry PNG/WebP icons (never SVG), and an `<img>` cannot execute script anyway.
 */
function PluginIcon({ plugin }: { plugin: AdminPluginDto }) {
  const [failed, setFailed] = useState(false)
  if (!plugin.hasIcon || failed) {
    return <Blocks aria-hidden="true" className="h-[var(--icon-sm)] w-[var(--icon-sm)] shrink-0 text-muted-foreground" />
  }
  return (
    <img
      src={resolveApiUrl(API_ENDPOINTS.admin.pluginIcon(plugin.id))}
      alt=""
      width={32}
      height={32}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-8 w-8 shrink-0 rounded-control bg-tonal object-contain"
    />
  )
}

/** Only `https:` homepages become links (spec: homepage must be https); anything else stays inert text. */
function safeHomepage(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const DISCLOSURE_SUMMARY_CLASS =
  'cursor-pointer select-none rounded-control px-3 py-2 font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

type DocKey = keyof AdminPluginDocsDto

const DOC_SECTIONS: { key: DocKey; title: string }[] = [
  { key: 'readme', title: 'README' },
  { key: 'changelog', title: 'CHANGELOG' },
  { key: 'licenseText', title: 'LICENSE' },
]

/**
 * README / CHANGELOG / LICENSE disclosures. The list payload only says which docs
 * exist (`plugin.docs`); the texts (up to 256 KiB each) are fetched from
 * GET admin/plugins/{id}/docs the first time any of them is opened, then cached.
 * They are author-supplied Markdown or plain text; web-next ships no sanitising
 * Markdown renderer, so they are shown verbatim as preformatted text (React
 * escapes it) and never injected as HTML.
 */
function PackageDocs({ plugin }: { plugin: AdminPluginDto }) {
  const [requested, setRequested] = useState(false)
  const available = DOC_SECTIONS.filter((section) => plugin.docs?.[section.key])
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'plugin-docs', plugin.id],
    queryFn: async () => {
      const res = await api<AdminPluginDocsDto>(API_ENDPOINTS.admin.pluginDocs(plugin.id))
      if (!res.success || !res.data) throw new Error(res.error?.message || '加载插件文档失败')
      return res.data
    },
    enabled: requested,
    // Docs of an installed version never change (versions are write-once).
    staleTime: Infinity,
    // Fail fast: the inline 重试 button is the recovery path, not silent backoff.
    retry: 1,
  })
  if (available.length === 0) return null
  return (
    <>
      {available.map(({ key, title }) => {
        const text = data?.[key]
        return (
          <details
            key={key}
            className="rounded-control bg-tonal text-xs"
            onToggle={(event) => {
              if (event.currentTarget.open) setRequested(true)
            }}
          >
            <summary className={DISCLOSURE_SUMMARY_CLASS}>{title}</summary>
            <div className="px-3 pb-3">
              {data === undefined && (isFetching || !error) ? (
                <span className="inline-flex items-center gap-2 text-muted-foreground" role="status">
                  <Spinner size="sm" />
                  正在加载…
                </span>
              ) : error && data === undefined ? (
                <div className="flex flex-wrap items-center gap-2 text-danger" role="alert">
                  <span>{error.message || '加载插件文档失败'}。</span>
                  <Button variant="ghost" size="sm" onClick={() => refetch()}>
                    重试
                  </Button>
                </div>
              ) : text && text.trim() ? (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                  {text}
                </pre>
              ) : (
                <span className="text-muted-foreground">文档内容为空</span>
              )}
            </div>
          </details>
        )
      })}
    </>
  )
}

/** Package format, metadata, file list, docs and the download entry for one installed row. */
function PluginPackageDetails({ plugin }: { plugin: AdminPluginDto }) {
  const isZip = plugin.packageFormat === 'zip-v1'
  const meta = plugin.packageMeta ?? {}
  const homepage = safeHomepage(meta.homepage)
  const files = plugin.packageFiles ?? []
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">包格式</dt>
        <dd>
          <Badge tone="neutral" className="font-mono">
            {isZip ? 'zip 包' : '旧版单文件 (.mjs)'}
          </Badge>
        </dd>
        {isZip && plugin.packageDigest && (
          <>
            <dt className="text-muted-foreground">包 sha256</dt>
            <dd className="font-mono text-foreground" title={plugin.packageDigest}>
              {shortDigest(plugin.packageDigest)}
            </dd>
          </>
        )}
        {meta.author && (
          <>
            <dt className="text-muted-foreground">作者</dt>
            <dd className="break-words text-foreground">{meta.author}</dd>
          </>
        )}
        {meta.license && (
          <>
            <dt className="text-muted-foreground">许可证</dt>
            <dd className="font-mono text-foreground">{meta.license}</dd>
          </>
        )}
        {meta.homepage && (
          <>
            <dt className="text-muted-foreground">主页</dt>
            <dd className="min-w-0">
              {homepage ? (
                <a
                  href={homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <span className="break-all">{homepage}</span>
                  <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
                  <span className="sr-only">（在新窗口打开）</span>
                </a>
              ) : (
                <span className="break-all font-mono text-muted-foreground">{meta.homepage}</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {isZip && files.length > 0 && (
        <details className="rounded-control bg-tonal text-xs">
          <summary className={DISCLOSURE_SUMMARY_CLASS}>
            包内文件（<span className="font-mono tabular-nums">{files.length}</span>）
          </summary>
          <div className="overflow-x-auto px-3 pb-3">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">
                插件包 {plugin.pluginId}@{plugin.pluginVersion} 的文件清单
              </caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-normal">路径</th>
                  <th scope="col" className="py-1 pr-3 text-right font-normal">大小</th>
                  <th scope="col" className="py-1 font-normal">sha256</th>
                </tr>
              </thead>
              <tbody className="font-mono text-foreground">
                {files.map((f) => (
                  <tr key={f.path}>
                    <td className="break-all py-1 pr-3">{f.path}</td>
                    <td className="whitespace-nowrap py-1 pr-3 text-right tabular-nums">{humanFileSize(f.sizeBytes)}</td>
                    <td className="whitespace-nowrap py-1" title={f.sha256}>
                      {shortDigest(f.sha256)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <PackageDocs plugin={plugin} />

      {isZip && (
        <div>
          {/* Navigation to a file is a link, not a button; the server answers with a zip attachment. */}
          <a
            href={resolveApiUrl(API_ENDPOINTS.admin.pluginPackage(plugin.id))}
            download
            aria-label={`下载插件包 ${plugin.pluginId}@${plugin.pluginVersion}`}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <Download aria-hidden="true" />
            下载插件包
          </a>
        </div>
      )}
    </div>
  )
}

/** Label + value chip row inside a plugin card. */
function ChipRow({ label, items }: { label: string; items: { key: string; text: string; title?: string }[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-overline text-muted-foreground">
        {label}（<span className="font-mono tabular-nums">{items.length}</span>）
      </p>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {items.map((item) => (
            <Badge key={item.key} tone="neutral" className="max-w-full font-mono" title={item.title}>
              {item.text}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">-</p>
      )}
    </div>
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
    <section className="flex flex-col gap-4" aria-labelledby={`installed-plugins-${kind}-heading`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1 text-foreground">
          <h2 id={`installed-plugins-${kind}-heading`} className="text-module">
            {copy.title}
          </h2>
          <p className="max-w-reading text-sm text-muted-foreground">{copy.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setActionError('')
              setStatusNote('')
              setUploadOpen(true)
            }}
            icon={<Upload aria-hidden="true" />}
          >
            上传插件
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setActionError('')
              refetch()
            }}
            icon={<RefreshCw aria-hidden="true" className={isFetching ? 'motion-spin' : undefined} />}
          >
            刷新
          </Button>
        </div>
      </div>

      {actionError && (
        <Alert tone="danger" role="alert" title="插件操作未完成">
          {actionError}。请按提示修正后重试；若插件仍被模型引用，请先解除绑定。
        </Alert>
      )}
      {statusNote && (
        <Alert tone="info" title="操作结果">
          {statusNote}
        </Alert>
      )}

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2" role="status" aria-busy="true">
          <span className="sr-only">正在加载已安装插件</span>
          {Array.from({ length: 2 }, (_, index) => (
            <Card key={index} density="compact" aria-hidden="true" className="h-full gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-2"><SkeletonText width="10rem" /><SkeletonText width="8rem" /></div>
                <SkeletonTile className="aspect-auto h-6 w-16 rounded-pill" />
              </div>
              <SkeletonText lines={2} />
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
                <SkeletonText width="7rem" /><SkeletonText width="9rem" />
                <SkeletonText width="7rem" /><SkeletonText width="8rem" />
                <SkeletonText width="7rem" /><SkeletonText width="12rem" />
              </div>
              <SkeletonText width="8rem" />
              <div className="flex gap-2"><SkeletonTile className="aspect-auto h-6 w-20 rounded-pill" /><SkeletonTile className="aspect-auto h-6 w-24 rounded-pill" /></div>
              <SkeletonText lines={2} />
              <div className="mt-auto flex justify-end"><SkeletonTile className="aspect-auto h-8 w-24 rounded-control" /></div>
            </Card>
          ))}
        </div>
      ) : error ? (
        <Alert
          tone="danger"
          role="alert"
          title="无法加载已安装插件"
          action={
            <Button variant="secondary" size="sm" onClick={() => refetch()}>
              刷新重试
            </Button>
          }
        >
          {error.message || '加载已安装插件失败'}。请检查后端服务状态后重试。
        </Alert>
      ) : scopedPlugins.length === 0 ? (
        <Card density="compact">
          <EmptyState
            variant="first-use"
            density="compact"
            objectName={copy.objectName}
            title={`还没有安装${kind === 'media' ? '媒体' : '语言'}插件`}
            description="尚未安装任何自定义插件；内置插件以卡片形式展示在上方目录中，不在此列表内。点击右上角「上传插件」可添加自定义插件。"
          />
        </Card>
      ) : (
        // `md` is 960px here: two columns only fit comfortably from `lg` (1280px)
        // once the 260px admin sidebar and page padding are subtracted.
        <div className="grid gap-4 lg:grid-cols-2">
          {scopedPlugins.map((p) => {
            const models = manifestModels(p)
            const togglable = p.status === 'active' || p.status === 'disabled'
            return (
              <Card key={p.id} density="compact" className="h-full">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <PluginIcon plugin={p} />
                      <h3 className="truncate text-sm font-medium">{p.displayName}</h3>
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {p.pluginId}@{p.pluginVersion}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[p.status]} className="shrink-0" icon={p.status === 'pending' ? <Spinner size="xs" /> : undefined}>
                    {STATUS_LABEL[p.status]}
                  </Badge>
                </div>

                {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}

                {p.status === 'pending' && (
                  <div role="status" className="rounded-control bg-tonal p-3 text-xs text-muted-foreground">
                    Worker 正在拉取制品、核验 sha256 并重新扫描（约 5 秒一轮）；若对象存储或 ALLOW_PLUGIN_UPLOAD 未配置，此状态可能持续。
                  </div>
                )}
                {p.status === 'failed' && (
                  // The 4px bar is `Alert`'s danger tone — a soft red is never a border colour.
                  <Alert tone="danger" role="alert" title={p.errorCode || 'PLUGIN_LOAD_FAILED'} icon={false}>
                    <div>{p.errorMessage || 'Worker 加载该插件失败'}</div>
                    <div className="mt-1">加载失败的版本不可重新启用，请以新版本号重新上传插件包。</div>
                  </Alert>
                )}

                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">Allowed hosts</dt>
                  <dd className="flex flex-wrap gap-1">
                    {p.allowedHosts.length > 0 ? (
                      p.allowedHosts.map((host) => (
                        <Badge key={host} tone="neutral" className="max-w-full font-mono">
                          {host}
                        </Badge>
                      ))
                    ) : (
                      <span className="font-mono text-muted-foreground">-</span>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">凭据 Schema</dt>
                  <dd className="flex flex-wrap gap-1">
                    {p.credentialSchemas.map((schema) => (
                      <Badge key={schema} tone="neutral" className="max-w-full font-mono">
                        {schema}
                      </Badge>
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
                  <dt className="text-muted-foreground">入口制品</dt>
                  <dd className="font-mono text-foreground">
                    sha256: <span title={p.artifactDigest}>{shortDigest(p.artifactDigest)}</span>
                    <span className="ml-1 text-muted-foreground">· {humanFileSize(p.artifactSizeBytes)}</span>
                  </dd>
                </dl>

                <ChipRow
                  label="支持模型"
                  items={models.map((model) => ({ key: model.id, text: model.id, title: model.name }))}
                />

                <PluginPackageDetails plugin={p} />

                <div className="flex flex-col gap-1">
                  <p className="text-overline text-muted-foreground">
                    扫描报告（<span className="font-mono tabular-nums">{p.scanReport.length}</span>）
                  </p>
                  <PluginFindingList findings={p.scanReport} groupByPath emptyText="安装时未发现任何问题" />
                </div>

                <div className="mt-auto flex flex-wrap items-center justify-end gap-3">
                  {/* pending belongs to the worker, failed is terminal: no toggle offered,
                      the server would answer PLUGIN_NOT_LOADED / PLUGIN_FAILED_IMMUTABLE. */}
                  {togglable && (
                    <>
                      {/* Immediate setting: `Switch` reverts itself when the PATCH rejects,
                          and the failure surfaces in the banner above. The card's status
                          Badge already carries the value, so the text names the setting. */}
                      <span className="text-sm text-muted-foreground">启用</span>
                      <Switch
                        checked={p.status === 'active'}
                        disabled={statusMutation.isPending}
                        onCheckedChange={(enabled) => {
                          setStatusNote('')
                          return statusMutation.mutateAsync({
                            id: p.id,
                            status: enabled ? 'active' : 'disabled',
                          })
                        }}
                        aria-label={`插件 ${p.displayName} 启用状态`}
                      />
                    </>
                  )}
                  <IconButton
                    variant="danger-ghost"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (confirm(`确认删除插件 ${p.displayName}（${p.pluginId}@${p.pluginVersion}）？`)) {
                        setStatusNote('')
                        deleteMutation.mutate(p.id)
                      }
                    }}
                    aria-label={`删除插件 ${p.displayName} ${p.pluginVersion}`}
                    icon={<Trash2 aria-hidden="true" />}
                  />
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <AdminPluginUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        kind={kind}
        onInstalled={({ pluginId, pluginVersion }) =>
          setStatusNote(`插件 ${pluginId}@${pluginVersion} 上传成功，当前状态「待加载」：需等待 Worker 拉取制品、核验 sha256 并重新扫描通过后才会启用。`)
        }
      />
    </section>
  )
}
