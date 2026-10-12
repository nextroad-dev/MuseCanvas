'use client'

import { cn } from '@/shared/lib/cn'
import { adminTouchTargetsSquare } from '../lib/admin-layout'
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { BuiltinProviderTemplate, ProviderCredentialInput } from '@/shared/types'
import {
  CUSTOM_PROVIDER_OPTIONS,
  buildTemplateCredentialInput,
  parseJsonSecret,
  parseServiceAccountJson,
} from '../lib/provider-templates'
import {
  Alert,
  Button,
  Dialog,
  FieldGroup,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Select,
  Textarea,
} from '@/shared/components/ui'

interface AdminProviderCredentialDialogProps {
  open: boolean
  onClose: () => void
  templates?: BuiltinProviderTemplate[]
  /** When set, the dialog is pinned to this plugin and hides both pickers. */
  lockedTemplate?: BuiltinProviderTemplate | null
  /**
   * Which credential family the dialog creates. `media` offers template-validated
   * credentials (plus custom media provider accounts); `language` is the
   * provider + API key shape that language models bind to.
   */
  scope?: 'media' | 'language'
}

type Mode = 'template' | 'legacy'

/** Fields whose local validation failed; each message renders inside its `FormField`. */
type FieldKey = 'template' | 'displayName' | 'apiKey' | 'serviceAccount'
type FieldErrors = Partial<Record<FieldKey, string>>

/** A validation failure that belongs to one input, not to the dialog as a whole. */
interface FieldValidationError extends Error {
  field: FieldKey
}

function validationError(field: FieldKey, message: string): FieldValidationError {
  return Object.assign(new Error(message) as FieldValidationError, { field })
}

const MODE_OPTIONS: { value: Mode; label: string; hint: string }[] = [
  { value: 'template', label: '内置插件', hint: '按插件声明的格式与端点校验，可通过连通测试。' },
  { value: 'legacy', label: '自定义凭据', hint: '只选择供应商账号，可填写兼容端点。' },
]

// Credentials belong to a provider account. A template names the plugin whose
// declared contract validates the secret; custom credentials name only the account
// (language models and compatible endpoints), and the API checks them against
// every plugin of that account.
const ENDPOINT_POLICY_LABEL: Record<BuiltinProviderTemplate['credential']['baseUrlPolicy'], string> = {
  fixed: '仅官方端点',
  allowlisted: '插件允许的域名',
  'any-https': '任意 HTTPS 端点',
}

