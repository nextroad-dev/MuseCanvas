'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CopyIcon as Copy, ArrowSquareOutIcon as ExternalLink } from '@phosphor-icons/react'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Field, FieldGroup } from '@/shared/components/ui/field'
import { Input } from '@/shared/components/ui/input'
import { Switch } from '@/shared/components/ui/switch'
import { useToast } from '@/shared/components/ui/toast'
import { iconSize } from '@/shared/components/ui/size'
import { queryKeys } from '@/shared/hooks/query-keys'
import { adminErrorMessage, copyToClipboard } from '@/features/admin/lib/admin-settings-api-error'
import {
  OAUTH_PROVIDER_META,
  OAUTH_SOURCE_HINT,
  OAUTH_SOURCE_LABEL,
  oauthConfigured,
  shortClientId,
  validateOAuthForm,
} from '@/features/admin/lib/admin-oauth-providers'
import type { OAuthProviderInput } from '@/shared/types'
import type { AdminOAuthProviderDto } from '@/shared/types'
import { clientApi } from '@/shared/services/client-api'

export interface AdminOAuthProviderCardProps {
  provider: AdminOAuthProviderDto
}

/** 单张 OAuth 提供商卡：凭据表单 + 只读回调地址 + 启用开关。 */
export function AdminOAuthProviderCard({ provider }: AdminOAuthProviderCardProps) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const meta = OAUTH_PROVIDER_META[provider.provider as 'github' | 'google']
  const label = provider.label || meta?.label || provider.provider

  const [clientId, setClientId] = useState(provider.clientId)
  const [clientSecret, setClientSecret] = useState('')
  const [errors, setErrors] = useState<{ clientId?: string; clientSecret?: string }>({})

  // 服务端数据变化（保存/启停后的 cache 更新）时同步只读状态与输入框；
  // 密钥永远不回显，所以 secret 一律清空。
  useEffect(() => {
    setClientId(provider.clientId)
    setClientSecret('')
    setErrors({})
  }, [provider.provider, provider.clientId, provider.hasClientSecret, provider.enabled, provider.source])

  const configured = oauthConfigured(provider)

  function updateCachedProvider(updated: AdminOAuthProviderDto) {
    queryClient.setQueryData<AdminOAuthProviderDto[]>(queryKeys.admin.oauthProviders, (current) =>
      current ? current.map((item) => (item.provider === updated.provider ? updated : item)) : [updated],
    )
  }

  const saveMutation = useMutation({
    mutationFn: (input: OAuthProviderInput) => clientApi.admin.updateOAuthProvider(provider.provider, input),
    onSuccess: (updated) => {
      updateCachedProvider(updated)
      setClientSecret('')
      setErrors({})
      toast.success(`${label} 凭据已保存`)
    },
    onError: (error) => toast.error(`${label} 保存失败`, adminErrorMessage(error)),
  })

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => clientApi.admin.updateOAuthProvider(provider.provider, { enabled }),
    onSuccess: (updated) => {
      updateCachedProvider(updated)
      toast.success(updated.enabled ? `${label} 登录已启用` : `${label} 登录已停用`)
    },
    onError: (error) => toast.error('切换登录状态失败', adminErrorMessage(error)),
  })

  function handleSave() {
    const nextErrors = validateOAuthForm({ clientId, clientSecret })
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return

    const input: OAuthProviderInput = {}
    const trimmedId = clientId.trim()
    const trimmedSecret = clientSecret.trim()
    if (trimmedId && trimmedId !== provider.clientId) input.clientId = trimmedId
    if (trimmedSecret) input.clientSecret = trimmedSecret
    if (Object.keys(input).length === 0) {
      toast.info('没有需要保存的更改')
      return
    }
    saveMutation.mutate(input)
  }

  async function handleCopyCallback() {
    if (!provider.redirectUri) return
    const copied = await copyToClipboard(provider.redirectUri)
    if (copied) toast.success('回调地址已复制')
    else toast.error('复制失败', '请手动选中回调地址后复制。')
  }

  const busy = saveMutation.isPending || toggleMutation.isPending

  return (
    <Card className="min-w-0 justify-between" aria-labelledby={`oauth-${provider.provider}-title`}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle id={`oauth-${provider.provider}-title`} level={2}>
            {label}
          </CardTitle>
          <Badge tone={provider.enabled ? 'success' : 'neutral'} dot>
            {provider.enabled ? '已启用' : '未启用'}
          </Badge>
          <Badge tone={provider.source === 'none' ? 'warning' : 'neutral'}>{OAUTH_SOURCE_LABEL[provider.source]}</Badge>
          <Badge tone={provider.hasClientSecret ? 'success' : 'neutral'}>
            {provider.hasClientSecret ? '密钥已保存' : '无密钥'}
          </Badge>
        </div>
        <CardDescription>{meta?.description}</CardDescription>
        <p className="text-xs text-muted-foreground">{OAUTH_SOURCE_HINT[provider.source]}</p>
      </CardHeader>

      <CardBody>
        <FieldGroup>
          <Field
            label="Client ID"
            required
            hint={`当前：${shortClientId(provider.clientId)}。留空保持不变。`}
            error={errors.clientId}
          >
            <Input
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="填写 OAuth 应用的 Client ID"
              disabled={busy}
            />
          </Field>

          <Field
            label="Client Secret"
            hint={
              provider.hasClientSecret
                ? '已保存密钥（永不回显）。留空保持不变；填写新值将覆盖旧密钥。'
                : '尚未保存密钥。填写后保存才会生效。'
            }
            error={errors.clientSecret}
          >
            <Input
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={provider.hasClientSecret ? '已配置（留空保持不变）' : '填写 Client Secret'}
              disabled={busy}
            />
          </Field>

          <Field label="回调地址" hint={meta?.callbackHint}>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                value={provider.redirectUri}
                readOnly
                aria-readonly="true"
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                variant="secondary"
                size="md"
                onClick={() => void handleCopyCallback()}
                icon={<Copy weight="bold" aria-hidden="true" className={iconSize.sm} />}
              >
                复制
              </Button>
            </div>
          </Field>
        </FieldGroup>
      </CardBody>

      <CardFooter className="flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 rounded-control bg-tonal px-3 py-2">
          <span className="text-sm font-medium text-foreground">启用登录</span>
          {!configured ? <span className="text-xs text-muted-foreground">先保存凭据</span> : null}
          <Switch
            checked={provider.enabled}
            disabled={!configured || busy}
            aria-label={`${label} 登录`}
            onCheckedChange={(enabled) => toggleMutation.mutate(enabled)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={meta?.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[var(--control-md)] items-center gap-1.5 rounded-control px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            创建凭据
            <ExternalLink weight="bold" aria-hidden="true" className={iconSize.sm} />
          </a>
          <Button onClick={handleSave} loading={saveMutation.isPending} disabled={busy && !saveMutation.isPending}>
            保存凭据
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}
