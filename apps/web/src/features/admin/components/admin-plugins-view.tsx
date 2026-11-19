'use client'

import { useMemo, useRef, useState } from 'react'
import {
  ArrowClockwiseIcon,
  BookOpenTextIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  FileZipIcon,
  PowerIcon,
  PuzzlePieceIcon,
  ShieldWarningIcon,
  TrashIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'

import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  Skeleton,
  TableBody,
  TableCell,
  TableHeadCell,
  TableHeader,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  Tabs,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import type { BadgeTone, TabItem } from '@/shared/components/ui'
import {
  useAdminPluginDocs,
  useAdminPlugins,
  useDeleteAdminPlugin,
  useSetAdminPluginStatus,
  useUploadAdminPlugin,
  useValidateAdminPlugin,
} from '@/shared/hooks/useAdmin'
import { formatBytes } from '@/shared/lib/format'
import { clientApi, isApiError } from '@/shared/services/client-api'
import type {
  AdminPluginDto,
  AdminPluginRejected,
  AdminPluginScanFinding,
  AdminPluginValidateOk,
  InstalledPluginStatus,
} from '@/shared/types'

function statusLabel(status: InstalledPluginStatus): string {
  switch (status) {
    case 'active':
      return '已启用'
    case 'disabled':
      return '已停用'
    case 'pending':
      return '校验中'
    case 'failed':
      return '加载失败'
  }
}

function statusTone(status: InstalledPluginStatus): BadgeTone {
  switch (status) {
    case 'active':
      return 'success'
    case 'disabled':
      return 'neutral'
    case 'pending':
      return 'info'
    case 'failed':
      return 'danger'
  }
}

function formatPluginError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'PLUGIN_IN_USE') {
      return '该插件正被现有模型或凭据引用，请先解绑或删除关联模型后再移除插件（409 PLUGIN_IN_USE）。'
    }
    if (error.code === 'PLUGIN_UPLOAD_DISABLED') {
      return '当前实例未开启自定义插件包上传功能（400 PLUGIN_UPLOAD_DISABLED）。'
    }
    if (error.code === 'PLUGIN_VERSION_IMMUTABLE') {
      return '该插件版本已存在且不可覆盖，请升级 manifest.json 中的版本号后重新打包上传（409 PLUGIN_VERSION_IMMUTABLE）。'
    }
    return `${error.message} (${error.code})`
  }
  return error instanceof Error ? error.message : '插件操作失败，请稍后重试。'
}

