'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { BuiltinProviderTemplate, ProviderCredential } from '@/shared/types'
import { AdminProviderCredentialDialog } from './admin-provider-credential-dialog'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'

export function AdminProvidersView() {
  const queryClient = useQueryClient()
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; msg: string } | null>(null)

  const {
    data: credentials = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['admin', 'provider-credentials'],
    queryFn: async () => {
      const res = await api<ProviderCredential[]>(API_ENDPOINTS.admin.providerCredentials)
      return res.data || []
    },
  })

  const { data: templates = [] } = useQuery({
    queryKey: ['admin', 'provider-templates'],
    queryFn: async () => {
      const res = await api<{ templates: BuiltinProviderTemplate[] }>(API_ENDPOINTS.admin.providerTemplates)
      return res.data?.templates || []
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(API_ENDPOINTS.admin.providerCredential(id), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除凭据失败')
      return res.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
    },
  })

  async function handleTest(id: string) {
    setTestingId(id)
    setTestResult(null)
    try {
      const res = await api<{ tested: boolean; status: string }>(API_ENDPOINTS.admin.providerCredentialTest(id), {
        method: 'POST',
      })
      if (res.success && res.data?.tested && res.data.status === 'success') {
        setTestResult({ id, success: true, msg: '连通性测试通过' })
      } else {
        setTestResult({ id, success: false, msg: res.error?.message || '连通性测试未通过' })
      }
    } catch {
      setTestResult({ id, success: false, msg: '测试请求失败' })
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">供应商凭据</h1>
          <p className="text-sm text-muted-foreground">
            配置外部 AI 提供商的 API 密钥与端点。图像 / 视频凭据请从
            <Link href="/admin/plugins" className="mx-1 text-foreground underline underline-offset-4 hover:text-accent">
              媒体插件
            </Link>
            目录创建，未绑定插件的凭据无法通过连通测试。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 text-xs font-medium text-accent-contrast transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" />
            添加凭据
          </button>
          <button
            type="button"
            onClick={() => refetch()}
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
              <th className="px-4 py-3 font-medium">凭据名称</th>
              <th className="px-4 py-3 font-medium">绑定插件</th>
              <th className="px-4 py-3 font-medium">协议 / 适配器</th>
              <th className="px-4 py-3 font-medium">API Key 状态</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : credentials.length > 0 ? (
              credentials.map((c) => {
                const pluginKey =
                  c.configuredFields?.pluginId && c.configuredFields?.pluginVersion
                    ? `${c.configuredFields.pluginId}@${c.configuredFields.pluginVersion}`
                    : null
                const notLinked = c.lastTestErrorCode === 'PLUGIN_NOT_LINKED'
                return (
                  <tr key={c.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">
                      <div>{c.displayName}</div>
                      {c.baseUrl && <div className="font-mono text-[11px] text-muted-foreground">{c.baseUrl}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {pluginKey ? (
                        <span className="font-mono text-[11px] text-foreground">{pluginKey}</span>
                      ) : (
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
                            notLinked ? 'bg-danger-soft text-danger' : 'bg-surface-subtle text-muted-foreground'
                          }`}
                        >
                          {notLinked ? '未关联插件，无法连通' : '未关联插件'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-muted-foreground">
                      <div>{c.providerId || '-'}</div>
                      <div>{c.adapter || '-'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
                          c.hasApiKey || c.hasCredential ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
                        }`}
                      >
                        {c.hasApiKey || c.hasCredential ? '已配置密钥' : '未设置密钥'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
                          c.enabled ? 'bg-success-soft text-success' : 'bg-surface-subtle text-muted-foreground'
                        }`}
                      >
                        {c.enabled ? '已启用' : '已停用'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {testResult && testResult.id === c.id && (
                          <span className={`text-[11px] ${testResult.success ? 'text-success' : 'text-danger'}`}>
                            {testResult.msg}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleTest(c.id)}
                          disabled={testingId === c.id}
                          className="rounded-[var(--radius-control)] border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-subtle disabled:opacity-50"
                        >
                          {testingId === c.id ? '测试中...' : '连通测试'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`确认删除凭据 ${c.displayName}？`)) {
                              deleteMutation.mutate(c.id)
                            }
                          }}
                          className="rounded-[var(--radius-control)] border border-border p-1 text-danger hover:bg-danger-soft/20"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  暂无供应商凭据配置
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AdminProviderCredentialDialog
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        templates={templates}
      />
    </div>
  )
}
