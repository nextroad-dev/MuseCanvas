'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { BuiltinProviderTemplate, ProviderCredentialInput } from '@/shared/types'
import {
  LEGACY_ADAPTER_OPTIONS,
  buildTemplateCredentialInput,
  parseServiceAccountJson,
} from '../lib/provider-templates'
import { Loader2, X } from 'lucide-react'

interface AdminProviderCredentialDialogProps {
  open: boolean
  onClose: () => void
  templates?: BuiltinProviderTemplate[]
  /** When set, the dialog is pinned to this plugin and hides both pickers. */
  lockedTemplate?: BuiltinProviderTemplate | null
  /**
   * Which credential family the dialog creates. `media` offers plugin-backed
   * credentials (plus legacy media adapters); `language` is the plugin-less
   * adapter + API key shape that language models bind to.
   */
  scope?: 'media' | 'language'
}

// Legacy (plugin-less) credentials remain the path for language models and
// custom endpoints; the API rejects any other adapter without plugin identity.
export function AdminProviderCredentialDialog({
  open,
  onClose,
  templates = [],
  lockedTemplate,
  scope = 'media',
}: AdminProviderCredentialDialogProps) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'template' | 'legacy'>(scope === 'language' ? 'legacy' : 'template')
  const [templateKey, setTemplateKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [serviceAccountRaw, setServiceAccountRaw] = useState('')
  const [adapter, setAdapter] = useState(LEGACY_ADAPTER_OPTIONS[scope][0].value)
  const [baseUrl, setBaseUrl] = useState('')
  const [actionError, setActionError] = useState('')

  const legacyAdapters = LEGACY_ADAPTER_OPTIONS[scope]
  const template = scope === 'language'
    ? null
    : lockedTemplate ?? templates.find((t) => t.key === templateKey) ?? null
  const effectiveMode = scope === 'language' ? 'legacy' : (lockedTemplate ? 'template' : mode)
  const useServiceAccount = template?.credential.kind === 'google_service_account'

  const resetFields = () => {
    setDisplayName('')
    setApiKey('')
    setServiceAccountRaw('')
    setBaseUrl('')
    setActionError('')
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      let body: ProviderCredentialInput
      if (effectiveMode === 'template') {
        if (!template) throw new Error('请选择媒体插件')
        if (template.credential.kind === 'google_service_account') {
          const parsed = parseServiceAccountJson(serviceAccountRaw)
          if (!parsed.ok) throw new Error(parsed.error)
          body = buildTemplateCredentialInput(template, parsed.value, displayName)
        } else {
          if (!apiKey.trim()) throw new Error('请输入 API Key')
          body = buildTemplateCredentialInput(template, apiKey.trim(), displayName)
        }
      } else {
        if (!displayName.trim()) throw new Error('请输入凭据显示名称')
        if (!apiKey.trim()) throw new Error('请输入 API Key')
        body = { displayName: displayName.trim(), adapter, baseUrl: baseUrl.trim() || undefined, apiKey: apiKey.trim(), enabled: true }
      }
      const res = await api(API_ENDPOINTS.admin.providerCredentials, { method: 'POST', body })
      if (!res.success) throw new Error(res.error?.message || '创建凭据失败')
      return res.data
    },
    onSuccess: () => {
      resetFields()
      onClose()
      queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
    },
    onError: (err: Error) => {
      setActionError(err.message || '创建凭据失败')
    },
  })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-credential-dialog-title"
        className="relative z-10 w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 id="provider-credential-dialog-title" className="font-semibold text-foreground">
            {effectiveMode === 'template'
              ? '从媒体插件创建凭据'
              : scope === 'language'
                ? '创建语言模型凭据'
                : '创建自定义凭据'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
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

        {scope === 'media' && !lockedTemplate && (
          <div className="flex gap-1 rounded-[var(--radius-control)] bg-surface-subtle p-1" role="group" aria-label="凭据类型">
            <button
              type="button"
              onClick={() => setMode('template')}
              aria-pressed={effectiveMode === 'template'}
              className={`flex-1 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium transition-colors ${
                effectiveMode === 'template'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              内置插件
            </button>
            <button
              type="button"
              onClick={() => setMode('legacy')}
              aria-pressed={effectiveMode === 'legacy'}
              className={`flex-1 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium transition-colors ${
                effectiveMode === 'legacy'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              自定义凭据
            </button>
          </div>
        )}

        <div className="space-y-3">
          {effectiveMode === 'template' && !lockedTemplate && (
            <div>
              <label htmlFor="credential-template" className="mb-1 block text-xs font-medium text-foreground">
                媒体插件
              </label>
              <select
                id="credential-template"
                value={templateKey}
                onChange={(e) => setTemplateKey(e.target.value)}
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
              >
                <option value="">请选择插件</option>
                {templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.displayName} · {t.pluginId}@{t.pluginVersion} · {t.modality === 'video' ? '视频' : '图像'}
                  </option>
                ))}
              </select>
            </div>
          )}

          {effectiveMode === 'template' && template && (
            <div className="rounded-[var(--radius-control)] bg-surface-subtle p-3 text-[11px] text-muted-foreground">
              <div className="font-mono text-foreground">
                {template.pluginId}@{template.pluginVersion}
              </div>
              <div>供应商 {template.providerId} · 凭据 {template.credential.schemaId}@{template.credential.schemaVersion}</div>
              <div className="break-all font-mono">{template.baseUrl}</div>
            </div>
          )}

          {effectiveMode === 'legacy' && (
            <>
              {scope === 'language' ? (
                <p className="rounded-[var(--radius-control)] bg-surface-subtle p-3 text-[11px] text-muted-foreground">
                  语言模型不使用供应商插件，凭据按 <span className="font-mono text-foreground">适配协议 + API Key</span> 与语言模型绑定。
                </p>
              ) : (
                <p className="rounded-[var(--radius-control)] bg-surface-subtle p-3 text-[11px] text-muted-foreground">
                  自定义凭据不绑定插件身份，因此无法通过媒体凭据的连通测试；此类凭据列在
                  <span className="font-mono text-foreground">语言模型</span>
                  页的凭据列表中。
                </p>
              )}
              <div>
                <label htmlFor="credential-name" className="mb-1 block text-xs font-medium text-foreground">显示名称</label>
                <input
                  id="credential-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={scope === 'language' ? '例如: Anthropic 语言模型凭据' : '例如: 自建 OpenAI 兼容端点'}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                />
              </div>
              <div>
                <label htmlFor="credential-adapter" className="mb-1 block text-xs font-medium text-foreground">适配协议</label>
                <select
                  id="credential-adapter"
                  value={adapter}
                  onChange={(e) => setAdapter(e.target.value)}
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                >
                  {legacyAdapters.map((a) => (
                    <option key={a.value} value={a.value}>{a.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="credential-base-url" className="mb-1 block text-xs font-medium text-foreground">Base URL (可选)</label>
                <input
                  id="credential-base-url"
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
                />
              </div>
            </>
          )}

          {effectiveMode === 'template' && (
            <div>
              <label htmlFor="credential-name-optional" className="mb-1 block text-xs font-medium text-foreground">
                显示名称 (可选)
              </label>
              <input
                id="credential-name-optional"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={template ? template.displayName : '默认使用插件名称'}
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
              />
            </div>
          )}

          {effectiveMode === 'legacy' ? (
            <div>
              <label htmlFor="credential-key" className="mb-1 block text-xs font-medium text-foreground">API Key 密钥</label>
              <input
                id="credential-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
              />
            </div>
          ) : useServiceAccount ? (
            <div>
              <label htmlFor="credential-service-account" className="mb-1 block text-xs font-medium text-foreground">
                {template?.credential.label}
              </label>
              <textarea
                id="credential-service-account"
                value={serviceAccountRaw}
                onChange={(e) => setServiceAccountRaw(e.target.value)}
                rows={5}
                placeholder={template?.credential.placeholder}
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 font-mono text-xs text-foreground outline-none"
              />
              {template?.credential.helpText && (
                <p className="mt-1 text-[11px] text-muted-foreground">{template.credential.helpText}</p>
              )}
            </div>
          ) : (
            <div>
              <label htmlFor="credential-key" className="mb-1 block text-xs font-medium text-foreground">
                {template?.credential.label ?? 'API Key 密钥'}
              </label>
              <input
                id="credential-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={template?.credential.placeholder ?? 'sk-...'}
                className="w-full rounded-[var(--radius-control)] border border-border-control bg-canvas px-3 py-1.5 text-sm text-foreground outline-none"
              />
              {template?.credential.helpText && (
                <p className="mt-1 text-[11px] text-muted-foreground">{template.credential.helpText}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-surface-subtle"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || (effectiveMode === 'template' && !template)}
            className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-4 py-1.5 text-xs font-medium text-accent-contrast hover:bg-accent-hover disabled:opacity-50"
          >
            {createMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            保存凭据
          </button>
        </div>
      </div>
    </div>
  )
}
