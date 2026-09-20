'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { BuiltinProviderTemplate, ProviderCredential } from '@/shared/types'
import { templateConfiguredCount } from '../lib/provider-templates'
import { AdminProviderCredentialDialog } from './admin-provider-credential-dialog'
import { Blocks, Key, Loader2, Plus, RefreshCw } from 'lucide-react'

export function AdminPluginsView() {
  const [dialogTemplate, setDialogTemplate] = useState<BuiltinProviderTemplate | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const {
    data: templates = [],
    isLoading,
    error: templatesError,
    refetch,
  } = useQuery({
    queryKey: ['admin', 'provider-templates'],
    queryFn: async () => {
      const res = await api<{ templates: BuiltinProviderTemplate[] }>(API_ENDPOINTS.admin.providerTemplates)
      if (!res.success) throw new Error(res.error?.message || '加载媒体插件失败')
      return res.data?.templates || []
    },
  })

  const { data: credentials = [] } = useQuery({
    queryKey: ['admin', 'provider-credentials'],
    queryFn: async () => {
      const res = await api<ProviderCredential[]>(API_ENDPOINTS.admin.providerCredentials)
      return res.data || []
    },
  })

  function openCreate(template: BuiltinProviderTemplate | null) {
    setDialogTemplate(template)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">媒体插件</h1>
          <p className="text-sm text-muted-foreground">
            由 provider registry 提供的内置图像 / 视频插件目录。凭据必须绑定插件身份，否则无法通过连通测试。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => openCreate(null)}
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

      {isLoading ? (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      ) : templatesError ? (
        <div className="rounded-[var(--radius-card)] border border-danger-soft bg-danger-soft/20 p-4 text-xs text-danger">
          {templatesError.message || '加载媒体插件失败'}
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-8 text-center text-muted-foreground">
          暂无已注册的媒体插件
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map((t) => {
            const configured = templateConfiguredCount(credentials, t)
            return (
              <div
                key={t.key}
                className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Blocks className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <h2 className="truncate text-sm font-semibold text-foreground">{t.displayName}</h2>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {t.pluginId}@{t.pluginVersion}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium bg-surface-subtle text-muted-foreground">
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

                {t.description && (
                  <p className="text-xs text-muted-foreground">{t.description}</p>
                )}

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

                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <Link
                    href="/admin/providers"
                    className="flex min-h-9 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Key className="h-3.5 w-3.5" />
                    凭据列表
                  </Link>
                  <button
                    type="button"
                    onClick={() => openCreate(t)}
                    className="flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-subtle"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    新建凭据
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <AdminProviderCredentialDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        templates={templates}
        lockedTemplate={dialogTemplate}
      />
    </div>
  )
}
