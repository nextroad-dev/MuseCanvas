'use client'

import { cn } from '@/shared/lib/cn'
import { adminTouchWrap, adminTouchTargetsSquare, adminPageActions, adminPageHeader, adminPageRoot } from '../lib/admin-layout'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminModel, ModelPreset, ProviderCredential, ReasoningEffort } from '@/shared/types'
import { credentialsForPreset, isCustomCredential } from '../lib/provider-templates'
import { requireAdminData } from '../lib/admin-query'
import { AdminQueryFeedback } from './admin-query-feedback'
import { AdminListToolbar } from './admin-list-toolbar'
import { AdminCredentialTable } from './admin-credential-table'
import { AdminProviderCredentialDialog } from './admin-provider-credential-dialog'
import { AdminInstalledPlugins } from './admin-installed-plugins'
import { AdminActionErrors } from './admin-confirm-dialog'
import { useAdminActions } from '../lib/use-admin-actions'
import { resolveAdminConcurrency } from '../lib/admin-settings-state'
import { AdminMobileRecords, AdminRecordDetailDialog, AdminRecordFields } from './admin-record-detail-dialog'
import { PlusIcon as Plus, ArrowClockwiseIcon as RefreshCw, TrashIcon as Trash2 } from '@phosphor-icons/react'
import {
  Alert,
  buttonVariants,
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
  SectionHeader,
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

const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'none', label: '不思考（none）' },
  { value: 'low', label: '低（low）' },
  { value: 'medium', label: '中（medium）' },
  { value: 'high', label: '高（high）' },
  { value: 'xhigh', label: '极高（xhigh）' },
]

const REASONING_EFFORT_LABEL: Record<string, string> = {
  none: '不思考',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
}

