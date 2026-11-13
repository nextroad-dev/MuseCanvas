'use client'

// 账户页客户端岛：账户信息（RSC 已守卫并给出首屏数据）+ 第三方绑定管理 + 退出登录。
// 服务端状态全部走 TanStack Query（useAccount / useOAuthProviders），这里只持有
// 「待确认解绑的 provider」这类易失 UI 态。

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CalendarIcon as Calendar,
  LinkSimpleBreakIcon as Unlink,
  LinkSimpleIcon as LinkIcon,
  SignOutIcon as SignOut,
} from '@phosphor-icons/react'

import { clientApi } from '@/shared/services/client-api'
import { useAccount } from '@/shared/hooks/useAccount'
import { oauthLinkUrl, useAuth, useOAuthProviders } from '@/shared/hooks/useAuth'
import { queryKeys } from '@/shared/hooks/query-keys'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatDate, formatDateTime } from '@/shared/lib/format'
import { useAuthUiStore } from '@/shared/stores/auth-ui-store'
import type { AccountDto, OAuthProvider } from '@/shared/types'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  PageHeader,
  buttonVariants,
  iconSize,
  useToast,
} from '@/shared/components/ui'
import { GithubIcon, GoogleIcon } from '@/features/auth/components/brand-icons'
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

  return (
    <div className="mx-auto flex w-full max-w-[var(--container-content)] flex-col gap-8 px-4 py-8 md:px-8">
      <PageHeader
        title="账户"
        description="查看账户信息，管理第三方登录方式。"
        actions={
          <Button
            variant="outline"
            icon={<SignOut weight="bold" aria-hidden="true" />}
            loading={loggingOut}
            onClick={() => void handleLogout()}
          >
            退出登录
          </Button>
        }
      />

      <div className="flex w-full max-w-[var(--content-narrow)] flex-col gap-6">
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

        <Card>
          <CardHeader>
            <CardTitle level={2}>账户信息</CardTitle>
            <CardDescription>登录身份与注册信息，此处仅供查看。</CardDescription>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">登录邮箱</dt>
                <dd className="break-words text-sm text-foreground [overflow-wrap:anywhere]">
                  {user.email || '—'}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">账户角色</dt>
                <dd>
                  <Badge tone={user.role === 'admin' ? 'info' : 'neutral'}>
                    {user.role === 'admin' ? '管理员' : '普通用户'}
                  </Badge>
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Calendar weight="bold" aria-hidden="true" className={iconSize.xs} />
                  注册时间
                </dt>
                <dd className="font-mono text-sm tabular-nums text-foreground">
                  {formatDateTime(user.createdAt)}
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle level={2}>第三方账号</CardTitle>
            <CardDescription>
              绑定后可直接用第三方账号登录 MuseCanvas。解绑需要二次确认，之后可用邮箱验证码继续登录。
            </CardDescription>
          </CardHeader>
          <CardBody>
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
              <p className="text-sm text-muted-foreground">
                当前没有启用第三方登录方式。需要时请让站点管理员在后台开启 GitHub 或 Google 登录。
              </p>
            ) : null}

            {visibleProviders.map((provider) => {
              const meta = PROVIDERS[provider]
              const identity = identityOf(provider)
              const Icon = meta.Icon
              const linkedAt = identity?.linkedAt ? formatDate(identity.linkedAt) : null
              return (
                <div
                  key={provider}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-tonal p-4"
                >
                  <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon className={cn('shrink-0 text-foreground', iconSize.sm)} />
                      <p className="text-sm font-medium text-foreground">{meta.label}</p>
                      {identity ? <Badge tone="success">已绑定</Badge> : <Badge tone="neutral">未绑定</Badge>}
                    </div>
                    {identity ? (
                      <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                        {identity.email || identity.displayName || '已授权'}
                        {linkedAt ? ` · 绑定于 ${linkedAt}` : ''}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">绑定后可直接用它登录。</p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {identity ? (
                      <Button
                        variant="danger-ghost"
                        size="md"
                        icon={<Unlink weight="bold" aria-hidden="true" />}
                        onClick={() => setPendingUnlink(provider)}
                      >
                        解绑
                      </Button>
                    ) : (
                      <a
                        href={oauthLinkUrl(provider)}
                        className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'gap-2')}
                      >
                        <LinkIcon weight="bold" aria-hidden="true" className={iconSize.sm} />
                        绑定账号
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
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