function FindingsList({ findings, title }: { findings: AdminPluginScanFinding[]; title: string }) {
  if (findings.length === 0) return null
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-canvas p-4">
      <div className="flex items-center gap-2">
        <ShieldWarningIcon weight="duotone" className={`${iconSize.sm} text-warning`} />
        <span className="text-ui font-medium text-foreground">
          {title} ({findings.length})
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {findings.map((finding, idx) => (
          <li
            key={`${finding.rule}-${idx}`}
            className="flex flex-col gap-1 rounded-control border border-border bg-surface p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={finding.severity === 'error' ? 'danger' : 'warning'}>
                {finding.severity === 'error' ? '错误 (error)' : '警告 (warn)'}
              </Badge>
              <span className="font-mono text-xs font-medium text-foreground">{finding.rule}</span>
              {finding.path ? (
                <span className="font-mono text-caption text-muted-foreground">
                  {finding.path}
                  {finding.line ? `:${finding.line}${finding.column ? `:${finding.column}` : ''}` : ''}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">{finding.message}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AdminPluginsView() {
  const { toast } = useToast()

  const pluginsQuery = useAdminPlugins()
  const validateMutation = useValidateAdminPlugin()
  const uploadMutation = useUploadAdminPlugin()
  const setStatusMutation = useSetAdminPluginStatus()
  const deleteMutation = useDeleteAdminPlugin()

  const [togglingId, setTogglingId] = useState<string | null>(null)

  // 上传并校验 2 步弹窗状态
  const [uploadOpen, setUploadOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [validatedResult, setValidatedResult] = useState<AdminPluginValidateOk | null>(null)
  const [rejectedResult, setRejectedResult] = useState<AdminPluginRejected | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 文档查看弹窗状态
  const [docsPlugin, setDocsPlugin] = useState<AdminPluginDto | null>(null)
  const [activeDocTab, setActiveDocTab] = useState<string>('readme')
  const docsQuery = useAdminPluginDocs(docsPlugin?.id ?? null)

  // 删除确认弹窗状态
  const [deleteTarget, setDeleteTarget] = useState<AdminPluginDto | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const plugins = useMemo(() => pluginsQuery.data ?? [], [pluginsQuery.data])

  function openUploadDialog() {
    setSelectedFile(null)
    setValidatedResult(null)
    setRejectedResult(null)
    setUploadError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setUploadOpen(true)
  }

  function handleFileChange(file: File | null) {
    setSelectedFile(file)
    setValidatedResult(null)
    setRejectedResult(null)
    setUploadError(null)
  }

  async function handleValidatePackage() {
    if (!selectedFile) {
      setUploadError('请先选择一个 .zip 格式的插件包文件。')
      return
    }
    setUploadError(null)
    setValidatedResult(null)
    setRejectedResult(null)

    try {
      const result = await validateMutation.mutateAsync({ file: selectedFile })
      if ('ok' in result && result.ok === false) {
        setRejectedResult(result)
        toast.warning('插件包未通过安全校验', `返回错误码：${result.code}`)
        return
      }
      setValidatedResult(result)
      toast.success('插件包校验通过', `已识别插件「${result.displayName}」(${result.pluginId}@${result.pluginVersion})。`)
    } catch (error) {
      const message = formatPluginError(error)
      setUploadError(message)
      toast.error('校验插件包失败', message)
    }
  }

  async function handleConfirmInstall() {
    if (!selectedFile) return
    setUploadError(null)

    try {
      const res = await uploadMutation.mutateAsync({ file: selectedFile })
      if ('installed' in res && res.installed === false) {
        setRejectedResult(res)
        setValidatedResult(null)
        toast.error('插件包安装被拒绝', `安全扫描未通过：${res.code}`)
        return
      }
      toast.success(
        '插件安装成功',
        `已安装并注册「${res.plugin.displayName}」(${res.plugin.pluginId}@${res.plugin.pluginVersion})。`,
      )
      setUploadOpen(false)
    } catch (error) {
      const message = formatPluginError(error)
      setUploadError(message)
      toast.error('安装插件失败', message)
    }
  }

  async function handleToggleStatus(plugin: AdminPluginDto) {
    if (plugin.status !== 'active' && plugin.status !== 'disabled') return
    const nextStatus = plugin.status === 'active' ? 'disabled' : 'active'
    setTogglingId(plugin.id)
    try {
      await setStatusMutation.mutateAsync({ id: plugin.id, status: nextStatus })
      toast.success(
        nextStatus === 'active' ? '插件已启用' : '插件已停用',
        `「${plugin.displayName}」状态已更新。`,
      )
    } catch (error) {
      toast.error('更新插件状态失败', formatPluginError(error))
    } finally {
      setTogglingId(null)
    }
  }

  function openDocsDialog(plugin: AdminPluginDto) {
    setDocsPlugin(plugin)
    if (plugin.docs.readme) setActiveDocTab('readme')
    else if (plugin.docs.changelog) setActiveDocTab('changelog')
    else if (plugin.docs.licenseText) setActiveDocTab('license')
    else setActiveDocTab('readme')
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    setDeleteError(null)
    try {
      const result = await deleteMutation.mutateAsync(deleteTarget.id)
      toast.success('插件已删除', result.note || `已移除「${deleteTarget.displayName}」。`)
      setDeleteTarget(null)
    } catch (error) {
      const message = formatPluginError(error)
      setDeleteError(message)
      toast.error('删除插件失败', message)
    }
  }

  const docTabs = useMemo<TabItem[]>(() => {
    const docs = docsQuery.data
    return [
      {
        id: 'readme',
        label: 'README',
        content: docs?.readme ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-card border border-border bg-canvas p-4 font-mono text-xs text-foreground">
            {docs.readme}
          </pre>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">该插件包未提供 README 文档。</p>
        ),
      },
      {
        id: 'changelog',
        label: 'CHANGELOG',
        content: docs?.changelog ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-card border border-border bg-canvas p-4 font-mono text-xs text-foreground">
            {docs.changelog}
          </pre>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">该插件包未提供 CHANGELOG 文档。</p>
        ),
      },
      {
        id: 'license',
        label: 'LICENSE',
        content: docs?.licenseText ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-card border border-border bg-canvas p-4 font-mono text-xs text-foreground">
            {docs.licenseText}
          </pre>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">该插件包未提供 LICENSE 文档。</p>
        ),
      },
    ]
  }, [docsQuery.data])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="插件管理"
        description="上传并校验 ZIP 格式模型插件包，查看安全扫描报告、文档与启停状态。"
        actions={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => void pluginsQuery.refetch()}
              loading={pluginsQuery.isFetching}
              leadingIcon={<ArrowClockwiseIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={openUploadDialog}
              leadingIcon={<UploadSimpleIcon weight="bold" aria-hidden="true" className={iconSize.sm} />}
            >
              上传插件包
            </Button>
          </>
        }
      />

      {pluginsQuery.isError ? (
        <Alert
          tone="danger"
          title="插件列表加载失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void pluginsQuery.refetch()}>
              重试
            </Button>
          }
        >
          {formatPluginError(pluginsQuery.error)}
        </Alert>
      ) : null}

      <DataTable caption="已安装插件列表" columns={5} className="[&>table]:min-w-[960px]">
        <TableHeader>
          <TableHeadCell>插件信息</TableHeadCell>
          <TableHeadCell>类型与来源</TableHeadCell>
          <TableHeadCell>状态</TableHeadCell>
          <TableHeadCell>安全域名与体积</TableHeadCell>
          <TableHeadCell align="right">操作</TableHeadCell>
        </TableHeader>
        <TableBody busy={pluginsQuery.isFetching}>
          {pluginsQuery.isPending ? (
            Array.from({ length: 4 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <Skeleton key="info" className="h-10 w-56" />,
                  <Skeleton key="kind" className="h-5 w-32" />,
                  <Skeleton key="status" className="h-5 w-20" />,
                  <Skeleton key="hosts" className="h-5 w-44" />,
                  <Skeleton key="actions" className="ml-auto h-8 w-40" />,
                ]}
              />
            ))
          ) : plugins.length === 0 ? (
            <TableStateRow>
              <EmptyState
                density="compact"
                icon={PuzzlePieceIcon}
                title="暂无已安装插件"
                description="上传符合 MuseCanvas-Connector 规范的 ZIP 插件包以扩展图像、视频或语言模型能力。"
                action={
                  <Button variant="primary" size="sm" onClick={openUploadDialog}>
                    上传插件包
                  </Button>
                }
              />
            </TableStateRow>
          ) : (
            plugins.map((plugin) => {
              const canToggle = plugin.status === 'active' || plugin.status === 'disabled'
              const isTogglingThis = togglingId === plugin.id && setStatusMutation.isPending

              return (
                <TableRow key={plugin.id} hover>
                  <TableCell>
                    <div className="flex items-start gap-3">
                      {plugin.hasIcon ? (
                        <img
                          src={clientApi.admin.pluginIconUrl(plugin.id)}
                          alt=""
                          className="size-9 shrink-0 rounded-control border border-border bg-surface object-contain p-1"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="inline-flex size-9 shrink-0 items-center justify-center rounded-control bg-tonal text-muted-foreground"
                        >
                          <PuzzlePieceIcon weight="duotone" className={iconSize.md} />
                        </span>
                      )}
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-foreground">{plugin.displayName}</span>
                          <span className="font-mono text-caption text-muted-foreground">
                            {plugin.pluginId}@{plugin.pluginVersion}
                          </span>
                        </div>
                        {plugin.description ? (
                          <p className="line-clamp-2 max-w-md text-xs text-muted-foreground">
                            {plugin.description}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={plugin.kind === 'media' ? 'accent' : 'info'}>
                        {plugin.kind === 'media' ? '媒体内核' : '语言内核'}
                      </Badge>
                      <Badge tone="neutral" variant="outline">
                        {plugin.source === 'builtin' ? '内置' : '上传'}
                      </Badge>
                      <Badge tone="neutral">{plugin.packageFormat}</Badge>
                      {plugin.modalities.map((mod) => (
                        <Badge key={mod} tone="info" variant="soft">
                          {mod === 'video' ? '视频' : '图像'}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Badge tone={statusTone(plugin.status)} dot>
                        {statusLabel(plugin.status)}
                      </Badge>
                      {plugin.status === 'failed' && (plugin.errorCode || plugin.errorMessage) ? (
                        <span
                          className="max-w-xs truncate font-mono text-caption text-danger"
                          title={plugin.errorMessage || plugin.errorCode || undefined}
                        >
                          {plugin.errorCode ? `[${plugin.errorCode}] ` : ''}
                          {plugin.errorMessage}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-1">
                        {plugin.allowedHosts.length > 0 ? (
                          plugin.allowedHosts.map((host) => (
                            <span
                              key={host}
                              className="inline-flex rounded-control border border-border bg-canvas px-1.5 py-0.5 font-mono text-caption text-foreground"
                            >
                              {host}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">无外部域名声明</span>
                        )}
                      </div>
                      <span className="font-mono text-caption text-muted-foreground">
                        产物大小：{formatBytes(plugin.artifactSizeBytes)}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell align="right">
                    <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!canToggle}
                        loading={isTogglingThis}
                        onClick={() => void handleToggleStatus(plugin)}
                        leadingIcon={<PowerIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
                      >
                        {plugin.status === 'active' ? '停用' : '启用'}
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDocsDialog(plugin)}
                        leadingIcon={
                          <BookOpenTextIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                        }
                      >
                        文档
                      </Button>

                      {plugin.packageFormat === 'zip-v1' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          asChild
                          leadingIcon={
                            <DownloadSimpleIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                          }
                        >
                          <a href={clientApi.admin.pluginPackageUrl(plugin.id)} download>
                            下载包
                          </a>
                        </Button>
                      ) : null}

                      {plugin.source === 'uploaded' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:bg-danger-soft hover:text-danger"
                          onClick={() => {
                            setDeleteError(null)
                            setDeleteTarget(plugin)
                          }}
                          leadingIcon={<TrashIcon weight="bold" aria-hidden="true" className={iconSize.xs} />}
                        >
                          删除
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </DataTable>

      {/* 2 步上传与校验插件包弹窗 */}
      <Dialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        size="wide"
        title="上传并校验插件包"
        description="第一步：上传 .zip 插件包进行清单与静态安全扫描校验；第二步：确认无阻断错误后正式安装。"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setUploadOpen(false)}
              disabled={validateMutation.isPending || uploadMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="secondary"
              disabled={!selectedFile || uploadMutation.isPending}
              loading={validateMutation.isPending}
              onClick={() => void handleValidatePackage()}
            >
              1. 校验插件包
            </Button>
            <Button
              variant="primary"
              disabled={!validatedResult || validateMutation.isPending}
              loading={uploadMutation.isPending}
              onClick={() => void handleConfirmInstall()}
            >
              2. 确认安装
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {uploadError ? (
            <Alert tone="danger" role="alert" title="插件包操作失败">
              {uploadError}
            </Alert>
          ) : null}

          <div className="flex flex-col gap-3 rounded-card border border-border bg-canvas p-4">
            <label
              htmlFor="admin-plugin-zip-input"
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-control border border-dashed border-border-control bg-surface px-4 py-6 text-center transition-colors hover:border-border-focus"
            >
              <FileZipIcon weight="duotone" className={`${iconSize.xl} text-accent`} />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {selectedFile ? selectedFile.name : '点击选择 .zip 格式插件包'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {selectedFile
                    ? `文件大小：${formatBytes(selectedFile.size)}（点击可重新选择）`
                    : '包含 manifest.json、入口 bundle 及可选文档与图标的 zip-v1 插件包'}
                </span>
              </div>
              <input
                ref={fileInputRef}
                id="admin-plugin-zip-input"
                type="file"
                accept=".zip,application/zip"
                className="sr-only"
                onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          {/* 422 扫描拒绝报告 */}
          {rejectedResult ? (
            <div className="flex flex-col gap-4">
              <Alert tone="danger" role="alert" title={`安全校验未通过 (${rejectedResult.code})`}>
                插件包存在阻断性问题，请根据以下扫描报告修复后重新打包上传。
              </Alert>
              <FindingsList findings={rejectedResult.findings} title="安全与契约扫描发现项" />
            </div>
          ) : null}

          {/* 校验通过元数据摘要 */}
          {validatedResult ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2 rounded-card border border-success-border bg-success-soft px-4 py-3 text-success">
                <CheckCircleIcon weight="fill" className={iconSize.md} />
                <span className="text-sm font-medium">
                  插件包校验通过，点击下方「2. 确认安装」即可完成注册。
                </span>
              </div>

              <div className="grid gap-3 rounded-card border border-border bg-canvas p-4 sm:grid-cols-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">插件名称</span>
                  <span className="text-sm font-medium text-foreground">{validatedResult.displayName}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">插件 ID 与版本</span>
                  <span className="font-mono text-ui text-foreground">
                    {validatedResult.pluginId}@{validatedResult.pluginVersion}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">内核类型 / 包格式</span>
                  <span className="text-sm text-foreground">
                    {validatedResult.kind === 'media' ? '媒体内核 (media)' : '语言内核 (language)'} ·{' '}
                    <span className="font-mono">{validatedResult.packageFormat}</span>
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">产物大小 / 包内文件数</span>
                  <span className="font-mono text-ui text-foreground">
                    {formatBytes(validatedResult.artifactSizeBytes)} · {validatedResult.packageFiles.length} 个文件
                  </span>
                </div>
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-xs text-muted-foreground">声明模型 ID</span>
                  <div className="flex flex-wrap gap-1.5">
                    {validatedResult.modelIds.length > 0 ? (
                      validatedResult.modelIds.map((mId) => (
                        <Badge key={mId} tone="info" className="font-mono">
                          {mId}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">未声明预设模型</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-xs text-muted-foreground">允许访问的外部域名 (allowedHosts)</span>
                  <div className="flex flex-wrap gap-1.5">
                    {validatedResult.allowedHosts.length > 0 ? (
                      validatedResult.allowedHosts.map((host) => (
                        <Badge key={host} tone="neutral" variant="outline" className="font-mono">
                          {host}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">无</span>
                    )}
                  </div>
                </div>
              </div>

              {validatedResult.warnings.length > 0 ? (
                <FindingsList findings={validatedResult.warnings} title="非阻断扫描警告" />
              ) : null}
            </div>
          ) : null}
        </div>
      </Dialog>

      {/* 插件文档弹窗 */}
      <Dialog
        open={Boolean(docsPlugin)}
        onClose={() => setDocsPlugin(null)}
        size="wide"
        title={docsPlugin ? `插件文档：${docsPlugin.displayName}` : '插件文档'}
        description={
          docsPlugin ? `${docsPlugin.pluginId}@${docsPlugin.pluginVersion}` : undefined
        }
        footer={
          <Button variant="secondary" onClick={() => setDocsPlugin(null)}>
            关闭
          </Button>
        }
      >
        {docsQuery.isPending ? (
          <div className="flex flex-col gap-3 py-4">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : docsQuery.isError ? (
          <Alert tone="danger" title="加载插件文档失败">
            {formatPluginError(docsQuery.error)}
          </Alert>
        ) : (
          <Tabs
            aria-label="插件包内文档"
            tabs={docTabs}
            value={activeDocTab}
            onChange={setActiveDocTab}
          />
        )}
      </Dialog>

      {/* 删除插件确认弹窗 */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="确认删除插件"
        description={
          deleteTarget
            ? `即将移除插件「${deleteTarget.displayName}」(${deleteTarget.pluginId}@${deleteTarget.pluginVersion})。`
            : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              onClick={() => void handleConfirmDelete()}
            >
              确认删除
            </Button>
          </>
        }
      >
        {deleteError ? (
          <Alert tone="danger" role="alert" title="无法删除该插件">
            {deleteError}
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            若当前仍有模型或凭据引用该插件，后端将返回 409 PLUGIN_IN_USE 拒绝删除。历史模型修订快照仍会安全保留其引用信息。
          </p>
        )}
      </Dialog>
    </div>
  )
}
