'use client'

// 账户设置页客户端岛：个人身份（RSC 已守卫并给出首屏数据）+ 第三方账号绑定 + 会话与安全。
// 服务端状态全部走 TanStack Query（useAccount / useOAuthProviders），这里仅持有
// 「待确认解绑的 provider」与「退出中」这类易失 UI 态。

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRightIcon,
  CalendarIcon,
  CheckCircleIcon,
  EnvelopeSimpleIcon,
  LinkSimpleBreakIcon,
  LinkSimpleIcon,
  ProhibitIcon,
  ShieldCheckIcon,
  SignOutIcon,
} from '@phosphor-icons/react'

import { GithubIcon, GoogleIcon } from '@/features/auth/components/brand-icons'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  PageHeader,
  controlSquare,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import { queryKeys } from '@/shared/hooks/query-keys'
import { useAccount } from '@/shared/hooks/useAccount'
import { oauthLinkUrl, useAuth, useOAuthProviders } from '@/shared/hooks/useAuth'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatDate, formatDateTime } from '@/shared/lib/format'
import { clientApi } from '@/shared/services/client-api'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import type { AccountDto, OAuthProvider } from '@/shared/types'
import { describeAccountCallback } from '../lib/account-callback'

/** 展示顺序固定，避免后端返回顺序变化时按钮跳位。 */
const PROVIDERS: Record<OAuthProvider, { label: string; Icon: typeof GithubIcon }> = {
  github: { label: 'GitHub', Icon: GithubIcon },
  google: { label: 'Google', Icon: GoogleIcon },
}

const PROVIDER_ORDER: OAuthProvider[] = ['github', 'google']

export interface AccountViewProps {
  /** RSC 守卫已取到的首屏数据：首帧直接可见，不闪骨架。 */
  initialAccount: AccountDto
  /** OAuth 回跳参数（`?linked=1` / `?error=CODE`）。 */
  callback?: { linked?: string | null; error?: string | null }
}