export function AdminProviderCredentialDialog({
  open,
  onClose,
  templates = [],
  lockedTemplate,
  scope = 'media',
}: AdminProviderCredentialDialogProps) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<Mode>(scope === 'language' ? 'legacy' : 'template')
  const [templateKey, setTemplateKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [serviceAccountRaw, setServiceAccountRaw] = useState('')
  const [customProvider, setCustomProvider] = useState(CUSTOM_PROVIDER_OPTIONS[scope][0].value)
  const [baseUrl, setBaseUrl] = useState('')
  const [actionError, setActionError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  const customProviders = CUSTOM_PROVIDER_OPTIONS[scope]
  const template = scope === 'language'
    ? null
    : lockedTemplate ?? templates.find((t) => t.key === templateKey) ?? null
  const effectiveMode: Mode = scope === 'language' ? 'legacy' : (lockedTemplate ? 'template' : mode)
  const useJsonSecret = template?.credential.format === 'json'

  function clearFieldError(field: FieldKey) {
    setFieldErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev))
  }

  const resetFields = () => {
    setDisplayName('')
    setApiKey('')
    setServiceAccountRaw('')
    setBaseUrl('')
    setActionError('')
    setFieldErrors({})
  }

  // Clear both secret formats on every identity change, including locked templates.
  // Conservatively clearing compatible templates too avoids accidental account reuse.
  useEffect(() => {
    setApiKey('')
    setServiceAccountRaw('')
    setFieldErrors({})
    setActionError('')
  }, [open, scope, effectiveMode, template?.key, template?.providerId, template?.credential.format, template?.credential.schemaId, template?.credential.schemaVersion, customProvider])

  function close() {
    resetFields()
    onClose()
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      setFieldErrors({})
      setActionError('')
      let body: ProviderCredentialInput
      if (effectiveMode === 'template') {
        if (!template) throw validationError('template', '请选择媒体插件。')
        if (template.credential.format === 'json') {
          // Google's service-account fields are known here; any other JSON
          // credential is checked by its plugin's declared contract on save.
          const parsed = template.providerId === 'google'
            ? parseServiceAccountJson(serviceAccountRaw)
            : parseJsonSecret(serviceAccountRaw)
          if (!parsed.ok) throw validationError('serviceAccount', parsed.error)
          body = buildTemplateCredentialInput(template, parsed.value, displayName)
        } else {
          if (!apiKey.trim()) throw validationError('apiKey', '请输入 API Key。')
          body = buildTemplateCredentialInput(template, apiKey.trim(), displayName)
        }
      } else {
        if (!displayName.trim()) throw validationError('displayName', '请输入凭据显示名称。')
        if (!apiKey.trim()) throw validationError('apiKey', '请输入 API Key。')
        body = { displayName: displayName.trim(), providerId: customProvider, baseUrl: baseUrl.trim() || undefined, secret: apiKey.trim(), enabled: true }
      }
      const res = await api(API_ENDPOINTS.admin.providerCredentials, { method: 'POST', body })
      if (!res.success) throw new Error(res.error?.message || '创建凭据失败')
      return res.data
    },
    onSuccess: () => {
      close()
      queryClient.invalidateQueries({ queryKey: ['admin', 'provider-credentials'] })
    },
    onError: (err: Error) => {
      const fieldError = err as Partial<FieldValidationError>
      if (fieldError.field) {
        // Inline only: the field says what is missing, so no dialog-level banner.
        const field = fieldError.field
        setFieldErrors((prev) => ({ ...prev, [field]: err.message }))
        setActionError('')
        return
      }
      setActionError(err.message || '创建凭据失败')
    },
  })

  const credentialFieldLabel = useJsonSecret
    ? template?.credential.label
    : (template?.credential.label ?? 'API Key')

  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        effectiveMode === 'template'
          ? '从媒体插件创建凭据'
          : scope === 'language'
            ? '创建语言模型凭据'
            : '创建自定义凭据'
      }
      panelClassName={cn('max-w-form max-h-[90dvh]', adminTouchTargetsSquare)}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            取消
          </Button>
          <Button
            loading={createMutation.isPending}
            disabled={createMutation.isPending || (effectiveMode === 'template' && !template)}
            onClick={() => createMutation.mutate()}
          >
            保存凭据
          </Button>
        </>
      }
    >
      <fieldset disabled={createMutation.isPending} className="flex min-w-0 flex-col gap-6">
        {actionError && (
          <Alert tone="danger" role="alert" title="无法创建凭据">
            {actionError}。请核对填写内容与供应商配置后重试；密钥无效时请重新获取 API Key。
          </Alert>
        )}

        {scope === 'media' && !lockedTemplate && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium text-foreground">凭据类型</legend>
            {/* Shared Radio primitive: native radio semantics, arrow-key grouping and the
                checked state come from the platform; the hint rides inside the label. */}
            <RadioGroup
              name="credential-mode"
              aria-label="凭据类型"
              orientation="horizontal"
              value={effectiveMode}
              onValueChange={(value) => {
                const option = MODE_OPTIONS.find((item) => item.value === value)
                if (!option) return
                setMode(option.value)
                setActionError('')
              }}
              className="gap-2"
            >
              {MODE_OPTIONS.map((option) => (
                <Radio
                  key={option.value}
                  value={option.value}
                  className="min-w-0 flex-1 items-start rounded-control px-3 py-2 transition-colors hover:bg-tonal-hover"
                  label={
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  }
                />
              ))}
            </RadioGroup>
          </fieldset>
        )}

        <FieldGroup>
          {effectiveMode === 'template' && !lockedTemplate && (
            <FormField
              label="媒体插件"
              required
              error={fieldErrors.template}
              hint="凭据按所选插件声明的格式与端点校验；同一供应商账号下的其它插件也可以使用。"
            >
              <Select
                value={templateKey}
                onChange={(e) => {
                  setTemplateKey(e.target.value)
                  clearFieldError('template')
                }}
              >
                <option value="">请选择插件</option>
                {templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.displayName} · {t.pluginId}@{t.pluginVersion} · {t.modality === 'video' ? '视频' : '图像'}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          {effectiveMode === 'template' && template && (
            <div className="flex flex-col gap-1 rounded-control bg-tonal p-3 text-xs text-muted-foreground">
              <div className="font-mono text-foreground">
                {template.pluginId}@{template.pluginVersion}
              </div>
              <div>
                供应商 {template.providerId} · 凭据 {template.credential.schemaId}@{template.credential.schemaVersion}
              </div>
              <div className="break-all font-mono">{template.baseUrl}</div>
              <div>端点策略：{ENDPOINT_POLICY_LABEL[template.credential.baseUrlPolicy]}</div>
            </div>
          )}

          {effectiveMode === 'legacy' && (
            <div className="rounded-control bg-tonal p-3 text-xs text-muted-foreground">
              {scope === 'language' ? (
                <>
                  语言模型凭据由{' '}
                  <span className="font-mono text-foreground">供应商 + API Key</span> 组成，可填写兼容端点。
                </>
              ) : (
                <>
                  自定义凭据不经插件模板校验，关联模型后可借该模型的插件做连通测试；此类凭据列在
                  <span className="font-mono text-foreground">语言模型</span>
                  页的凭据列表中。
                </>
              )}
            </div>
          )}

          {effectiveMode === 'legacy' && (
            <FormField
              label="显示名称"
              required
              error={fieldErrors.displayName}
              hint="用于在模型配置中标识该凭据，例如供应商或用途。"
            >
              <Input
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value)
                  clearFieldError('displayName')
                }}
                placeholder={scope === 'language' ? '例如：Anthropic 语言模型凭据' : '例如：自建 OpenAI 兼容端点'}
                autoComplete="off"
              />
            </FormField>
          )}

          {effectiveMode === 'legacy' && (
            <FormField label="供应商" hint="凭据所属的供应商账号，决定哪些插件的模型可以使用它。">
              <Select value={customProvider} onChange={(e) => setCustomProvider(e.target.value)}>
                {customProviders.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </FormField>
          )}

          {effectiveMode === 'legacy' && (
            <FormField
              label="Base URL（可选）"
              hint="留空时使用供应商的默认端点；填写时请写到版本路径，例如 https://api.example.com/v1。"
            >
              <Input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
          )}

          {effectiveMode === 'template' && (
            <FormField
              label="显示名称（可选）"
              hint="留空时使用插件名称作为凭据显示名称。"
            >
              <Input
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value)
                  clearFieldError('displayName')
                }}
                placeholder={template ? template.displayName : '默认使用插件名称'}
                autoComplete="off"
              />
            </FormField>
          )}

          {effectiveMode === 'legacy' ? (
            <FormField
              label="API Key"
              required
              error={fieldErrors.apiKey}
              hint="密钥以加密形式存储于服务端，保存后不再明文展示。"
            >
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  clearFieldError('apiKey')
                }}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
          ) : useJsonSecret ? (
            <FormField
              label={credentialFieldLabel ?? '凭据 JSON'}
              required
              error={fieldErrors.serviceAccount}
              hint={template?.credential.helpText ?? '粘贴凭据 JSON，仅服务端解密使用。'}
              keepHintOnError
            >
              <Textarea
                value={serviceAccountRaw}
                onChange={(e) => {
                  setServiceAccountRaw(e.target.value)
                  clearFieldError('serviceAccount')
                }}
                rows={6}
                placeholder={template?.credential.placeholder}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </FormField>
          ) : (
            <FormField
              label={credentialFieldLabel ?? 'API Key'}
              required
              error={fieldErrors.apiKey}
              hint={template?.credential.helpText ?? '密钥以加密形式存储于服务端，保存后不再明文展示。'}
              keepHintOnError
            >
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  clearFieldError('apiKey')
                }}
                placeholder={template?.credential.placeholder ?? 'sk-...'}
                autoComplete="new-password"
                spellCheck={false}
              />
            </FormField>
          )}
        </FieldGroup>
      </fieldset>
    </Dialog>
  )
}