export function AdminLanguageModelsView() {
  const queryClient = useQueryClient()
  const recordListRef = useRef<HTMLDivElement | null>(null)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedCredentialId, setSelectedCredentialId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium')
  const [concurrencyLimit, setConcurrencyLimit] = useState('2')
  const concurrencyValidation = resolveAdminConcurrency(concurrencyLimit)
  const [actionError, setActionError] = useState('')
  const [detailModel, setDetailModel] = useState<AdminModel | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminModel | null>(null)
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

  const allModels = modelsData ?? []
  const allPresets = presetsData ?? []
  const allCredentials = credentialsData ?? []

  // This page is language-model only: rows and presets are scoped by kind, and
  // credentials are scoped to the plugin-less (adapter + API key) shape that
  // language presets bind through `credentialsForPreset`.
  const models = allModels.filter((m) => m.modelKind === 'language')
  const presets = allPresets.filter((p) => p.modelKind === 'language')
  const credentials = allCredentials.filter(isCustomCredential)

  const selectedPreset = presets.find((p) => p.id === selectedPresetId) || null
  const matchingCredentials = credentialsForPreset(credentials, selectedPreset)
  const selectedCredentialMissing = !selectedCredentialId

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

  // Credential usage across every model kind: a plugin-less credential may also
  // back a legacy image/video row, so the table reports all bindings.
  const linkedModelsByCredential: Record<string, string[]> = {}
  for (const m of allModels) {
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
      if (!res.success) throw new Error(res.error?.message || '更新状态失败')
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(API_ENDPOINTS.admin.model(id), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除模型失败')
      return res.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      if (concurrencyValidation.value === undefined) throw new Error(concurrencyValidation.error)
      if (!selectedPreset) throw new Error('请选择语言模型预设')
      // The API rejects a language model without a credential
      // (LANGUAGE_MODEL_CONFIG_INVALID), so the picker is mandatory here.
      if (!selectedCredentialId) throw new Error('语言模型必须关联供应商凭据')
      const res = await api<AdminModel>(API_ENDPOINTS.admin.models, {
        method: 'POST',
        body: {
          presetId: selectedPresetId,
          providerCredentialId: selectedCredentialId,
          concurrencyLimit: concurrencyValidation.value,
          reasoningEffort,
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

  function openCreateModal() {
    setActionError('')
    setSelectedPresetId('')
    setSelectedCredentialId('')
    setReasoningEffort('medium')
    setCreateModalOpen(true)
  }

  function pickPreset(presetId: string) {
    setSelectedPresetId(presetId)
    setSelectedCredentialId('')
    const preset = presets.find((p) => p.id === presetId)
    if (preset?.reasoningEffort) setReasoningEffort(preset.reasoningEffort)
  }

  const currentDetailModel = models.find((model) => model.id === detailModel?.id) ?? detailModel
  function requestDeleteModel(model: AdminModel) {
    setDeleteTarget(model)
  }
  function toggleModel(model: AdminModel, enabled: boolean) {
    return actions.run(model.id, model.displayName, () => toggleMutation.mutateAsync({ id: model.id, enabled }), enabled ? '模型已启用' : '模型已停用', 'toggle')
  }

  return (
    <div className={adminPageRoot}>
      <PageHeader
        className={adminPageHeader}
        actionsClassName={adminPageActions}
        title="语言模型"
        description="配置语言模型与推理参数。"
        actions={
          <>
            <Button onClick={openCreateModal} icon={<Plus weight="bold" aria-hidden="true" />}>
              创建语言模型
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                refetchModels()
                refetchCredentials()
                refetchPresets()
              }}
              loading={modelsFetching || credentialsFetching || presetsFetching}
              icon={<RefreshCw weight="bold" aria-hidden="true" />}
            >
              刷新
            </Button>
          </>
        }
      />

      {modelsData !== undefined && <AdminQueryFeedback error={modelsQueryError} hasData label="语言模型" onRetry={() => refetchModels()} />}
      <AdminQueryFeedback error={presetsError} hasData={presetsData !== undefined} label="模型预设" onRetry={() => refetchPresets()} />
      {credentialsData !== undefined && <AdminQueryFeedback error={credentialsQueryError} hasData label="语言模型凭据" onRetry={() => refetchCredentials()} />}

      <AdminActionErrors errors={actions.errors} />
      <AdminListToolbar title="资源配置" description="先准备凭据，再从可用预设创建模型。插件版本与凭据绑定规则由服务端校验。"
        summary={`模型 ${models.length} 个 · 凭据 ${credentials.length} 个`}
        actions={<nav aria-label="资源分区" className="flex flex-wrap gap-2">
          <a href="#language-models" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>模型</a>
          <a href="#language-credentials" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>凭据</a>
          <a href="#installed-plugins-language" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>插件</a>
        </nav>} />

      <div id="language-models" ref={recordListRef} tabIndex={-1} role="region" aria-label="语言模型列表" className="flex min-w-0 flex-col gap-4 scroll-mt-6">
      <SectionHeader id="language-models-heading" title="已配置模型" description="协议、凭据与状态一览；推理参数和并发上限可在详情中查看。" />
      <AdminMobileRecords records={models} loading={modelsLoading}
        error={modelsError && modelsData === undefined ? modelsQueryError?.message || '加载模型失败' : null}
        onRetry={() => { void refetchModels() }}
        empty={<><span>创建模型前请先准备可用预设与凭据。</span><Button variant="secondary" onClick={openCreateModal}>创建模型</Button></>}
        title={(model) => model.displayName}
        status={(model) => <Badge tone={model.enabled ? 'success' : 'neutral'}>{model.enabled ? '已启用' : '已停用'}</Badge>}
        summary={(model) => <><span className="font-mono">{model.vendorModelId || model.name || '—'}</span> · 并发 {model.concurrencyLimit}</>}
        onDetails={setDetailModel}
      />

      <DataTable cardClassName="hidden @min-[800px]/admin:block" caption="语言模型列表" columns={5}>
        <TableHead>
          <TableHeadCell>模型名称</TableHeadCell>
          <TableHeadCell>协议</TableHeadCell>
          <TableHeadCell>关联凭据</TableHeadCell>
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
                  <SkeletonText key="protocol" width="6rem" />,
                  <SkeletonText key="credential" width="8rem" />,
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
                objectName="语言模型"
                title="无法加载语言模型"
                description={`${modelsQueryError?.message || '加载模型列表时出现问题'}。请检查后端服务状态后重试。`}
                action={<Button variant="secondary" onClick={() => refetchModels()}>刷新重试</Button>}
              />
            </TableStateRow>
          ) : models.length > 0 ? (
            models.map((m) => (
              <TableRow key={m.id}>
                <TableCell tone="strong">
                  <Button variant="ghost" size="sm" className="max-w-full whitespace-normal break-words text-left" onClick={() => setDetailModel(m)} aria-label={`查看模型 ${m.displayName} 详情`}>{m.displayName}</Button>
                  <div className="font-mono text-xs font-normal text-muted-foreground">
                    {m.vendorModelId || m.name || '-'}
                  </div>
                </TableCell>
                <TableCell mono textSize="xs" tone="muted">
                  {m.languageProtocol || '-'}
                </TableCell>
                <TableCell>
                  {m.providerCredentialName ? (
                    <span>{m.providerCredentialName}</span>
                  ) : (
                    <Badge tone="danger">未关联凭据</Badge>
                  )}
                </TableCell>
                {/* Immediate setting: the Switch reverts itself when the PATCH rejects,
                    and the banner above states the reason. */}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={m.enabled}
                      disabled={actions.isToggleBlocked(m.id)}
                      onCheckedChange={(enabled) => toggleModel(m, enabled)}
                      aria-label={`语言模型 ${m.displayName} 启用状态`}
                    />
                    <span className="text-xs text-muted-foreground">{m.enabled ? '已启用' : '已停用'}</span>
                  </div>
                </TableCell>
                <TableCell align="right">
                  <IconButton
                    className="min-h-[var(--control-md)] min-w-[var(--control-md)]"
                    variant="danger-ghost"
                    size="sm"
                    disabled={actions.isPending(m.id)}
                    onClick={() => requestDeleteModel(m)}
                    aria-label={`删除语言模型 ${m.displayName}`}
                    icon={<Trash2 weight="bold" aria-hidden="true" />}
                  />
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableStateRow>
              <EmptyState
                variant="first-use"
                density="compact"
                objectName="语言模型"
                title="还没有配置语言模型"
                description="在这里可以创建、启停和删除语言模型；推理参数在创建时选择。请先在下方创建凭据，再点击「创建语言模型」。"
                action={
                  <Button onClick={openCreateModal}>创建第一个语言模型</Button>
                }
              />
            </TableStateRow>
          )}
        </TableBody>
      </DataTable>
      </div>

      <section id="language-credentials" className="flex min-w-0 flex-col gap-4 scroll-mt-6" aria-labelledby="language-credentials-heading">
        <SectionHeader
        className={adminTouchWrap}
          id="language-credentials-heading"
          title="语言模型凭据"
          description="语言模型使用供应商账号凭据（openai / anthropic + API Key，可填写兼容端点）。图像与视频凭据从插件模板创建，请在「媒体模型」页配置；未经插件模板创建的自定义媒体凭据同样列在此处。"
          actions={
            <Button variant="secondary" onClick={() => setCredentialDialogOpen(true)} icon={<Plus weight="bold" aria-hidden="true" />}>
              创建凭据
            </Button>
          }
        />

        <AdminCredentialTable
          credentials={credentials}
          isLoading={credentialsLoading}
          variant="language"
          linkedModels={linkedModelsByCredential}
          emptyText="在这里可以创建、启停、连通测试和删除语言模型凭据。点击右上角「创建凭据」开始。"
          error={credentialsError && credentialsData === undefined ? credentialsQueryError?.message || '加载凭据列表失败' : null}
          onRetry={() => refetchCredentials()}
        />
      </section>

      <AdminInstalledPlugins kind="language" />

      <Dialog
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="创建新语言模型"
        panelClassName={cn('max-w-form max-h-[90dvh]', adminTouchTargetsSquare)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateModalOpen(false)}>
              取消
            </Button>
            <Button
              type="submit"
              loading={createMutation.isPending}
              disabled={!selectedPreset || selectedCredentialMissing || credentialUnavailable || !!concurrencyValidation.error}
              form="admin-create-language-model-form"
            >
              创建模型
            </Button>
          </>
        }
      >
        <form id="admin-create-language-model-form" className="flex min-w-0 flex-col gap-6" onSubmit={(event) => { event.preventDefault(); if (!createMutation.isPending && concurrencyValidation.value !== undefined) createMutation.mutate() }}>
          {actionError && (
            <Alert tone="danger" role="alert" title="无法创建语言模型">
              {actionError}。请选择预设并关联可用凭据后重试。
            </Alert>
          )}

          <Alert tone="info" title="创建前准备">选择服务端预设并关联匹配的凭据；如未配置凭据，请先返回「语言模型凭据」分区创建。本次创建不执行连通测试。</Alert>
          <FieldGroup>
            <FormField
              label="选择语言模型预设"
              required
              hint={presets.length === 0 ? '当前没有可用的语言模型预设。' : '预设由服务端注册，决定输出上限与温度。'}
            >
              <Select value={selectedPresetId} onChange={(e) => pickPreset(e.target.value)}>
                <option value="">请选择预设</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({p.vendorModelId})
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="关联供应商凭据"
              required
              hint={
                selectedPreset ? (
                  <>
                    按供应商 <span className="font-mono text-foreground">{selectedPreset.adapter || '-'}</span> 匹配凭据
                    {matchingCredentials.length === 0 ? '，当前无可用凭据，请在下方「语言模型凭据」区创建凭据' : ''}
                  </>
                ) : undefined
              }
            >
              <Select
                value={selectedCredentialId}
                onChange={(e) => setSelectedCredentialId(e.target.value)}
                disabled={!selectedPreset}
              >
                <option value="">{selectedPreset ? '请选择凭据' : '请先选择预设'}</option>
                {matchingCredentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.providerId || c.adapter})
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField
              label="思考等级"
              hint={
                <>
                  预设默认值：
                  {selectedPreset?.reasoningEffort
                    ? REASONING_EFFORT_LABEL[selectedPreset.reasoningEffort] ?? selectedPreset.reasoningEffort
                    : 'medium'}
                  ；输出上限与温度由预设决定。
                </>
              }
            >
              <Select
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
              >
                {REASONING_EFFORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>

            <FormField label="并发执行限制"
              error={concurrencyValidation.error} hint="同时运行的该模型任务数量上限，取值范围 1–50。">
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
            { label: '供应商模型标识', value: <span className="font-mono">{currentDetailModel.vendorModelId || currentDetailModel.name || '—'}</span> },
            { label: '协议', value: currentDetailModel.languageProtocol || '—' },
            { label: '输出上限', value: currentDetailModel.maxOutputTokens ?? '—' },
            { label: '思考等级', value: currentDetailModel.reasoningEffort ? REASONING_EFFORT_LABEL[currentDetailModel.reasoningEffort] ?? currentDetailModel.reasoningEffort : '—' },
            { label: '温度', value: currentDetailModel.temperature ?? '—' },
            { label: '关联凭据', value: currentDetailModel.providerCredentialName || '未关联凭据' },
            { label: '并发上限', value: currentDetailModel.concurrencyLimit },
            { label: '状态', value: currentDetailModel.enabled ? '已启用' : '已停用' },
          ]} />
          {actions.errors[currentDetailModel.id] && <Alert tone="danger" role="alert">{actions.errors[currentDetailModel.id]}</Alert>}
        </>}
      </AdminRecordDetailDialog>

      <AdminProviderCredentialDialog
        open={credentialDialogOpen}
        onClose={() => setCredentialDialogOpen(false)}
        scope="language"
      />
    </div>
  )
}
