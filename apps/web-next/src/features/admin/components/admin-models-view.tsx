'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/services/api'
import type { AdminModel, ModelPreset, ProviderCredential } from '@/shared/types'
import { Cpu, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'

export function AdminModelsView() {
  const queryClient = useQueryClient()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [selectedCredentialId, setSelectedCredentialId] = useState('')
  const [creditsPerImage, setCreditsPerImage] = useState(1)
  const [concurrencyLimit, setConcurrencyLimit] = useState(2)
  const [actionError, setActionError] = useState('')

  const {
    data: models = [],
    isLoading: modelsLoading,
    refetch: refetchModels,
  } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: async () => {
      const res = await api<{ items: AdminModel[] }>('/api/admin/models')
      return res.data?.items || []
    },
  })

  const { data: presets = [] } = useQuery({
    queryKey: ['admin', 'model-presets'],
    queryFn: async () => {
      const res = await api<{ items: ModelPreset[] }>('/api/admin/model-presets')
      return res.data?.items || []
    },
  })

  const { data: credentials = [] } = useQuery({
    queryKey: ['admin', 'provider-credentials'],
    queryFn: async () => {
      const res = await api<{ items: ProviderCredential[] }>('/api/admin/provider-credentials')
      return res.data?.items || []
    },
  })

  // Toggle model enabled mutation
  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await api(`/api/admin/models/${id}`, {
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

  // Delete model mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(`/api/admin/models/${id}`, { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除模型失败')
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
  })

  // Create model mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPresetId) throw new Error('请选择模型预设')
      const res = await api<{ model: AdminModel }>('/api/admin/models', {
        method: 'POST',
        body: {
          presetId: selectedPresetId,
          providerCredentialId: selectedCredentialId || undefined,
          creditsPerImage,
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
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] })
    },
    onError: (err: any) => {
      setActionError(err.message || '创建模型失败')
    },
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">模型管理</h1>
          <p className="text-sm text-muted-foreground">配置图像与语言模型、消耗积分、并发限制与关联凭据。</p>
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
            <Plus className="h-3.5 w-3.5" />
            添加模型
          </button>
          <button
            type="button"
            onClick={() => refetchModels()}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">模型名称</th>
              <th className="px-4 py-3 font-medium">类型</th>
              <th className="px-4 py-3 font-medium">单次积分</th>
              <th className="px-4 py-3 font-medium">并发上限</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {modelsLoading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : models.length > 0 ? (
              models.map((m) => (
                <tr key={m.id} className="hover:bg-surface-subtle/50 transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">
                    <div>{m.displayName}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{m.name}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{m.modelKind || 'image'}</td>
                  <td className="px-4 py-3 font-mono">{m.creditsPerImage} 积分</td>
                  <td className="px-4 py-3 font-mono">{m.concurrencyLimit}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleMutation.mutate({ id: m.id, enabled: !m.enabled })}
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
                      className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-border p-1.5 text-danger hover:bg-danger-soft/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  暂无模型配置
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create Model Modal */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setCreateModalOpen(false)} />
          <div className="relative z-10 w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground">添加新模型</h3>
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {actionError && (
              <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger">
                {actionError}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-foreground mb-1">选择预设</label>
                <select
                  value={selectedPresetId}
                  onChange={(e) => setSelectedPresetId(e.target.value)}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                >
                  <option value="">请选择预设</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} ({p.name})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-foreground mb-1">关联供应商凭据</label>
                <select
                  value={selectedCredentialId}
                  onChange={(e) => setSelectedCredentialId(e.target.value)}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                >
                  <option value="">未关联（任务将因缺少凭据失败）</option>
                  {credentials.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName} ({c.provider})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">单张扣除积分</label>
                  <input
                    type="number"
                    min="0"
                    value={creditsPerImage}
                    onChange={(e) => setCreditsPerImage(parseInt(e.target.value, 10) || 0)}
                    className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">并发执行限制</label>
                  <input
                    type="number"
                    min="1"
                    value={concurrencyLimit}
                    onChange={(e) => setConcurrencyLimit(parseInt(e.target.value, 10) || 1)}
                    className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                  />
                </div>
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
                {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                创建模型
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