export function AccountView({ initialAccount, callback }: AccountViewProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { logout } = useAuth()

  const accountQuery = useAccount()
  const providersQuery = useOAuthProviders()
  const account = accountQuery.data ?? initialAccount

  const [pendingUnlink, setPendingUnlink] = useState<OAuthProvider | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const callbackNotifiedRef = useRef(false)

  // 回跳提示只播报一次，随后把 query 清掉，刷新页面不会重复弹。
  useEffect(() => {
    if (callbackNotifiedRef.current) return
    const notice = describeAccountCallback(callback ?? {})
    if (!notice) return
    callbackNotifiedRef.current = true
    if (notice.tone === 'success') toast.success(notice.title)
    else toast.error(notice.title)
    router.replace(APP_ROUTES.account)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unlinkMutation = useMutation({
    mutationFn: (provider: OAuthProvider) => clientApi.account.unlinkOAuth(provider),
    onSuccess: async (_result, provider) => {
      setPendingUnlink(null)
      await queryClient.invalidateQueries({ queryKey: queryKeys.account })
      toast.success(`已解除 ${PROVIDERS[provider].label} 绑定`)
    },
    onError: (error: unknown, provider) => {
      toast.error(
        `无法解除 ${PROVIDERS[provider].label} 绑定`,
        error instanceof Error ? error.message : '请稍后重试。',
      )
    },
  })

  async function handleLogout() {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await logout()
      useAuthUiStore.getState().reset()
      router.replace(APP_ROUTES.login)
      router.refresh()
    } catch (error) {
      setLoggingOut(false)
      toast.error(
        '退出登录失败',
        error instanceof Error ? error.message : '请检查网络后重试。',
      )
    }
  }

  function identityOf(provider: OAuthProvider) {
    return account.oauthIdentities.find((identity) => identity.provider === provider)
  }

  const enabledProviders = new Set(
    (providersQuery.data ?? []).filter((provider) => provider.enabled).map((provider) => provider.provider),
  )
  // 已绑定的 provider 即使后台临时停用也要显示出来，用户仍可解绑。
  const visibleProviders = PROVIDER_ORDER.filter(
    (provider) => enabledProviders.has(provider) || Boolean(identityOf(provider)),
  )
  const providersLoading = providersQuery.isPending && visibleProviders.length === 0
  const providersUnavailable = providersQuery.isError && visibleProviders.length === 0

  const user = account.user
  const isAdmin = user.role === 'admin'
  const isActive = user.status === 'active'
  const StatusIcon = isActive ? CheckCircleIcon : ProhibitIcon

  return (
    <div className="flex w-full flex-col gap-6">
      <PageHeader
        title="账户设置"
        description="管理登录身份、第三方账号关联与当前会话安全。"
      />

      {accountQuery.isError ? (
        <Alert
          tone="danger"
          title="账户信息刷新失败"
          action={
            <Button variant="secondary" size="sm" onClick={() => void accountQuery.refetch()}>
              重试
            </Button>
          }
        >
          当前展示的是上次加载的数据：{accountQuery.error instanceof Error ? accountQuery.error.message : '网络或服务端错误'}。
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader className="border-b border-border/70 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3.5">
                <Avatar
                  size="lg"
                  initial={user.email}
                  decorative
                  className="bg-tonal-selected text-accent-strong"
                />
                <div className="min-w-0">
                  <CardTitle level={2}>个人身份</CardTitle>
                  <CardDescription className="break-words [overflow-wrap:anywhere]">
                    {user.email || '未设置邮箱'}
                  </CardDescription>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={isAdmin ? 'info' : 'neutral'}>
                  {isAdmin ? '管理员' : '普通用户'}
                </Badge>
                <Badge dot tone={isActive ? 'success' : 'danger'}>
                  {isActive ? '正常' : '已停用'}
                </Badge>
              </div>
            </div>
          </CardHeader>

          <CardBody>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border/70 bg-canvas/60 px-3.5 py-3">
                <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <EnvelopeSimpleIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                  <span>登录邮箱</span>
                </dt>
                <dd className="break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                  {user.email || '—'}
                </dd>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border/70 bg-canvas/60 px-3.5 py-3">
                <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ShieldCheckIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                  <span>账户角色</span>
                </dt>
                <dd className="text-sm font-medium text-foreground">
                  {isAdmin ? '管理员' : '普通用户'}
                </dd>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border/70 bg-canvas/60 px-3.5 py-3">
                <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <StatusIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                  <span>账户状态</span>
                </dt>
                <dd className="text-sm font-medium text-foreground">
                  {isActive ? '正常' : '已停用'}
                </dd>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5 rounded-control border border-border/70 bg-canvas/60 px-3.5 py-3">
                <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <CalendarIcon weight="bold" aria-hidden="true" className={iconSize.xs} />
                  <span>注册时间</span>
                </dt>
                <dd className="font-mono text-sm tabular-nums text-foreground">
                  {formatDateTime(user.createdAt)}
                </dd>
              </div>
            </dl>
          </CardBody>

          {isAdmin ? (
            <CardFooter className="border-t border-border/70 pt-4">
              <p className="text-ui text-muted-foreground">
                你拥有站点管理权限，可前往后台管理模型、用户与系统配置。
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href={APP_ROUTES.admin}>
                  <ShieldCheckIcon weight="bold" aria-hidden="true" />
                  <span>前往管理后台</span>
                  <ArrowUpRightIcon weight="bold" aria-hidden="true" />
                </Link>
              </Button>
            </CardFooter>
          ) : null}
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader className="border-b border-border/70 pb-4">
            <CardTitle level={2}>第三方账号绑定</CardTitle>
            <CardDescription>
              绑定后可直接用第三方账号登录 MuseCanvas。解绑需要二次确认，之后仍可用邮箱验证码继续登录。
            </CardDescription>
          </CardHeader>

          <CardBody className="gap-3">
            {providersLoading ? (
              <p role="status" className="text-sm text-muted-foreground">
                正在读取可绑定的第三方登录方式…
              </p>
            ) : null}

            {providersUnavailable ? (
              <Alert
                tone="warning"
                title="暂时无法读取第三方登录配置"
                action={
                  <Button variant="secondary" size="sm" onClick={() => void providersQuery.refetch()}>
                    重试
                  </Button>
                }
              >
                邮箱登录不受影响。稍后重试即可管理第三方绑定。
              </Alert>
            ) : null}

            {!providersLoading && !providersUnavailable && visibleProviders.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">
                当前没有启用第三方登录方式。需要时请让站点管理员在后台开启 GitHub 或 Google 登录。
              </p>
            ) : null}

            {visibleProviders.length > 0 ? (
              <div className="divide-y divide-border/70">
                {visibleProviders.map((provider) => {
                  const meta = PROVIDERS[provider]
                  const identity = identityOf(provider)
                  const Icon = meta.Icon
                  const linkedAt = identity?.linkedAt ? formatDate(identity.linkedAt) : null
                  return (
                    <div
                      key={provider}
                      className="flex flex-wrap items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 flex-1 basis-44 items-start gap-3">
                        <div
                          className={cn(
                            'flex shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-foreground',
                            controlSquare.md,
                          )}
                        >
                          <Icon className={cn('shrink-0', iconSize.md)} />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-foreground">{meta.label}</p>
                            {identity ? <Badge tone="success">已绑定</Badge> : <Badge tone="neutral">未绑定</Badge>}
                          </div>
                          {identity ? (
                            <p className="break-words text-ui text-muted-foreground [overflow-wrap:anywhere]">
                              {identity.email || identity.displayName || '已授权'}
                              {linkedAt ? ` · 绑定于 ${linkedAt}` : ''}
                            </p>
                          ) : (
                            <p className="text-ui text-muted-foreground">绑定后可直接用它登录。</p>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {identity ? (
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            leadingIcon={<LinkSimpleBreakIcon weight="bold" aria-hidden="true" />}
                            onClick={() => setPendingUnlink(provider)}
                          >
                            解除绑定
                          </Button>
                        ) : (
                          <Button asChild variant="outline" size="sm">
                            <a href={oauthLinkUrl(provider)}>
                              <LinkSimpleIcon weight="bold" aria-hidden="true" />
                              <span>绑定账号</span>
                            </a>
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card className="lg:col-span-12">
          <CardHeader className="border-b border-border/70 pb-4">
            <CardTitle level={2}>会话与安全</CardTitle>
            <CardDescription>
              当前设备通过加密会话凭证保持登录状态。退出后将清除本机登录态并返回登录页。
            </CardDescription>
          </CardHeader>

          <CardBody>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-medium text-foreground">退出当前设备</p>
                <p className="text-ui text-muted-foreground">
                  如需切换账号或在公共设备上结束使用，请安全退出当前会话。
                </p>
              </div>
              <Button
                variant="outline"
                leadingIcon={<SignOutIcon weight="bold" aria-hidden="true" />}
                loading={loggingOut}
                onClick={() => void handleLogout()}
                className="self-start sm:self-auto"
              >
                退出当前会话
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>

      <Dialog
        open={pendingUnlink !== null}
        onClose={() => {
          if (!unlinkMutation.isPending) setPendingUnlink(null)
        }}
        title={pendingUnlink ? `解除 ${PROVIDERS[pendingUnlink].label} 绑定？` : '解除绑定？'}
        description="解绑后该第三方账号将无法登录 MuseCanvas。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={unlinkMutation.isPending}
              onClick={() => setPendingUnlink(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={unlinkMutation.isPending}
              onClick={() => {
                if (pendingUnlink) unlinkMutation.mutate(pendingUnlink)
              }}
            >
              解除绑定
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {pendingUnlink ? PROVIDERS[pendingUnlink].label : '该'} 账号与当前 MuseCanvas 账户的关联会被移除。
          之后仍可使用邮箱验证码登录；需要再次使用第三方登录时，重新绑定即可。
        </p>
      </Dialog>
    </div>
  )
}
