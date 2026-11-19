'use client'

import { useEffect, useState } from 'react'
import { GlobeIcon, UserPlusIcon } from '@phosphor-icons/react'
import type { SiteSettingsDto, SetupConfigDto } from '@musecanvas/contracts'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  Input,
  Switch,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import {
  useAdminRegistration,
  useSetAdminRegistration,
  useUpdateAdminSiteSettings,
} from '@/shared/hooks/useAdmin'
import { cn } from '@/shared/lib/cn'
import { formatDateTime } from '@/shared/lib/format'
import { adminErrorMessage } from '@/features/admin/lib/admin-settings-api-error'
import { validateSiteForm } from '@/features/admin/lib/admin-settings-forms'
import { AdminMediaModelDefaultsCard } from './admin-media-model-defaults'

/** 注册模式：开放注册 / 邀请注册（PATCH /admin/registration，切换即保存）。 */
function RegistrationCard() {
  const { toast } = useToast()
  const [inviteOnly, setInviteOnly] = useState(false)

  const registrationQuery = useAdminRegistration()
  const mutation = useSetAdminRegistration()

  useEffect(() => {
    if (registrationQuery.data) setInviteOnly(registrationQuery.data.requiresInvitation)
  }, [registrationQuery.data])

  return (
    <Card aria-labelledby="admin-registration-title">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent',
              controlSquare.md,
            )}
          >
            <UserPlusIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle id="admin-registration-title" level={2}>
                注册模式
              </CardTitle>
              <Badge tone={inviteOnly ? 'info' : 'neutral'} dot>
                {registrationQuery.isLoading ? '读取中' : inviteOnly ? '邀请注册' : '开放注册'}
              </Badge>
            </div>
            <CardDescription>
              邀请注册下，新用户除邮箱/OAuth 验证外还需提供有效邀请码。
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border/70 bg-tonal px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">仅允许邀请注册</span>
            <span className="text-xs text-muted-foreground">切换后立即生效，对已登录用户没有影响。</span>
          </div>
          <Switch
            aria-label="仅允许邀请注册"
            checked={inviteOnly}
            disabled={registrationQuery.isLoading || mutation.isPending}
            onCheckedChange={(checked) => {
              setInviteOnly(checked)
              mutation.mutate(checked, {
                onSuccess: (data) => {
                  setInviteOnly(data.requiresInvitation)
                  toast.success(data.requiresInvitation ? '已切换为邀请注册' : '已切换为开放注册')
                },
                onError: (error) => {
                  setInviteOnly(registrationQuery.data?.requiresInvitation ?? false)
                  toast.error('修改注册模式失败', adminErrorMessage(error))
                },
              })
            }}
          />
        </div>
      </CardBody>
    </Card>
  )
}

export interface AdminSettingsSiteCardProps {
  settings: SiteSettingsDto
  onSaved: (settings: SiteSettingsDto) => void
}

/** 站点信息：站点名称 + 公开访问地址（OAuth 回调、签名 URL 与邮件链接都依赖它）。 */
function SiteCard({ settings, onSaved }: AdminSettingsSiteCardProps) {
  const { toast } = useToast()
  const [siteName, setSiteName] = useState(settings.siteName ?? '')
  const [siteUrl, setSiteUrl] = useState(settings.siteUrl ?? '')
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    setSiteName(settings.siteName ?? '')
    setSiteUrl(settings.siteUrl ?? '')
    setErrors({})
  }, [settings.revision, settings.siteName, settings.siteUrl])

  const mutation = useUpdateAdminSiteSettings()

  function handleSave() {
    const nextErrors = validateSiteForm({ siteName, siteUrl })
    setErrors(nextErrors)
    if (Object.values(nextErrors).some(Boolean)) return
    mutation.mutate(
      {
        siteName: siteName.trim(),
        siteUrl: siteUrl.trim() === '' ? null : siteUrl.trim(),
      },
      {
        onSuccess: (saved) => {
          onSaved(saved)
          setErrors({})
          toast.success('站点信息已保存')
        },
        onError: (error) => toast.error('保存站点信息失败', adminErrorMessage(error)),
      },
    )
  }

  return (
    <Card aria-labelledby="admin-site-title">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex shrink-0 items-center justify-center rounded-control bg-tonal text-foreground',
              controlSquare.md,
            )}
          >
            <GlobeIcon weight="duotone" aria-hidden="true" className={iconSize.md} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <CardTitle id="admin-site-title" level={2}>
              站点信息
            </CardTitle>
            <CardDescription>
              用于邮件里的链接、OAuth 回调地址与媒体签名 URL。地址必须是外网可访问的 HTTPS 裸域名。
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <FieldGroup>
          <Field label="站点名称" required hint="显示在浏览器标题与邮件落款中，最多 120 个字符。" error={errors.siteName}>
            <Input
              value={siteName}
              onChange={(event) => setSiteName(event.target.value)}
              maxLength={120}
              placeholder="例如：MuseCanvas"
              disabled={mutation.isPending}
            />
          </Field>
          <Field
            label="站点地址"
            hint="只填写协议 + 域名（可带端口），例如 https://canvas.example.com。"
            error={errors.siteUrl}
          >
            <Input
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
              inputMode="url"
              spellCheck={false}
              placeholder="https://canvas.example.com"
              disabled={mutation.isPending}
            />
          </Field>
        </FieldGroup>
      </CardBody>
      <CardFooter>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          更新于 {formatDateTime(settings.updatedAt)} · #{settings.revision}
        </span>
        <Button onClick={handleSave} loading={mutation.isPending}>
          保存站点信息
        </Button>
      </CardFooter>
    </Card>
  )
}

export interface AdminSettingsGeneralProps {
  config: SetupConfigDto
  onSiteSaved: (settings: SiteSettingsDto) => void
}

/** 站点与注册分区。 */
export function AdminSettingsGeneral({ config, onSiteSaved }: AdminSettingsGeneralProps) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RegistrationCard />
      <SiteCard settings={config.site} onSaved={onSiteSaved} />
      <AdminMediaModelDefaultsCard />
    </div>
  )
}
