'use client'

import { adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS, validateModelCapabilities } from '@musecanvas/contracts'
import type { MediaModelDefaultsDto } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminModel, BuiltinProviderTemplate, ModelPreset, ProviderCredential } from '@/shared/types'
import { credentialsForPreset, presetPluginKey } from '../lib/provider-templates'
import { requireAdminData } from '../lib/admin-query'
import {
  MEDIA_MODEL_DEFAULTS_QUERY_KEY,
  isModelDefault,
  mediaDefaultKindOf,
  rewriteDefaultInUseError,
  type MediaDefaultKind,
} from '../lib/admin-media-model-defaults'
import { AdminMediaModelDefaults } from './admin-media-model-defaults'
import { AdminQueryFeedback } from './admin-query-feedback'
import { AdminActionErrors } from './admin-confirm-dialog'
import { useAdminActions } from '../lib/use-admin-actions'
import { AdminRecordDetailDialog, AdminRecordFields } from './admin-record-detail-dialog'
import { PlusIcon as Plus, ArrowClockwiseIcon as RefreshCw, TrashIcon as Trash2 } from '@phosphor-icons/react'
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  FieldGroup,
  FormField,
  IconButton,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
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
} from '@/shared/components/ui'

const MEDIA_KIND_LABEL: Record<'image' | 'video', string> = {
  image: '图像',
  video: '视频',
}

const TAB_ITEMS = [
  { value: 'media-models', label: '媒体模型' },
  { value: 'model-presets', label: '模型预设' },
  { value: 'media-credentials', label: '媒体凭据' },
  { value: 'provider-plugins', label: '供应商插件' },
]

