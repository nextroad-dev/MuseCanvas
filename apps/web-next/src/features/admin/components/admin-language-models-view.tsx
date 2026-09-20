'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { AdminModel, ModelPreset, ProviderCredential, ReasoningEffort } from '@/shared/types'
import { credentialsForPreset, isCustomCredential } from '../lib/provider-templates'
import { AdminCredentialTable } from './admin-credential-table'
import { AdminProviderCredentialDialog } from './admin-provider-credential-dialog'
import { AdminInstalledPlugins } from './admin-installed-plugins'
import { Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'

const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'none', label: '不思考 (none)' },
  { value: 'low', label: '低 (low)' },
  { value: 'medium', label: '中 (medium)' },
  { value: 'high', label: '高 (high)' },
  { value: 'xhigh', label: '极高 (xhigh)' },
]

export function AdminLanguageModelsView() {
  const queryClient = useQueryClient()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedCredentialId, setSelectedCredentialId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium')
  const [concurrencyLimit, setConcurrencyLimit] = useState(2)
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

  // This page is language-model only: rows and presets are scoped by kind, and
  // credentials are scoped to the plugin-less (adapter + API key) shape that
  // language presets bind through `credentialsForPreset`.
  const models = allModels.filter((m) => m.modelKind === 'language')
  const presets = allPresets.filter((p) => p.modelKind === 'language')
  const credentials = allCredentials.filter(isCustomCredential)

  const selectedPreset = presets.find((p) => p.id === selectedPresetId) || null
  const matchingCredentials = credentialsForPreset(credentials, selectedPreset)
  const selectedCredentialMissing = !selectedCredentialId

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
      if (!selectedPresetId) throw new Error('请选择语言模型预设')
      // The API rejects a language model without a credential
      // (LANGUAGE_MODEL_CONFIG_INVALID), so the picker is mandatory here.
      if (!selectedCredentialId) throw new Error('语言模型必须关联供应商凭据')
      const res = await api<AdminModel>(API_ENDPOINTS.admin.models, {
        method: 'POST',
        body: {
          presetId: selectedPresetId,
          providerCredentialId: selectedCredentialId,
          concurrencyLimit,
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">语言模型</h1>
          <p className="text-sm text-muted-foreground">配置语言模型与推理参数。</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={openCreateModal}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            添加语言模型
          </button>
          <button
            type="button"
            onClick={() => {
              refetchModels()
              refetchCredentials()
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
          <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">模型名称</th>
              <th className="px-4 py-3 font-medium">协议</th>
              <th className="px-4 py-3 font-medium">推理参数</th>
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
                  <span className="sr-only">正在加载语言模型</span>
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
                  <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                    {m.languageProtocol || '-'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                      <div>输出上限 {m.maxOutputTokens ?? '-'}</div>
                      <div>思考等级 {m.reasoningEffort || '-'}</div>
                      <div>温度 {m.temperature ?? '-'}</div>
                    </div>
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
                      aria-label={m.enabled ? `停用语言模型 ${m.displayName}` : `启用语言模型 ${m.displayName}`}
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
                        if (confirm(`确认删除语言模型 ${m.displayName}？`)) {
                          deleteMutation.mutate(m.id)
                        }
                      }}
                      aria-label={`删除语言模型 ${m.displayName}`}
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
                  暂无语言模型配置
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <section className="space-y-3" aria-labelledby="language-credentials-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="language-credentials-heading" className="text-sm font-semibold text-foreground">
              语言模型凭据
            </h2>
            <p className="text-xs text-muted-foreground">
              语言模型绑定无插件身份的自定义凭据（适配协议 openai / anthropic + API Key）。图像与视频凭据由
              供应商插件签发，请在「媒体模型」页配置；历史遗留的自定义媒体凭据同样列在此处。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCredentialDialogOpen(true)}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            添加凭据
          </button>
        </div>

        <AdminCredentialTable
          credentials={credentials}
          isLoading={credentialsLoading}
          variant="language"
          linkedModels={linkedModelsByCredential}
          emptyText="暂无语言模型凭据，请先添加凭据"
        />
      </section>

      <AdminInstalledPlugins kind="language" />

      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setCreateModalOpen(false)} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-language-model-title"
            className="relative z-10 w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 id="create-language-model-title" className="font-semibold text-foreground">添加新语言模型</h3>
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
                <label htmlFor="language-model-preset" className="mb-1 block text-xs font-medium text-foreground">
                  选择语言模型预设
                </label>
                <select
                  id="language-model-preset"
                  value={selectedPresetId}
                  onChange={(e) => pickPreset(e.target.value)}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                >
                  <option value="">请选择预设</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} ({p.vendorModelId})
                    </option>
                  ))}
                </select>
                {presets.length === 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">当前没有可用的语言模型预设。</p>
                )}
              </div>

              <div>
                <label htmlFor="language-model-credential" className="mb-1 block text-xs font-medium text-foreground">
                  关联供应商凭据（必填）
                </label>
                <select
                  id="language-model-credential"
                  value={selectedCredentialId}
                  onChange={(e) => setSelectedCredentialId(e.target.value)}
                  disabled={!selectedPreset}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none disabled:opacity-60"
                >
                  <option value="">{selectedPreset ? '请选择凭据' : '请先选择预设'}</option>
                  {matchingCredentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} ({c.providerId || c.adapter})
                    </option>
                  ))}
                </select>
                {selectedPreset && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    按适配协议 <span className="font-mono text-foreground">{selectedPreset.adapter || '-'}</span> 匹配凭据
                    {matchingCredentials.length === 0 && '，当前无可用凭据，请在下方「语言模型凭据」区新建'}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="language-model-reasoning" className="mb-1 block text-xs font-medium text-foreground">
                  思考等级
                </label>
                <select
                  id="language-model-reasoning"
                  value={reasoningEffort}
                  onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                >
                  {REASONING_EFFORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  预设默认值：{selectedPreset?.reasoningEffort || 'medium'}；输出上限与温度由预设决定。
                </p>
              </div>

              <div>
                <label htmlFor="language-model-concurrency" className="mb-1 block text-xs font-medium text-foreground">
                  并发执行限制
                </label>
                <input
                  id="language-model-concurrency"
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
                disabled={createMutation.isPending || !selectedPresetId || selectedCredentialMissing}
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
        scope="language"
      />
    </div>
  )
}
