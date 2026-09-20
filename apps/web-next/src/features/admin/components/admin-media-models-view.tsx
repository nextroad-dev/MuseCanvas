'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
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
import { AdminCredentialTable } from './admin-credential-table'
import { AdminProviderCredentialDialog } from './admin-provider-credential-dialog'
import { AdminInstalledPlugins } from './admin-installed-plugins'
import { Blocks, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'

const MEDIA_KIND_LABEL: Record<'image' | 'video', string> = {
  image: '图像',
  video: '视频',
}

export function AdminMediaModelsView() {
  const queryClient = useQueryClient()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [lockedTemplate, setLockedTemplate] = useState<BuiltinProviderTemplate | null>(null)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedCredentialId, setSelectedCredentialId] = useState('')
  const [concurrencyLimit, setConcurrencyLimit] = useState(1)
  const [actionError, setActionError] = useState('')

  const {
    data: allModels = [],
    isLoading: modelsLoading,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: async () => {
      const res = await api<AdminModel[]>(API_ENDPOINTS.admin.models)
      return res.data || []
    },
  })

  const { data: allPresets = [] } = useQuery({
    queryKey: ['admin', 'model-presets'],
    queryFn: async () => {
      const res = await api<ModelPreset[]>(API_ENDPOINTS.admin.modelPresets)
      return res.data || []
    },
  })

  const {
    data: allCredentials = [],
    isLoading: credentialsLoading,
    refetch: refetchCredentials,
  } = useQuery({
    queryKey: ['admin', 'provider-credentials'],
    queryFn: async () => {
      const res = await api<ProviderCredential[]>(API_ENDPOINTS.admin.providerCredentials)
      return res.data || []
    },
  })

  const {
    data: templates = [],
    isLoading: templatesLoading,
    error: templatesError,
    refetch: refetchTemplates,
  } = useQuery({
    queryKey: ['admin', 'provider-templates'],
    queryFn: async () => {
      const res = await api<{ templates: BuiltinProviderTemplate[] }>(API_ENDPOINTS.admin.providerTemplates)
      if (!res.success) throw new Error(res.error?.message || '加载供应商插件失败')
      return res.data?.templates || []
    },
  })

  // This page owns everything media-shaped: image/video model rows, the plugin
  // directory that signs media credentials, and the plugin-bound credentials.
  const models = allModels.filter((m) => m.modelKind !== 'language')
  const presets = allPresets.filter((p) => p.modelKind !== 'language')
  const mediaCredentials = allCredentials.filter(isPluginBoundCredential)

  const selectedPreset = presets.find((p) => p.id === selectedPresetId) || null
  const selectedPresetPluginKey = presetPluginKey(selectedPreset)
  const matchingCredentials = credentialsForPreset(allCredentials, selectedPreset)

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
      if (!res.success) throw new Error(res.error?.message || '更新状态失败')
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(API_ENDPOINTS.admin.model(id), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除模型失败')
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPresetId) throw new Error('请选择模型预设')
      const res = await api<AdminModel>(API_ENDPOINTS.admin.models, {
        method: 'POST',
        body: {
          presetId: selectedPresetId,
          providerCredentialId: selectedCredentialId || undefined,
          concurrencyLimit,
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">媒体模型</h1>
          <p className="text-sm text-muted-foreground">
            配置图像与视频模型、供应商插件目录与媒体凭据；语言模型请在「语言模型」页配置。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setActionError('')
              setCreateModalOpen(true)
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            添加模型
          </button>
          <button
            type="button"
            onClick={() => {
              refetchModels()
              refetchCredentials()
              refetchTemplates()
            }}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            刷新
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">图像与视频模型列表</caption>
          <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">模型名称</th>
              <th className="px-4 py-3 font-medium">类型</th>
              <th className="px-4 py-3 font-medium">绑定插件</th>
              <th className="px-4 py-3 font-medium">关联凭据</th>
              <th className="px-4 py-3 font-medium">并发上限</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {modelsLoading ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden="true" />
                  <span className="sr-only">正在加载媒体模型</span>
                </td>
              </tr>
            ) : models.length > 0 ? (
              models.map((m) => (
                <tr key={m.id} className="hover:bg-surface-subtle/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">
                    <div>{m.displayName}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {m.vendorModelId || m.name || '-'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded bg-surface-subtle px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {MEDIA_KIND_LABEL[mediaKind(m)]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                    {m.pluginId && m.pluginVersion ? `${m.pluginId}@${m.pluginVersion}` : '-'}
                  </td>
                  <td className="px-4 py-3">
                    {m.providerCredentialName ? (
                      <span className="text-foreground">{m.providerCredentialName}</span>
                    ) : (
                      <span className="inline-flex items-center rounded bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
                        未关联凭据
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">{m.concurrencyLimit}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleMutation.mutate({ id: m.id, enabled: !m.enabled })}
                      aria-label={m.enabled ? `停用模型 ${m.displayName}` : `启用模型 ${m.displayName}`}
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                        m.enabled
                          ? 'bg-success-soft text-success hover:bg-success-soft/80'
                          : 'bg-surface-subtle text-muted-foreground hover:bg-surface-subtle-strong'
                      }`}
                    >
                      {m.enabled ? '已启用' : '已停用'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`确认删除模型 ${m.displayName}？`)) {
                          deleteMutation.mutate(m.id)
                        }
                      }}
                      aria-label={`删除模型 ${m.displayName}`}
                      className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-border p-1.5 text-danger hover:bg-danger-soft/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="p-8 text-center text-muted-foreground">
                  暂无媒体模型配置
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <section className="space-y-3" aria-labelledby="plugin-directory-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="plugin-directory-heading" className="text-sm font-semibold text-foreground">
              供应商插件目录
            </h2>
            <p className="text-xs text-muted-foreground">
              由 provider registry 提供的内置图像 / 视频插件。媒体凭据必须绑定插件身份，否则无法通过连通测试；
              请使用卡片上的「新建凭据」为指定插件签发凭据。
            </p>
          </div>
        </div>

        {templatesLoading ? (
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
            <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden="true" />
            <span className="sr-only">正在加载供应商插件</span>
          </div>
        ) : templatesError ? (
          <div className="rounded-[var(--radius-card)] border border-danger-soft bg-danger-soft/20 p-4 text-xs text-danger" role="alert">
            {templatesError.message || '加载供应商插件失败'}
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
            暂无已注册的供应商插件
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {templates.map((t) => {
              const configured = templateConfiguredCount(allCredentials, t)
              return (
                <div
                  key={t.key}
                  className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Blocks className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <h3 className="truncate text-sm font-semibold text-foreground">{t.displayName}</h3>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {t.pluginId}@{t.pluginVersion}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="inline-flex items-center rounded bg-surface-subtle px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {t.modality === 'video' ? '视频' : '图像'}
                      </span>
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
                          configured > 0 ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
                        }`}
                      >
                        {configured > 0 ? `已配置 ${configured} 个凭据` : '未配置凭据'}
                      </span>
                    </div>
                  </div>

                  {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}

                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                    <dt className="text-muted-foreground">供应商</dt>
                    <dd className="font-mono text-foreground">{t.providerId}</dd>
                    <dt className="text-muted-foreground">适配器</dt>
                    <dd className="font-mono text-foreground">{t.adapter}</dd>
                    <dt className="text-muted-foreground">Base URL</dt>
                    <dd className="break-all font-mono text-foreground">{t.baseUrl}</dd>
                    <dt className="text-muted-foreground">凭据</dt>
                    <dd className="text-foreground">
                      {t.credential.label}
                      <span className="ml-1 font-mono text-muted-foreground">
                        {t.credential.schemaId}@{t.credential.schemaVersion}
                      </span>
                    </dd>
                  </dl>

                  <div className="space-y-1 text-[11px]">
                    <div className="text-muted-foreground">支持模型（{t.models.length}）</div>
                    <div className="flex flex-wrap gap-1">
                      {t.models.map((model) => (
                        <span
                          key={model.id}
                          className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-foreground"
                          title={model.name}
                        >
                          {model.id}
                        </span>
                      ))}
                    </div>
                  </div>

                  {t.presetIds.length > 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      关联预设：<span className="font-mono text-foreground">{t.presetIds.join(', ')}</span>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => openCreateDialog(t)}
                    className="mt-auto flex min-h-9 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    新建凭据
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <AdminInstalledPlugins kind="media" />

      <section className="space-y-3" aria-labelledby="media-credentials-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="media-credentials-heading" className="text-sm font-semibold text-foreground">
              媒体凭据
            </h2>
            <p className="text-xs text-muted-foreground">
              绑定插件身份的图像 / 视频凭据。语言模型使用的无插件凭据在「语言模型」页配置。
            </p>
          </div>
          <button
            type="button"
            onClick={() => openCreateDialog(null)}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            添加凭据
          </button>
        </div>

        <AdminCredentialTable
          credentials={mediaCredentials}
          isLoading={credentialsLoading}
          variant="media"
          linkedModels={linkedModelsByCredential}
          emptyText="暂无媒体凭据，请从上方插件目录新建凭据"
        />
        {allCredentials.some(isCustomCredential) && (
          <p className="text-[11px] text-muted-foreground">
            另有 {allCredentials.filter(isCustomCredential).length} 个无插件身份的自定义 / 语言模型凭据，由「语言模型」页管理。
          </p>
        )}
      </section>

      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setCreateModalOpen(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-media-model-title"
            className="relative z-10 w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 id="create-media-model-title" className="font-semibold text-foreground">添加新媒体模型</h3>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                aria-label="关闭"
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {actionError && (
              <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger" role="alert">
                {actionError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label htmlFor="media-model-preset" className="mb-1 block text-xs font-medium text-foreground">
                  选择预设
                </label>
                <select
                  id="media-model-preset"
                  value={selectedPresetId}
                  onChange={(e) => {
                    setSelectedPresetId(e.target.value)
                    setSelectedCredentialId('')
                  }}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                >
                  <option value="">请选择预设</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} ({p.vendorModelId}) · {p.modelKind === 'video' ? '视频' : '图像'}
                    </option>
                  ))}
                </select>
                {presets.length === 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">当前没有可用的图像或视频预设。</p>
                )}
              </div>

              <div>
                <label htmlFor="media-model-credential" className="mb-1 block text-xs font-medium text-foreground">
                  关联供应商凭据
                </label>
                <select
                  id="media-model-credential"
                  value={selectedCredentialId}
                  onChange={(e) => setSelectedCredentialId(e.target.value)}
                  disabled={!selectedPreset}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none disabled:opacity-60"
                >
                  <option value="">{selectedPreset ? '未关联（任务将因缺少凭据失败）' : '请先选择预设'}</option>
                  {matchingCredentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} ({c.providerId || c.adapter})
                    </option>
                  ))}
                </select>
                {selectedPreset && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {selectedPresetPluginKey ? (
                      <>需要插件 <span className="font-mono text-foreground">{selectedPresetPluginKey}</span> 的凭据</>
                    ) : (
                      <>按适配协议 <span className="font-mono text-foreground">{selectedPreset.adapter || '-'}</span> 匹配凭据</>
                    )}
                    {matchingCredentials.length === 0 && '，当前无可用凭据，请在下方「供应商插件目录」新建凭据'}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="media-model-concurrency" className="mb-1 block text-xs font-medium text-foreground">
                  并发执行限制
                </label>
                <input
                  id="media-model-concurrency"
                  type="number"
                  min="1"
                  max="50"
                  value={concurrencyLimit}
                  onChange={(e) => setConcurrencyLimit(parseInt(e.target.value, 10) || 1)}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-subtle"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !selectedPresetId}
                className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
              >
                {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                创建模型
              </button>
            </div>
          </div>
        </div>
      )}

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