export function AdminMediaModelsView() {
  const queryClient = useQueryClient()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedCredentialId, setSelectedCredentialId] = useState('')
  const [concurrencyLimit, setConcurrencyLimit] = useState('1')
  const [actionError, setActionError] = useState('')
  const [detailModel, setDetailModel] = useState<AdminModel | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminModel | null>(null)
  const [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video'>('all')
  const actions = useAdminActions()

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
    isFetching: credentialsFetching,
    error: credentialsQueryError,
    refetch: refetchCredentials,
  } = useQuery({
    queryKey: ['admin', 'provider-credentials'],
    queryFn: async () => {
      const res = await api<ProviderCredential[]>(API_ENDPOINTS.admin.providerCredentials)
      return requireAdminData(res, '加载凭据列表失败')
    },
    refetchInterval: (query) => (query.state.data?.some((c) => c.lastTestStatus === 'pending') ? 2000 : false),
  })

  const {
    data: templatesData,
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

  const models = allModels.filter((m) => m.modelKind !== 'language')
  const modelContractFindings = useMemo(
    () =>
      new Map(
        models.map((model) => [
          model.id,
          validateModelCapabilities(
            model.capabilities ?? {
              modes: model.modes,
              parameters: model.parameters,
              inputSlots: model.inputSlots,
              defaults: model.defaults,
              flags: model.flags,
              crossFieldConstraints: model.crossFieldConstraints,
            },
          ).findings,
        ]),
      ),
    [models],
  )
  const presets = allPresets.filter((p) => p.modelKind !== 'language')
  const visibleModels = kindFilter === 'all' ? models : models.filter((m) => mediaKind(m) === kindFilter)

  const selectedPreset = presets.find((p) => p.id === selectedPresetId) || null
  const selectedPresetPluginKey = presetPluginKey(selectedPreset)
  const selectedTemplate =
    templates.find(
      (t) => t.pluginId === selectedPreset?.pluginId && t.pluginVersion === selectedPreset?.pluginVersion,
    ) ?? null
  const matchingCredentials = credentialsForPreset(allCredentials, selectedPreset, selectedTemplate)

  const presetUnavailable = !!selectedPresetId && presetsData !== undefined && !presetsError && !selectedPreset
  const credentialUnavailable =
    !!selectedCredentialId &&
    credentialsData !== undefined &&
    !credentialsQueryError &&
    !!selectedPreset &&
    !matchingCredentials.some((credential) => credential.id === selectedCredentialId)
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

  const createMutation = useMutation({
    mutationFn: async () => {
      const concurrencyValue = Number.parseInt(concurrencyLimit, 10)
      if (!Number.isFinite(concurrencyValue) || concurrencyValue < 1 || concurrencyValue > 50) {
        throw new Error('并发执行限制必须是 1–50 的整数')
      }
      if (!selectedPreset) throw new Error('请选择模型预设')
      const res = await api<AdminModel>(API_ENDPOINTS.admin.models, {
        method: 'POST',
        body: {
          presetId: selectedPresetId,
          providerCredentialId: selectedCredentialId || undefined,
          concurrencyLimit: concurrencyValue,
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

  function mediaKind(model: AdminModel): 'image' | 'video' {
    return model.modelKind === 'video' ? 'video' : 'image'
  }

  const currentDetailModel = models.find((model) => model.id === detailModel?.id) ?? detailModel
  function requestDeleteModel(model: AdminModel) {
    setDeleteTarget(model)
  }
  function toggleModel(model: AdminModel, enabled: boolean) {
    return actions.run(
      model.id,
      model.displayName,
      () => toggleMutation.mutateAsync({ id: model.id, enabled }),
      enabled ? '模型已启用' : '模型已停用',
      'toggle',
    )
  }

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="媒体模型"
        actions={
          <>
            <Button
              onClick={() => {
                setActionError('')
                setCreateModalOpen(true)
              }}
              icon={<Plus weight="bold" aria-hidden="true" />}
            >
              创建媒体模型
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

      {modelsData !== undefined && (
        <AdminQueryFeedback error={modelsQueryError} hasData label="媒体模型" onRetry={() => refetchModels()} />
      )}
      {defaultsData !== undefined && (
        <AdminQueryFeedback error={defaultsError} hasData label="默认模型" onRetry={() => refetchDefaults()} />
      )}
      <AdminQueryFeedback error={presetsError} hasData={presetsData !== undefined} label="模型预设" onRetry={() => refetchPresets()} />
      {credentialsData !== undefined && (
        <AdminQueryFeedback error={credentialsQueryError} hasData label="媒体凭据" onRetry={() => refetchCredentials()} />
      )}
      {templatesData !== undefined && (
        <AdminQueryFeedback error={templatesError} hasData label="供应商插件" onRetry={() => refetchTemplates()} />
      )}

      <AdminActionErrors errors={actions.errors} />
      {models.some((model) => (modelContractFindings.get(model.id)?.length ?? 0) > 0) && (
        <Alert tone="danger" title="模型参数契约存在问题">
          以下模型的参数声明未通过现有契约校验：
          {models
            .filter((model) => (modelContractFindings.get(model.id)?.length ?? 0) > 0)
            .map((model) => model.displayName)
            .join('、')}
          。请打开模型详情查看具体问题；此页不自动修复或停用模型。
        </Alert>
      )}

      <SegmentedControl
        size="sm"
        label="资源分区"
        value="media-models"
        onChange={() => {}}
        items={TAB_ITEMS}
      />

      <AdminMediaModelDefaults models={models} />

      <section className="flex min-w-0 flex-col gap-4" aria-labelledby="media-models-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 id="media-models-heading" className="text-base font-bold text-foreground">
              已配置模型
            </h2>
            <span className="text-sm text-muted-foreground">{models.length}</span>
          </div>
          <SegmentedControl
            size="sm"
            label="按类型筛选模型"
            value={kindFilter}
            onChange={(value) => setKindFilter(value as 'all' | 'image' | 'video')}
            items={[
              { value: 'all', label: '全部' },
              { value: 'image', label: '图像' },
              { value: 'video', label: '视频' },
            ]}
          />
        </div>

        <DataTable cardClassName="block" caption="图像与视频模型列表" columns={6}>
          <TableHead>
            <TableHeadCell>模型</TableHeadCell>
            <TableHeadCell>类型</TableHeadCell>
            <TableHeadCell>凭据</TableHeadCell>
            <TableHeadCell align="right">并发</TableHeadCell>
            <TableHeadCell>状态</TableHeadCell>
            <TableHeadCell align="right"></TableHeadCell>
          </TableHead>
          <TableBody busy={modelsLoading}>
            {modelsLoading ? (
              Array.from({ length: 3 }, (_, index) => (
                <TableSkeletonRow
                  key={index}
                  cells={[
                    <div key="name" className="flex flex-col gap-1">
                      <SkeletonText width="9rem" />
                      <SkeletonText width="6rem" />
                    </div>,
                    <SkeletonTile key="kind" className="aspect-auto h-6 w-12 rounded-pill" />,
                    <SkeletonText key="credential" width="8rem" />,
                    { align: 'right', content: <SkeletonText width="3rem" className="ml-auto" /> },
                    <div key="status" className="flex items-center gap-2">
                      <SkeletonTile className="aspect-auto h-5 w-9 rounded-pill" />
                      <SkeletonText width="3rem" />
                    </div>,
                    { align: 'right', content: <SkeletonTile className="aspect-auto h-8 w-16 rounded-control" /> },
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
                <TableRow key={m.id} hover>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{m.displayName}</span>
                      {isModelDefault(m.id, defaultsData) ? (
                        <Badge tone="neutral" variant="solid">默认</Badge>
                      ) : null}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {m.vendorModelId || m.name || '-'}
                    </div>
                    {(modelContractFindings.get(m.id)?.length ?? 0) > 0 && (
                      <Badge tone="danger" className="mt-1">参数契约异常</Badge>
                    )}
                  </TableCell>
                  <TableCell tone="foreground">{MEDIA_KIND_LABEL[mediaKind(m)]}</TableCell>
                  <TableCell>
                    {m.providerCredentialName ? (
                      <span className="text-muted-foreground">{m.providerCredentialName}</span>
                    ) : (
                      <Badge tone="danger">未关联凭据</Badge>
                    )}
                  </TableCell>
                  <TableCell align="right" tabular>
                    {m.concurrencyLimit}
                  </TableCell>
                  <TableCell>
                    <Badge tone={m.enabled ? 'success' : 'neutral'}>{m.enabled ? '启用' : '停用'}</Badge>
                  </TableCell>
                  <TableCell align="right">
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setDetailModel(m)}>
                        详情
                      </Button>
                      <IconButton
                        className="min-h-[var(--control-md)] min-w-[var(--control-md)]"
                        variant="danger-ghost"
                        size="sm"
                        disabled={actions.isPending(m.id)}
                        onClick={() => requestDeleteModel(m)}
                        aria-label={`删除模型 ${m.displayName}`}
                        icon={<Trash2 weight="bold" aria-hidden="true" />}
                      />
                    </div>
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
                  description="在这里可以创建、启停和删除图像与视频模型。点击右上角「创建媒体模型」开始。"
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
      </section>

      <Dialog
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="创建媒体模型"
        panelClassName="max-w-form max-h-[90dvh]"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateModalOpen(false)}>
              取消
            </Button>
            <Button
              type="submit"
              loading={createMutation.isPending}
              disabled={!selectedPreset || credentialUnavailable || !concurrencyLimit}
              form="admin-create-media-model-form"
            >
              创建模型
            </Button>
          </>
        }
      >
        <form
          id="admin-create-media-model-form"
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            if (!createMutation.isPending) createMutation.mutate()
          }}
        >
          {actionError && (
            <Alert tone="danger" role="alert" title="无法创建模型">
              {actionError}。请选择预设并确认凭据可用后重试。
            </Alert>
          )}

          <Alert tone="info" title="创建前准备">
            模型来自实际可用预设；凭据按供应商和插件声明匹配。未关联凭据的配置仍可创建，但生成任务将因缺少凭据失败，请先在资源分区准备凭据。
          </Alert>
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
                      <>
                        需要供应商 <span className="font-mono text-foreground">{selectedPreset.providerId || '-'}</span> 的凭据（插件{' '}
                        <span className="font-mono text-foreground">{selectedPresetPluginKey}</span>）
                      </>
                    ) : (
                      <>
                        按适配协议 <span className="font-mono text-foreground">{selectedPreset.adapter || '-'}</span> 匹配凭据
                      </>
                    )}
                    {matchingCredentials.length === 0
                      ? '，当前无可用凭据，请在「供应商插件目录」创建凭据'
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

            <FormField label="并发执行限制" hint="同时运行的该模型任务数量上限，取值范围 1–50。">
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

      <AdminRecordDetailDialog
        open={currentDetailModel !== null || deleteTarget !== null}
        onClose={() => {
          setDetailModel(null)
          setDeleteTarget(null)
        }}
        title="模型详情"
        confirmation={
          deleteTarget
            ? {
                objectName: `${deleteTarget.displayName}（${deleteTarget.id}）`,
                impact:
                  '删除后无法再通过此模型配置创建新任务；关联凭据及历史任务的处理、引用限制以服务端规则为准。此操作不可撤销。',
                pending: actions.isPending(deleteTarget.id),
                error: actions.errors[deleteTarget.id],
                cancelLabel: currentDetailModel ? '返回详情' : '取消',
                onCancel: () => setDeleteTarget(null),
                onConfirm: () => {
                  if (!deleteTarget || actions.isPending(deleteTarget.id)) return
                  const target = deleteTarget
                  void actions
                    .run(target.id, target.displayName, () => deleteMutation.mutateAsync(target.id), '模型已删除', 'delete')
                    .then(() => {
                      setDeleteTarget((current) => (current?.id === target.id ? null : current))
                      setDetailModel((current) => (current?.id === target.id ? null : current))
                    })
                    .catch(() => {})
                },
              }
            : undefined
        }
        actions={
          currentDetailModel && (
            <>
              <Switch
                checked={currentDetailModel.enabled}
                disabled={actions.isToggleBlocked(currentDetailModel.id)}
                onCheckedChange={(enabled) => toggleModel(currentDetailModel, enabled)}
                aria-label={`模型 ${currentDetailModel.displayName} 启用状态`}
              />
              <span>启用模型</span>
            </>
          )
        }
        danger={
          currentDetailModel && (
            <Button variant="danger-ghost" disabled={actions.isPending(currentDetailModel.id)} onClick={() => requestDeleteModel(currentDetailModel)}>
              删除模型
            </Button>
          )
        }
      >
        {currentDetailModel && (
          <>
            <AdminRecordFields
              fields={[
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
              ]}
            />
            {(modelContractFindings.get(currentDetailModel.id)?.length ?? 0) > 0 && (
              <Alert tone="danger" title="参数契约校验未通过">
                <ul className="flex min-w-0 flex-col gap-2">
                  {modelContractFindings.get(currentDetailModel.id)?.map((finding, index) => (
                    <li key={`${finding.rule}-${index}`} className="break-words [overflow-wrap:anywhere]">
                      <span className="font-mono">{finding.rule}</span> · {finding.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <section className="flex min-w-0 flex-col gap-3" aria-label="模型参数声明">
              <h3 className="text-module">参数声明</h3>
              {Array.isArray(currentDetailModel.parameters) && currentDetailModel.parameters.length ? (
                <ul className="flex min-w-0 flex-col gap-2">
                  {currentDetailModel.parameters.map((parameter, index) => (
                    <li key={index} className="break-words text-sm [overflow-wrap:anywhere]">
                      {parameter && typeof parameter.name === 'string' ? (
                        <>
                          <span className="font-mono">{parameter.name}</span> · {String(parameter.type)}
                        </>
                      ) : (
                        '无效参数声明'
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">未声明可用参数。</p>
              )}
            </section>
            {actions.errors[currentDetailModel.id] && (
              <Alert tone="danger" role="alert">
                {actions.errors[currentDetailModel.id]}
              </Alert>
            )}
          </>
        )}
      </AdminRecordDetailDialog>
    </div>
  )
}
