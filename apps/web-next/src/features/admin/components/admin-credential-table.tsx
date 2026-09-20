'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { ProviderCredential, ProviderTestStatus } from '@/shared/types'
import { credentialPluginKey } from '../lib/provider-templates'
import { Loader2, Trash2 } from 'lucide-react'

interface AdminCredentialTableProps {
  credentials: ProviderCredential[]
  isLoading: boolean
  /**
   * `media` rows are plugin-bound credentials and show their plugin identity;
   * `language` rows are plugin-less (adapter + API key) credentials and show
   * which models consume them.
   */
  variant: 'media' | 'language'
  /** Model display names keyed by the credential id they are bound to. */
  linkedModels?: Record<string, string[]>
  emptyText: string
}

const TEST_STATUS_LABEL: Record<ProviderTestStatus, string> = {
  success: '测试通过',
  failed: '测试失败',
  not_tested: '未测试',
}

// Shared credential console merged out of the former 供应商凭据 page: list,
// enable/disable, connectivity test and delete. Creation lives in each page's
// dialog because the payload shape differs per scope.
export function AdminCredentialTable({
  credentials,
  isLoading,
  variant,
  linkedModels = {},
  emptyText,
}: AdminCredentialTableProps) {
  const queryClient = useQueryClient()
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; msg: string } | null>(null)
  const [actionError, setActionError] = useState('')

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await api(API_ENDPOINTS.admin.providerCredential(id), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '删除凭据失败')
      return res.data
    },
    onSuccess: () => {
      setActionError('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
    },
    onError: (err: Error) => {
      setActionError(err.message || '删除凭据失败')
    },
  })

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await api(API_ENDPOINTS.admin.providerCredential(id), { method: 'PATCH', body: { enabled } })
      if (!res.success) throw new Error(res.error?.message || '更新凭据状态失败')
      return res.data
    },
    onSuccess: () => {
      setActionError('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
    },
    onError: (err: Error) => {
      setActionError(err.message || '更新凭据状态失败')
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
    <div className="space-y-2">
      {actionError && (
        <div className="rounded border border-danger-soft bg-danger-soft/20 p-2 text-xs text-danger" role="alert">
          {actionError}
        </div>
      )}
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-surface-subtle text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">凭据名称</th>
              <th className="px-4 py-3 font-medium">
                {variant === 'media' ? '绑定插件' : '适配协议'}
              </th>
              <th className="px-4 py-3 font-medium">
                {variant === 'media' ? '供应商 / 适配器' : '关联模型'}
              </th>
              <th className="px-4 py-3 font-medium">API Key 状态</th>
              <th className="px-4 py-3 font-medium">状态</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden="true" />
                  <span className="sr-only">正在加载凭据</span>
                </td>
              </tr>
            ) : credentials.length > 0 ? (
              credentials.map((c) => {
                const pluginKey = credentialPluginKey(c)
                const linked = linkedModels[c.id] || []
                return (
                  <tr key={c.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">
                      <div>{c.displayName}</div>
                      {c.baseUrl && (
                        <div className="break-all font-mono text-[11px] text-muted-foreground">{c.baseUrl}</div>
                      )}
                      <div className="font-mono text-[11px] text-muted-foreground">
                        最近测试：{TEST_STATUS_LABEL[c.lastTestStatus] || c.lastTestStatus}
                        {c.lastTestErrorCode ? `（${c.lastTestErrorCode}）` : ''}
                      </div>
                    </td>
                    {variant === 'media' ? (
                      <td className="px-4 py-3">
                        <span className="font-mono text-[11px] text-foreground">{pluginKey || '-'}</span>
                      </td>
                    ) : (
                      <td className="px-4 py-3 font-mono text-muted-foreground">{c.adapter || '-'}</td>
                    )}
                    {variant === 'media' ? (
                      <td className="px-4 py-3 font-mono text-muted-foreground">
                        <div>{c.providerId || '-'}</div>
                        <div>{c.adapter || '-'}</div>
                      </td>
                    ) : (
                      <td className="px-4 py-3 text-muted-foreground">
                        {linked.length > 0 ? (
                          <span className="text-foreground">{linked.join('、')}</span>
                        ) : (
                          <span>未关联模型</span>
                        )}
                      </td>
                    )}
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
                      <button
                        type="button"
                        onClick={() => toggleMutation.mutate({ id: c.id, enabled: !c.enabled })}
                        aria-label={c.enabled ? `停用凭据 ${c.displayName}` : `启用凭据 ${c.displayName}`}
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          c.enabled
                            ? 'bg-success-soft text-success hover:bg-success-soft/80'
                            : 'bg-surface-subtle text-muted-foreground hover:bg-surface-subtle-strong'
                        }`}
                      >
                        {c.enabled ? '已启用' : '已停用'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {testResult && testResult.id === c.id && (
                          <span
                            className={`text-[11px] ${testResult.success ? 'text-success' : 'text-danger'}`}
                            role="status"
                          >
                            {testResult.msg}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleTest(c.id)}
                          disabled={testingId === c.id}
                          aria-label={`连通测试凭据 ${c.displayName}`}
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
                          aria-label={`删除凭据 ${c.displayName}`}
                          className="rounded-[var(--radius-control)] border border-border p-1 text-danger hover:bg-danger-soft/20"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
