'use client'

import { cn } from '@/shared/lib/cn'
import { adminTouchWrap, adminTouchTargetsSquare, adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import {
  useEffect, useRef, useState } from 'react'
import { useQuery,
  useMutation,
  useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS, validateModelCapabilities } from '@musecanvas/contracts'
import type { MediaModelDefaultsDto } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type {
  AdminModel,
  BuiltinProviderTemplate,
  ModelPreset,
  ProviderCredential,
  } from '@/shared/types'
import {
  credentialsForPreset,
  isCustomCredential,
  isPluginBoundCredential,
  presetPluginKey,
  templateConfiguredCount,
  } from '../lib/provider-templates'
import { requireAdminData } from '../lib/admin-query'
import {
  MEDIA_MODEL_DEFAULTS_QUERY_KEY,
  PUBLIC_MODELS_QUERY_KEY,
  defaultsPatchForKind,
  isModelDefault,
  mediaDefaultKindOf,
  patchMediaModelDefaults,
  rewriteDefaultInUseError,
  type MediaDefaultKind,
} from '../lib/admin-media-model-defaults'
import { AdminMediaModelDefaults } from './admin-media-model-defaults'
import { AdminQueryFeedback } from './admin-query-feedback'
import { AdminListToolbar } from './admin-list-toolbar'
import { AdminCredentialTable } from './admin-credential-table'
import { AdminProviderCredentialDialog } from './admin-provider-credential-dialog'
import { AdminInstalledPlugins } from './admin-installed-plugins'
import { AdminActionErrors } from './admin-confirm-dialog'
import { useAdminActions } from '../lib/use-admin-actions'
import { resolveAdminConcurrency } from '../lib/admin-settings-state'
import { AdminMobileRecords, AdminRecordDetailDialog, AdminRecordFields } from './admin-record-detail-dialog'
import { PuzzlePieceIcon as Blocks,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  TrashIcon as Trash2 } from '@phosphor-icons/react'
import {
  Alert,
  buttonVariants,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  FieldGroup,
  FormField,
  IconButton,
  Input,
  PageHeader,
  SectionHeader,
  Select,
  SegmentedControl,
  SkeletonText,
  SkeletonTile,
  Switch,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  TableSkeletonRow,
  TableStateRow,
  iconSize,
  useToast,
} from '@/shared/components/ui'

const MEDIA_KIND_LABEL: Record<'image' | 'video', string> = {
  image: '图像',
  video: '视频',
}

export function AdminMediaModelsView() {
  const queryClient = useQueryClient()
  const recordListRef = useRef<HTMLDivElement | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [lockedTemplate, setLockedTemplate] = useState<BuiltinProviderTemplate | null>(null)
  const [detailTemplate, setDetailTemplate] = useState<BuiltinProviderTemplate | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedCredentialId, setSelectedCredentialId] = useState('')
  const [concurrencyLimit, setConcurrencyLimit] = useState('1')
  const concurrencyValidation = resolveAdminConcurrency(concurrencyLimit)
  const [actionError, setActionError] = useState('')
  const [detailModel, setDetailModel] = useState<AdminModel | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminModel | null>(null)
  const [kindFilter, setKindFilter] = useState<'all' | MediaDefaultKind>('all')
  const actions = useAdminActions()
  const toast = useToast()

  const {
    data: modelsData,
    isLoading: modelsLoading,
    isFetching: modelsFetching,
    isError: modelsError,
    error: modelsQueryError,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: async () => {
      const res = await api<AdminModel[]>(API_ENDPOINTS.admin.models)
      return requireAdminData(res, '加载模型列表失败')
    },
  })

  const { data: presetsData, isFetching: presetsFetching, error: presetsError, refetch: refetchPresets } = useQuery({
    queryKey: ['admin', 'model-presets'],
    queryFn: async () => {
      const res = await api<ModelPreset[]>(API_ENDPOINTS.admin.modelPresets)
      return requireAdminData(res, '加载模型预设失败')
    },
  })

  const {
    data: credentialsData,
    isLoading: credentialsLoading,
    isFetching: credentialsFetching,
    isError: credentialsError,
    error: credentialsQueryError,
    refetch: refetchCredentials,
  } = useQuery({
    queryKey: ['admin', 'provider-credentials'],
    queryFn: async () => {
      const res = await api<ProviderCredential[]>(API_ENDPOINTS.admin.providerCredentials)
      return requireAdminData(res, '加载凭据列表失败')
    },
    // Connectivity tests settle in the worker; poll only while one is open.
    refetchInterval: (query) => (query.state.data?.some((c) => c.lastTestStatus === 'pending') ? 2000 : false),
  })

  const {
    data: templatesData,
    isLoading: templatesLoading,
    isFetching: templatesFetching,
    error: templatesError,
    refetch: refetchTemplates,
  } = useQuery({
    queryKey: ['admin', 'provider-templates'],
    queryFn: async () => {
      const res = await api<{ templates: BuiltinProviderTemplate[] }>(API_ENDPOINTS.admin.providerTemplates)
      return requireAdminData(res, '加载供应商插件失败').templates
    },
  })

  const allModels = modelsData ?? []
  const allPresets = presetsData ?? []
  const allCredentials = credentialsData ?? []
  const templates = templatesData ?? []

  const {
    data: defaultsData,
    error: defaultsError,
    refetch: refetchDefaults,
  } = useQuery({
    queryKey: MEDIA_MODEL_DEFAULTS_QUERY_KEY,
    queryFn: async () => {
      const res = await api<MediaModelDefaultsDto>(API_ENDPOINTS.admin.mediaModelDefaults)
      return requireAdminData(res, '加载默认模型失败')
    },
  })

  // This page owns everything media-shaped: image/video model rows, the plugin
  // directory that signs media credentials, and the plugin-bound credentials.
  const models = allModels.filter((m) => m.modelKind !== 'language')
  const modelContractFindings = new Map(models.map((model) => [model.id, validateModelCapabilities(model.capabilities ?? {
    modes: model.modes, parameters: model.parameters, inputSlots: model.inputSlots,
    defaults: model.defaults, flags: model.flags, crossFieldConstraints: model.crossFieldConstraints,
  }).findings]))
  const presets = allPresets.filter((p) => p.modelKind !== 'language')
  const mediaCredentials = allCredentials.filter(isPluginBoundCredential)
  const visibleModels = kindFilter === 'all' ? models : models.filter((m) => mediaKind(m) === kindFilter)

  const selectedPreset = presets.find((p) => p.id === selectedPresetId) || null
  const selectedPresetPluginKey = presetPluginKey(selectedPreset)
  // The template carries the plugin's endpoint policy, so the picker never offers
  // a credential the API would refuse to bind.
  const selectedTemplate = templates.find(
    (t) => t.pluginId === selectedPreset?.pluginId && t.pluginVersion === selectedPreset?.pluginVersion,
  ) ?? null
  const matchingCredentials = credentialsForPreset(allCredentials, selectedPreset, selectedTemplate)

  // Catalog invalidation may remove the selected plugin preset or its binding.
  // Failed refreshes retain the selection; only successful catalog data can clear it.
  const presetUnavailable = !!selectedPresetId && presetsData !== undefined && !presetsError && !selectedPreset
  const credentialUnavailable = !!selectedCredentialId && credentialsData !== undefined && !credentialsQueryError && !!selectedPreset && !matchingCredentials.some((credential) => credential.id === selectedCredentialId)
  useEffect(() => {
    if (presetUnavailable) {
      setSelectedPresetId('')
      setSelectedCredentialId('')
      setActionError('所选预设已不在当前可用目录中（插件可能已停用或删除），已清除选择。请重新选择预设。')
    } else if (credentialUnavailable) {
      setSelectedCredentialId('')
      setActionError('所选凭据已不可用或不再匹配当前预设，已清除选择。请重新选择凭据。')
    }
  }, [presetUnavailable, credentialUnavailable])

  const linkedModelsByCredential: Record<string, string[]> = {}
  for (const m of models) {
    if (!m.providerCredentialId) continue
    const list = linkedModelsByCredential[m.providerCredentialId] || []
    list.push(m.displayName)
    linkedModelsByCredential[m.providerCredentialId] = list
  }

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await api(API_ENDPOINTS.admin.model(id), {
        method: 'PATCH',
        body: { enabled },
      })
      if (!res.success) {
        const code = res.error?.code
        if (code === 'DEFAULT_MODEL_IN_USE') {
          const target = allModels.find((m) => m.id === id)
          const kind: MediaDefaultKind = target ? mediaDefaultKindOf(target) : 'image'
          throw Object.assign(new Error(rewriteDefaultInUseError(res.error, kind, '更新状态失败')), { code })
        }
        throw Object.assign(new Error(res.error?.message || '更新状态失败'), { code: code || 'INVALID_RESPONSE' })
      }
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(API_ENDPOINTS.admin.model(id), { method: 'DELETE' })
      if (!res.success) {
        const code = res.error?.code
        if (code === 'DEFAULT_MODEL_IN_USE') {
          const target = allModels.find((m) => m.id === id)
          const kind: MediaDefaultKind = target ? mediaDefaultKindOf(target) : 'image'
          throw Object.assign(new Error(rewriteDefaultInUseError(res.error, kind, '删除模型失败')), { code })
        }
        throw Object.assign(new Error(res.error?.message || '删除模型失败'), { code: code || 'INVALID_RESPONSE' })
      }
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
  })

  const setDefaultMutation = useMutation({
    mutationFn: async ({ kind, id }: { kind: MediaDefaultKind; id: string }) =>
      patchMediaModelDefaults(api, API_ENDPOINTS.admin.mediaModelDefaults, defaultsPatchForKind(kind, id)),
    onSuccess: async () => {
      toast.push({ variant: 'success', title: '默认模型已更新' })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PUBLIC_MODELS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: MEDIA_MODEL_DEFAULTS_QUERY_KEY }),
      ])
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      if (concurrencyValidation.value === undefined) throw new Error(concurrencyValidation.error)
      if (!selectedPreset) throw new Error('请选择模型预设')
      const res = await api<AdminModel>(API_ENDPOINTS.admin.models, {
        method: 'POST',
        body: {
          presetId: selectedPresetId,
          providerCredentialId: selectedCredentialId || undefined,
          concurrencyLimit: concurrencyValidation.value,
          enabled: true,
        },
      })
      if (!res.success) throw new Error(res.error?.message || '创建模型失败')
      return res.data
    },
    onSuccess: () => {
      setCreateModalOpen(false)
      setSelectedPresetId('')
      setSelectedCredentialId('')
      setActionError('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
    onError: (err: Error) => {
      setActionError(err.message || '创建模型失败')
    },
  })

  function openCreateDialog(template: BuiltinProviderTemplate | null) {
    setLockedTemplate(template)
    setCredentialDialogOpen(true)
  }

  function mediaKind(model: AdminModel): 'image' | 'video' {
    return model.modelKind === 'video' ? 'video' : 'image'
  }

  const currentDetailModel = models.find((model) => model.id === detailModel?.id) ?? detailModel
  function requestDeleteModel(model: AdminModel) {
    setDeleteTarget(model)
  }
  function toggleModel(model: AdminModel, enabled: boolean) {
    return actions.run(model.id, model.displayName, () => toggleMutation.mutateAsync({ id: model.id, enabled }), enabled ? '模型已启用' : '模型已停用', 'toggle')
  }
  function setDefaultModel(model: AdminModel) {
    const kind = mediaKind(model)
    return setDefaultMutation.mutateAsync({ kind, id: model.id })
  }

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="媒体模型"
        description="配置图像与视频模型、供应商插件目录与媒体凭据；语言模型请在「语言模型」页配置。"
        actions={
          <>
            <Button
              onClick={() => {
                setActionError('')
                setCreateModalOpen(true)
              }}
              icon={<Plus weight="bold" aria-hidden="true" />}
            >
              创建模型
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                refetchModels()
                refetchDefaults()
                refetchCredentials()
                refetchTemplates()
                refetchPresets()
              }}
              loading={modelsFetching || credentialsFetching || presetsFetching || templatesFetching}
              icon={<RefreshCw weight="bold" aria-hidden="true" />}
            >
              刷新
            </Button>
          </>
        }
      />

      {modelsData !== undefined && <AdminQueryFeedback error={modelsQueryError} hasData label="媒体模型" onRetry={() => refetchModels()} />}
      {defaultsData !== undefined && <AdminQueryFeedback error={defaultsError} hasData label="默认模型" onRetry={() => refetchDefaults()} />}
      <AdminQueryFeedback error={presetsError} hasData={presetsData !== undefined} label="模型预设" onRetry={() => refetchPresets()} />
      {credentialsData !== undefined && <AdminQueryFeedback error={credentialsQueryError} hasData label="媒体凭据" onRetry={() => refetchCredentials()} />}
      {templatesData !== undefined && <AdminQueryFeedback error={templatesError} hasData label="供应商插件" onRetry={() => refetchTemplates()} />}

      <AdminActionErrors errors={actions.errors} />
      {models.some((model) => (modelContractFindings.get(model.id)?.length ?? 0) > 0) && <Alert tone="danger" title="模型参数契约存在问题">以下模型的参数声明未通过现有契约校验：{models.filter((model) => (modelContractFindings.get(model.id)?.length ?? 0) > 0).map((model) => model.displayName).join('、')}。请打开模型详情查看具体问题；此页不自动修复或停用模型。</Alert>}
      <AdminListToolbar title="资源配置" description="先准备凭据，再从可用预设创建模型。插件版本与凭据绑定规则由服务端校验。"
        summary={`模型 ${models.length} 个 · 凭据 ${mediaCredentials.length} 个`}
        actions={<nav aria-label="资源分区" className="flex flex-wrap gap-2">
          <a href="#media-models" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>模型</a>
          <a href="#media-credentials" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>凭据</a>
          <a href="#media-plugin-directory" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>插件目录</a>
          <a href="#installed-plugins-media" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>上传版本</a>
        </nav>} />

      <AdminMediaModelDefaults models={models} />

      <div id="media-models" ref={recordListRef} tabIndex={-1} role="region" aria-label="媒体模型列表" className="flex min-w-0 flex-col gap-4 scroll-mt-6">
      <SectionHeader id="media-models-heading" title="已配置模型" description="查看图像与视频模型的绑定和状态；参数契约与并发上限在详情中展开。"
        actions={
          <SegmentedControl
            size="sm"
            label="按类型筛选模型"
            value={kindFilter}
            onChange={setKindFilter}
            items={[
              { value: 'all', label: `全部 ${models.length}` },
              { value: 'image', label: `图像 ${models.filter((m) => mediaKind(m) === 'image').length}` },
              { value: 'video', label: `视频 ${models.filter((m) => mediaKind(m) === 'video').length}` },
            ]}
          />
        }
      />
      {setDefaultMutation.isError ? (
        <Alert tone="danger" role="alert" title="无法设为默认">
          {(setDefaultMutation.error as Error)?.message || '设为默认失败，请重试。'}
        </Alert>
      ) : null}
      <AdminMobileRecords records={visibleModels} loading={modelsLoading}
        error={modelsError && modelsData === undefined ? modelsQueryError?.message || '加载模型失败' : null}
        onRetry={() => { void refetchModels() }}
        empty={<><span>{kindFilter === 'all' ? '创建模型前请先准备可用预设与凭据。' : `暂无${kindFilter === 'image' ? '图像' : '视频'}模型。`}</span><Button variant="secondary" onClick={() => { setActionError(''); setCreateModalOpen(true) }}>创建模型</Button></>}
        title={(model) => (<span className="inline-flex items-center gap-2">{model.displayName}{isModelDefault(model.id, defaultsData) ? <Badge tone="neutral" variant="solid">默认</Badge> : null}</span>)}
        status={(model) => <Badge tone={model.enabled ? 'success' : 'neutral'}>{model.enabled ? '已启用' : '已停用'}</Badge>}
        summary={(model) => <><span className="font-mono">{model.vendorModelId || model.name || '—'}</span> · 并发 {model.concurrencyLimit}{(modelContractFindings.get(model.id)?.length ?? 0) > 0 && <span className="mt-2 block text-danger">参数契约异常，请查看详情。</span>}</>}
        onDetails={setDetailModel}
      />

      <DataTable cardClassName="hidden @min-[800px]/admin:block" caption="图像与视频模型列表" columns={5}>
        <TableHead>
          <TableHeadCell>模型名称</TableHeadCell>
          <TableHeadCell>类型</TableHeadCell>
          <TableHeadCell>插件与凭据</TableHeadCell>
          <TableHeadCell>状态</TableHeadCell>
          <TableHeadCell align="right">操作</TableHeadCell>
        </TableHead>
        <TableBody busy={modelsLoading}>
          {modelsLoading ? (
            Array.from({ length: 3 }, (_, index) => (
              <TableSkeletonRow
                key={index}
                cells={[
                  <div key="name" className="flex flex-col gap-1"><SkeletonText width="9rem" /><SkeletonText width="6rem" /></div>,
                  <SkeletonTile key="kind" className="aspect-auto h-6 w-12 rounded-pill" />,
                  <div key="binding" className="flex flex-col gap-2"><SkeletonText width="8rem" /><SkeletonText width="8rem" /></div>,
                  <div key="status" className="flex items-center gap-2"><SkeletonTile className="aspect-auto h-5 w-9 rounded-pill" /><SkeletonText width="3rem" /></div>,
                  { align: 'right', content: <SkeletonTile className="aspect-auto h-8 w-8 rounded-control" /> },
                ]}
              />
            ))
          ) : modelsError && modelsData === undefined ? (
            <TableStateRow>
              <EmptyState
                variant="error"
                density="compact"
                objectName="媒体模型"
                title="无法加载媒体模型"
                description={`${modelsQueryError?.message || '加载模型列表时出现问题'}。请检查后端服务状态后重试。`}
                action={<Button variant="secondary" onClick={() => refetchModels()}>刷新重试</Button>}
              />
            </TableStateRow>
          ) : visibleModels.length > 0 ? (
            visibleModels.map((m) => (
              <TableRow key={m.id}>
                <TableCell tone="strong">
                  <span className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" className="max-w-full whitespace-normal break-words text-left" onClick={() => setDetailModel(m)} aria-label={`查看模型 ${m.displayName} 详情`}>{m.displayName}</Button>
                    {isModelDefault(m.id, defaultsData) ? <Badge tone="neutral" variant="solid">默认</Badge> : null}
                  </span>
                  <div className="font-mono text-xs font-normal text-muted-foreground">
                    {m.vendorModelId || m.name || '-'}
                  </div>
                  {(modelContractFindings.get(m.id)?.length ?? 0) > 0 && <Badge tone="danger">参数契约异常</Badge>}
                </TableCell>
                <TableCell>
                  <Badge tone="neutral">{MEDIA_KIND_LABEL[mediaKind(m)]}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="break-all font-mono text-xs text-muted-foreground">{m.pluginId && m.pluginVersion ? `${m.pluginId}@${m.pluginVersion}` : '无绑定插件'}</span>
                    {m.providerCredentialName ? <span>{m.providerCredentialName}</span> : <Badge tone="danger">未关联凭据</Badge>}
                  </div>
                </TableCell>
                {/* Immediate setting: the Switch reverts itself when the PATCH rejects,
                    and the banner above states the reason. */}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={m.enabled}
                      disabled={actions.isToggleBlocked(m.id)}
                      onCheckedChange={(enabled) => toggleModel(m, enabled)}
                      aria-label={`模型 ${m.displayName} 启用状态`}
                    />
                    <span className="text-xs text-muted-foreground">{m.enabled ? '已启用' : '已停用'}</span>
                  </div>
                </TableCell>
                <TableCell align="right">
                  <span className="inline-flex items-center gap-1">
                    {m.enabled && !isModelDefault(m.id, defaultsData) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={setDefaultMutation.isPending || actions.isPending(m.id)}
                        onClick={() => { void setDefaultModel(m) }}
                        aria-label={`将 ${m.displayName} 设为默认${MEDIA_KIND_LABEL[mediaKind(m)]}模型`}
                      >
                        设为默认
                      </Button>
                    ) : null}
                    <IconButton
                      className="min-h-[var(--control-md)] min-w-[var(--control-md)]"
                      variant="danger-ghost"
                      size="sm"
                      disabled={actions.isPending(m.id)}
                      onClick={() => requestDeleteModel(m)}
                      aria-label={`删除模型 ${m.displayName}`}
                      icon={<Trash2 weight="bold" aria-hidden="true" />}
                    />
                  </span>
                </TableCell>
              </TableRow>
            ))
          ) : models.length === 0 ? (
            <TableStateRow>
              <EmptyState
                variant="first-use"
                density="compact"
                objectName="媒体模型"
                title="还没有配置媒体模型"
                description="在这里可以创建、启停和删除图像与视频模型。点击右上角「创建模型」开始。"
                action={
                  <Button
                    onClick={() => {
                      setActionError('')
                      setCreateModalOpen(true)
                    }}
                  >
                    创建第一个模型
                  </Button>
                }
              />
            </TableStateRow>
          ) : (
            <TableStateRow>
              <EmptyState
                variant="no-results"
                density="compact"
                objectName="媒体模型"
                title={`暂无${kindFilter === 'image' ? '图像' : '视频'}模型`}
                description="当前筛选下没有模型。切换到其他类型或创建新模型。"
              />
            </TableStateRow>
          )}
        </TableBody>
      </DataTable>
      </div>

      <section id="media-credentials" className="flex min-w-0 flex-col gap-4 scroll-mt-6" aria-labelledby="media-credentials-heading">
        <SectionHeader
        className={adminTouchWrap}
          id="media-credentials-heading"
          title="媒体凭据"
          description="从插件模板创建的图像 / 视频凭据。语言模型与自定义凭据在「语言模型」页配置。"
          actions={
            <Button
              variant="secondary"
              onClick={() => openCreateDialog(null)}
              icon={<Plus weight="bold" aria-hidden="true" />}
            >
              创建凭据
            </Button>
          }
        />

        <AdminCredentialTable
          credentials={mediaCredentials}
          isLoading={credentialsLoading}
          variant="media"
          linkedModels={linkedModelsByCredential}
          emptyText="在这里可以创建、启停、连通测试和删除媒体凭据。请从插件目录为指定插件创建凭据。"
          error={credentialsError && credentialsData === undefined ? credentialsQueryError?.message || '加载凭据列表失败' : null}
          onRetry={() => refetchCredentials()}
        />
        {allCredentials.some(isCustomCredential) && (
          <p className="text-xs text-muted-foreground">
            另有 <span className="font-mono tabular-nums">{allCredentials.filter(isCustomCredential).length}</span>{' '}
            个未经插件模板创建的自定义 / 语言模型凭据，由「语言模型」页管理。
          </p>
        )}
      </section>

      <section id="media-plugin-directory" className="flex min-w-0 flex-col gap-4 scroll-mt-6" aria-labelledby="plugin-directory-heading">
        <SectionHeader
        className={adminTouchWrap}
          id="plugin-directory-heading"
          title="供应商插件目录"
          description="由 provider registry 提供的图像 / 视频插件目录（包含内置和已激活上传版本）。凭据属于供应商账号：从卡片「创建凭据」时按该插件声明的格式与端点校验，同一账号下的其它插件也可以使用。"
        />

        {templatesLoading ? (
          <div className="grid min-w-0 gap-4 @min-[640px]/admin:grid-cols-2" role="status" aria-busy="true">
            <span className="sr-only">正在加载供应商插件目录</span>
            {Array.from({ length: 2 }, (_, index) => (
              <Card key={index} density="compact" aria-hidden="true" className="h-full gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-2"><SkeletonText width="10rem" /><SkeletonText width="7rem" /></div>
                  <div className="flex flex-col items-end gap-2"><SkeletonTile className="aspect-auto h-6 w-12 rounded-pill" /><SkeletonTile className="aspect-auto h-6 w-24 rounded-pill" /></div>
                </div>
                <SkeletonText lines={2} />
                <SkeletonText width="16rem" />
                <SkeletonTile className="aspect-auto h-8 w-40 rounded-control" />
                <SkeletonTile className="mt-auto aspect-auto h-[var(--control-md)] w-full rounded-control" />
              </Card>
            ))}
          </div>
        ) : templatesError && templatesData === undefined ? (
          <Alert
            tone="danger"
            role="alert"
            title="无法加载供应商插件"
            action={
              <Button variant="secondary" size="sm" onClick={() => refetchTemplates()}>
                刷新重试
              </Button>
            }
          >
            {templatesError.message || '加载供应商插件失败'}。请检查后端服务状态后重试。
          </Alert>
        ) : templates.length === 0 ? (
          <Card density="compact">
            <EmptyState
              variant="first-use"
              density="compact"
              objectName="供应商插件"
              title="暂无已注册的供应商插件"
              description="内置插件由服务端 provider registry 注册；如需扩展，请在下方「已安装媒体插件」上传自定义插件。"
            />
          </Card>
        ) : (
          <div className="grid min-w-0 gap-4 @min-[640px]/admin:grid-cols-2">
            {templates.map((t) => {
              const configured = templateConfiguredCount(allCredentials, t)
              return (
                <Card key={t.key} density="compact" className="h-full">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Blocks weight="duotone" aria-hidden="true" className={`${iconSize.sm} shrink-0 text-muted-foreground`} />
                        <h3 className="min-w-0 break-words text-module [overflow-wrap:anywhere]">{t.displayName}</h3>
                      </div>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {t.pluginId}@{t.pluginVersion}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone="neutral">{t.modality === 'video' ? '视频' : '图像'}</Badge>
                      <Badge tone="neutral">{t.source === 'installed' ? '上传安装' : t.source === 'builtin' ? '内置' : '来源未标记'}</Badge>
                      <Badge tone={configured > 0 ? 'success' : 'danger'}>
                        {configured > 0 ? `已配置 ${configured} 个凭据` : '未配置凭据'}
                      </Badge>
                    </div>
                  </div>

                  {t.description && <p className="text-sm text-muted-foreground">{t.description}</p>}

                  <p className="break-words text-xs text-muted-foreground">供应商 <span className="font-mono">{t.providerId}</span> · {t.models.length} 个模型 · {t.credential.label}</p>
                  <Button variant="ghost" size="sm" className="self-start" onClick={() => setDetailTemplate(t)}>查看模型与凭据契约</Button>

                  <Button
                    variant="secondary"
                    fullWidth
                    className="mt-auto"
                    onClick={() => openCreateDialog(t)}
                    icon={<Plus weight="bold" aria-hidden="true" />}
                  >
                    创建凭据
                  </Button>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <AdminInstalledPlugins kind="media" />

      <Dialog open={detailTemplate !== null} onClose={() => setDetailTemplate(null)} title="供应商插件契约" size="wide"
        footer={<><Button variant="ghost" onClick={() => setDetailTemplate(null)}>关闭详情</Button>{detailTemplate && <Button variant="secondary" onClick={() => { const template = detailTemplate; setDetailTemplate(null); openCreateDialog(template) }}>从此插件创建凭据</Button>}</>}>
        {detailTemplate && <div className="flex min-w-0 flex-col gap-6">
          <AdminRecordFields fields={[
            { label: '名称', value: detailTemplate.displayName },
            { label: '插件版本', value: `${detailTemplate.pluginId}@${detailTemplate.pluginVersion}` },
            { label: '来源', value: detailTemplate.source === 'installed' ? '上传安装版本' : detailTemplate.source === 'builtin' ? '内置版本' : '目录未标记来源' },
            { label: '供应商', value: detailTemplate.providerId },
            { label: 'Base URL', value: detailTemplate.baseUrl },
            { label: '凭据格式', value: `${detailTemplate.credential.label} · ${detailTemplate.credential.schemaId}@${detailTemplate.credential.schemaVersion}` },
            { label: '端点策略', value: detailTemplate.credential.baseUrlPolicy },
            { label: '关联预设', value: detailTemplate.presetIds.join('、') || '无' },
          ]} />
          <div className="flex min-w-0 flex-col gap-3"><h3 className="text-module">支持模型</h3><ul className="flex min-w-0 flex-col gap-2">{detailTemplate.models.map((model) => <li key={model.id} className="break-words text-sm [overflow-wrap:anywhere]"><span className="font-mono">{model.id}</span>{model.name && <span className="ml-2 text-muted-foreground">{model.name}</span>}</li>)}</ul></div>
        </div>}
      </Dialog>

      <Dialog
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="创建媒体模型"
        panelClassName={cn('max-w-form max-h-[90dvh]', adminTouchTargetsSquare)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateModalOpen(false)}>
              取消
            </Button>
            <Button
              type="submit"
              loading={createMutation.isPending}
              disabled={!selectedPreset || credentialUnavailable || !!concurrencyValidation.error}
              form="admin-create-media-model-form"
            >
              创建模型
            </Button>
          </>
        }
      >
        <form id="admin-create-media-model-form" className="flex flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (!createMutation.isPending && concurrencyValidation.value !== undefined) createMutation.mutate() }}>
          {actionError && (
            <Alert tone="danger" role="alert" title="无法创建模型">
              {actionError}。请选择预设并确认凭据可用后重试。
            </Alert>
          )}

          <Alert tone="info" title="创建前准备">模型来自实际可用预设；凭据按供应商和插件声明匹配。未关联凭据的配置仍可创建，但生成任务将因缺少凭据失败，请先在资源分区准备凭据。</Alert>
          <FieldGroup>
            <FormField
              label="选择预设"
              required
              hint={presets.length === 0 ? '当前没有可用的图像或视频预设。' : '预设由服务端注册，决定可调用的模型标识与参数。'}
            >
              <Select
                value={selectedPresetId}
                onChange={(e) => {
                  setSelectedPresetId(e.target.value)
                  setSelectedCredentialId('')
                }}
              >
                <option value="">请选择预设</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({p.vendorModelId}) · {p.modelKind === 'video' ? '视频' : '图像'}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="关联供应商凭据"
              hint={
                selectedPreset ? (
                  <>
                    {selectedPresetPluginKey ? (
                      <>需要供应商 <span className="font-mono text-foreground">{selectedPreset.providerId || '-'}</span> 的凭据（插件 <span className="font-mono text-foreground">{selectedPresetPluginKey}</span>）</>
                    ) : (
                      <>按适配协议 <span className="font-mono text-foreground">{selectedPreset.adapter || '-'}</span> 匹配凭据</>
                    )}
                    {matchingCredentials.length === 0
                      ? '，当前无可用凭据，请在下方「供应商插件目录」创建凭据'
                      : ''}
                  </>
                ) : undefined
              }
            >
              <Select
                value={selectedCredentialId}
                onChange={(e) => setSelectedCredentialId(e.target.value)}
                disabled={!selectedPreset}
              >
                <option value="">{selectedPreset ? '未关联（任务将因缺少凭据失败）' : '请先选择预设'}</option>
                {matchingCredentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.providerId || c.adapter})
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="并发执行限制"
              error={concurrencyValidation.error}
              hint="同时运行的该模型任务数量上限，取值范围 1–50。"
            >
              <Input
                type="number"
                min="1"
                max="50"
                step="1"
                required
                value={concurrencyLimit}
                onChange={(e) => setConcurrencyLimit(e.target.value)}
              />
            </FormField>
          </FieldGroup>
        </form>
      </Dialog>

      <AdminRecordDetailDialog open={currentDetailModel !== null || deleteTarget !== null} onClose={() => { setDetailModel(null); setDeleteTarget(null) }} title="模型详情"
        listFocusRef={recordListRef}
        confirmation={deleteTarget ? {
          objectName: `${deleteTarget.displayName}（${deleteTarget.id}）`,
          impact: '删除后无法再通过此模型配置创建新任务；关联凭据及历史任务的处理、引用限制以服务端规则为准。此操作不可撤销。',
          pending: actions.isPending(deleteTarget.id),
          error: actions.errors[deleteTarget.id],
          cancelLabel: currentDetailModel ? '返回详情' : '取消',
          onCancel: () => setDeleteTarget(null),
          onConfirm: () => {
            if (!deleteTarget || actions.isPending(deleteTarget.id)) return
            const target = deleteTarget
            void actions.run(target.id, target.displayName, () => deleteMutation.mutateAsync(target.id), '模型已删除', 'delete')
              .then(() => {
                setDeleteTarget((current) => current?.id === target.id ? null : current)
                setDetailModel((current) => current?.id === target.id ? null : current)
              }).catch(() => {})
          },
        } : undefined}
        actions={currentDetailModel && <><Switch checked={currentDetailModel.enabled} disabled={actions.isToggleBlocked(currentDetailModel.id)}
          onCheckedChange={(enabled) => toggleModel(currentDetailModel, enabled)} aria-label={`模型 ${currentDetailModel.displayName} 启用状态`} /><span>启用模型</span></>}
        danger={currentDetailModel && <Button variant="danger-ghost" disabled={actions.isPending(currentDetailModel.id)} onClick={() => requestDeleteModel(currentDetailModel)}>删除模型</Button>}>
        {currentDetailModel && <>
          <AdminRecordFields fields={[
            { label: '模型名称', value: currentDetailModel.displayName },
            { label: '配置 ID', value: <span className="font-mono">{currentDetailModel.id}</span> },
            { label: '配置版本', value: currentDetailModel.revision ?? '—' },
            { label: '可用模式', value: Array.isArray(currentDetailModel.modes) ? currentDetailModel.modes.join('、') || '未声明' : '未声明' },
            { label: '输入槽位数', value: currentDetailModel.inputSlots?.length ?? 0 },
            { label: '供应商模型标识', value: <span className="font-mono">{currentDetailModel.vendorModelId || currentDetailModel.name || '—'}</span> },
            { label: '类型', value: MEDIA_KIND_LABEL[mediaKind(currentDetailModel)] },
            { label: '绑定插件', value: <span className="font-mono">{currentDetailModel.pluginId && currentDetailModel.pluginVersion ? `${currentDetailModel.pluginId}@${currentDetailModel.pluginVersion}` : '—'}</span> },
            { label: '关联凭据', value: currentDetailModel.providerCredentialName || '未关联凭据' },
            { label: '并发上限', value: currentDetailModel.concurrencyLimit },
            { label: '状态', value: currentDetailModel.enabled ? '已启用' : '已停用' },
          ]} />
          {(modelContractFindings.get(currentDetailModel.id)?.length ?? 0) > 0 && <Alert tone="danger" title="参数契约校验未通过"><ul className="flex min-w-0 flex-col gap-2">{modelContractFindings.get(currentDetailModel.id)?.map((finding, index) => <li key={`${finding.rule}-${index}`} className="break-words [overflow-wrap:anywhere]"><span className="font-mono">{finding.rule}</span> · {finding.message}</li>)}</ul></Alert>}
          <section className="flex min-w-0 flex-col gap-3" aria-label="模型参数声明"><h3 className="text-module">参数声明</h3>{Array.isArray(currentDetailModel.parameters) && currentDetailModel.parameters.length ? <ul className="flex min-w-0 flex-col gap-2">{currentDetailModel.parameters.map((parameter, index) => <li key={index} className="break-words text-sm [overflow-wrap:anywhere]">{parameter && typeof parameter.name === 'string' ? <><span className="font-mono">{parameter.name}</span> · {String(parameter.type)}</> : '无效参数声明'}</li>)}</ul> : <p className="text-sm text-muted-foreground">未声明可用参数。</p>}</section>
          {actions.errors[currentDetailModel.id] && <Alert tone="danger" role="alert">{actions.errors[currentDetailModel.id]}</Alert>}
        </>}
      </AdminRecordDetailDialog>

      <AdminProviderCredentialDialog
        open={credentialDialogOpen}
        onClose={() => setCredentialDialogOpen(false)}
        templates={templates}
        lockedTemplate={lockedTemplate}
        scope="media"
      />
    </div>
  )
}
