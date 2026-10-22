'use client'

import {
  useEffect, useRef, useState } from 'react'
import { useMutation,
  useQuery,
  useQueryClient } from '@tanstack/react-query'
import { API_ENDPOINTS,
  type OAuthProviderName } from '@musecanvas/contracts'
import { api } from '@/shared/services/api'
import type { OAuthIdentity,
  OAuthProvider,
  UserProfile } from '@/shared/types'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Divider,
  EmptyState,
  PageHeader,
  SectionHeader,
  Skeleton,
  SkeletonText,
  buttonVariants,
  useToast,
  iconSize,
} from '@/shared/components/ui'
import { ContentFrame } from '@/shared/components/content-frame'
import { GithubIcon, GoogleIcon } from '@/shared/components/brand-icons'
import { formatDate } from '@/shared/lib/format'
import { cn } from '@/shared/lib/cn'
import {
  CalendarIcon as Calendar,
  LinkSimpleIcon as Link2,
  EnvelopeSimpleIcon as Mail,
  ShieldCheckIcon as ShieldCheck,
  LinkSimpleBreakIcon as Unlink,
  XIcon as X,
} from '@phosphor-icons/react'

/** The two providers this page can offer, in display order. */
const PROVIDERS: { name: OAuthProviderName; label: string }[] = [
  { name: 'github', label: 'GitHub' },
  { name: 'google', label: 'Google' },
]

/** Compact inner navigation; IDs remain stable for direct hash links. */
const SECTIONS = [
  { id: 'profile', label: '个人资料' },
  { id: 'linked-accounts', label: '账号安全' },
]

/**
 * The contract answers 401/403 with `error.code`, and states.md §5 wants 无权限 told
 * apart from 加载失败 — so the code has to survive into the query error instead of
 * collapsing into a message string.
 */
class AccountRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AccountRequestError'
    this.code = code
  }
}

function isPermissionFailure(error: unknown): boolean {
  const code = error instanceof AccountRequestError ? error.code : ''
  return /FORBIDDEN|UNAUTHORIZED|ACCOUNT_UNAVAILABLE|CSRF_REJECTED|HTTP_40[13]/.test(code)
}

export function AccountView() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id)
  const contentRef = useRef<HTMLDivElement>(null)
  const savingRef = useRef(false)
  const [unlinkFeedback, setUnlinkFeedback] = useState<string | null>(null)

  useEffect(() => {
    const content = contentRef.current
    const scroller = content?.closest('main')
    if (!content || !scroller) return
    const syncPosition = () => {
      const security = content.querySelector('#linked-accounts')
      if (!security) return
      const nearBottom = scroller.scrollHeight > scroller.clientHeight
        && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8
      setActiveSection(nearBottom || security.getBoundingClientRect().top <= scroller.getBoundingClientRect().top + 128
        ? 'linked-accounts' : 'profile')
    }
    const syncHash = () => {
      const id = window.location.hash.slice(1)
      if (SECTIONS.some((section) => section.id === id)) setActiveSection(id)
      else syncPosition()
    }
    syncHash()
    scroller.addEventListener('scroll', syncPosition, { passive: true })
    window.addEventListener('hashchange', syncHash)
    const observer = new ResizeObserver(syncPosition)
    observer.observe(content)
    return () => {
      scroller.removeEventListener('scroll', syncPosition)
      window.removeEventListener('hashchange', syncHash)
      observer.disconnect()
    }
  }, [])

  // Providers marked for removal but not yet saved, and the ones currently in
  // flight. Both are keyed by provider so one slow request cannot grey out the
  // other row the way a single shared `isPending` did.
  const [stagedUnlinks, setStagedUnlinks] = useState<OAuthProviderName[]>([])
  const [unlinking, setUnlinking] = useState<OAuthProviderName[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)

  const {
    data: userProfile,
    isLoading: profileLoading,
    isError: profileIsError,
    error: profileError,
    refetch: refetchProfile,
  } = useQuery({
    queryKey: ['account', 'me'],
    queryFn: async () => {
      const res = await api.getMe()
      if (!res.success || !res.data) {
        throw new AccountRequestError(res.error?.code || 'UNKNOWN', res.error?.message || '获取用户资料失败')
      }
      return res.data as UserProfile
    },
  })

  const {
    data: identitiesData,
    isLoading: identitiesLoading,
    isError: identitiesIsError,
    error: identitiesError,
    refetch: refetchIdentities,
  } = useQuery<OAuthIdentity[], AccountRequestError>({
    queryKey: ['account', 'oauth-identities'],
    queryFn: async () => {
      const res = await api<OAuthIdentity[]>(API_ENDPOINTS.account.oauth)
      if (!res.success) {
        throw new AccountRequestError(res.error?.code || 'UNKNOWN', res.error?.message || '获取第三方绑定列表失败')
      }
      return res.data || []
    },
  })

  const identities = identitiesData ?? []

  const unlinkMutation = useMutation({
    mutationFn: async (provider: OAuthProviderName) => {
      const res = await api(API_ENDPOINTS.account.oauthUnlink(provider), { method: 'DELETE' })
      if (!res.success) throw new Error(res.error?.message || '解除绑定失败')
      return res.data
    },
    onSuccess: (_data, provider) => {
      queryClient.invalidateQueries({ queryKey: ['account', 'oauth-identities'] })
      toast.push({
        title: `已解除 ${PROVIDERS.find((item) => item.name === provider)?.label ?? provider} 绑定`,
        variant: 'success',
      })
    },
    onError: (error: Error, provider) => {
      toast.push({
        title: `无法解除 ${PROVIDERS.find((item) => item.name === provider)?.label ?? provider} 绑定`,
        description: `${error.message}。请检查网络后重新保存更改。`,
        variant: 'error',
      })
    },
  })

  function identityOf(provider: OAuthProvider): OAuthIdentity | undefined {
    return identities.find((identity) => identity.provider === provider)
  }

  function toggleStaged(provider: OAuthProviderName) {
    setStagedUnlinks((prev) =>
      prev.includes(provider) ? prev.filter((item) => item !== provider) : [...prev, provider],
    )
  }

  /** Commits every staged removal. Each row keeps its own busy state, and a failed
   *  provider stays staged so the user can save it again without re-marking it. */
  async function saveUnlinks() {
    if (savingRef.current) return
    savingRef.current = true
    setConfirmOpen(false)
    const targets = stagedUnlinks
    if (targets.length === 0) {
      savingRef.current = false
      return
    }
    setUnlinking((prev) => [...prev, ...targets])
    const results = await Promise.allSettled(targets.map((provider) => unlinkMutation.mutateAsync(provider)))
    const succeeded = targets.filter((_, index) => results[index].status === 'fulfilled')
    setUnlinking((prev) => prev.filter((provider) => !targets.includes(provider)))
    setStagedUnlinks((prev) => prev.filter((provider) => !succeeded.includes(provider)))
    const failed = targets.length - succeeded.length
    setUnlinkFeedback(failed ? `${failed} 个绑定未能解除，已保留待保存更改。请检查网络后重试。` : null)
    savingRef.current = false
  }

  function renderSectionState({
    isError,
    error,
    objectName,
    onRetry,
  }: {
    isError: boolean
    error: unknown
    objectName: string
    onRetry: () => void
  }) {
    if (!isError) return null
    if (isPermissionFailure(error)) {
      return (
        <EmptyState
          variant="no-permission"
          objectName={objectName}
          density="compact"
          description="你没有访问该设置的权限，或登录状态已失效。重新登录后即可继续修改。"
          action={
            <a href="/login" className={buttonVariants({ variant: 'secondary' })}>
              重新登录
            </a>
          }
        />
      )
    }
    return (
      <EmptyState
        variant="error"
        objectName={objectName}
        density="compact"
        description={`无法读取${objectName}：${error instanceof Error ? error.message : '网络或服务端错误'}。请稍后刷新重试。`}
        onAction={onRetry}
      />
    )
  }

  const profileSectionError = renderSectionState({
    isError: profileIsError && !profileLoading && !userProfile,
    error: profileError,
    objectName: '账户资料',
    onRetry: () => void refetchProfile(),
  })

  const identitiesSectionError = renderSectionState({
    isError: identitiesIsError && !identitiesLoading && !identitiesData,
    error: identitiesError,
    objectName: '第三方绑定',
    onRetry: () => void refetchIdentities(),
  })

  const hasStagedChanges = stagedUnlinks.length > 0

  return (
    <ContentFrame className="motion-page-enter py-6 md:py-8">
      <div className="flex flex-col gap-10">
        <PageHeader
          title="账户与安全"
          description="个人资料与登录方式，在这里安心管理。"
        />

        <div ref={contentRef} className="flex w-full max-w-[var(--content-narrow)] flex-col gap-8">
          <nav aria-label="账户页内目录" className="flex flex-wrap gap-2">
            {SECTIONS.map((section) => (
              <a key={section.id} href={`#${section.id}`} aria-current={section.id === activeSection ? 'location' : undefined}
                className={cn('inline-flex min-h-10 items-center rounded-control px-4 py-2 text-sm transition-colors',
                  section.id === activeSection ? 'bg-tonal-selected font-medium text-foreground' : 'text-muted-foreground hover:bg-tonal-hover hover:text-foreground')}>
                {section.label}
              </a>
            ))}
          </nav>
          {unlinkFeedback ? <Alert tone="danger" title="部分绑定未能解除">{unlinkFeedback}</Alert> : null}
          <div className="flex min-w-0 flex-col gap-10">
            {/* 基本资料 — a section on the page canvas: heading, rule-free body, no box. */}
            <section id="profile" aria-labelledby="profile-title" className="flex scroll-mt-4 flex-col gap-6">
              {profileIsError && userProfile ? (
                <Alert tone="danger" title="资料刷新失败" action={<Button variant="secondary" onClick={() => void refetchProfile()}>重试</Button>}>当前保留已加载资料：{profileError instanceof Error ? profileError.message : '网络或服务端错误'}。</Alert>
              ) : null}
              <SectionHeader id="profile-title" title="基本资料" description="账户的基础信息，此处仅供查看。" />
              {profileSectionError ? (
                profileSectionError
              ) : (
                <div className="flex flex-col gap-6">
                    {profileLoading ? (
                      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2" aria-busy>
                        {[0, 1, 2].map((slot) => (
                          <div key={slot} className={cn('flex min-w-0 items-start gap-3', slot === 0 && 'sm:col-span-2')}>
                            <Skeleton className={`mt-1 ${iconSize.sm} shrink-0`} />
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                              <SkeletonText lines={1} width="42%" />
                              <SkeletonText lines={1} width={slot === 1 ? '58%' : '72%'} />
                            </div>
                          </div>
                        ))}
                        <p className="sr-only">正在加载账户资料…</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                        <div className="flex min-w-0 items-start gap-3 sm:col-span-2">
                          <Mail weight="bold" aria-hidden="true" className={`mt-1 ${iconSize.sm} shrink-0 text-muted-foreground`} />
                          <div className="flex min-w-0 flex-col gap-1">
                            <p className="text-xs text-muted-foreground">登录邮箱</p>
                            <p className="break-words text-sm text-foreground [overflow-wrap:anywhere]">{userProfile?.email || '—'}</p>
                          </div>
                        </div>

                        <div className="flex items-start gap-3">
                          <ShieldCheck weight="bold" aria-hidden="true" className={`mt-1 ${iconSize.sm} shrink-0 text-muted-foreground`} />
                          <div className="flex min-w-0 flex-col gap-1">
                            <p className="text-xs text-muted-foreground">账户权限</p>
                            <p className="text-sm text-foreground">
                              {userProfile?.role === 'admin' ? (
                                <Badge tone="info">管理员</Badge>
                              ) : (
                                <Badge tone="neutral">普通用户</Badge>
                              )}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-start gap-3">
                          <Calendar weight="bold" aria-hidden="true" className={`mt-1 ${iconSize.sm} shrink-0 text-muted-foreground`} />
                          <div className="flex min-w-0 flex-col gap-1">
                            <p className="text-xs text-muted-foreground">注册时间</p>
                            <p className="font-mono text-sm tabular-nums text-foreground">
                              {formatDate(userProfile?.createdAt)}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                </div>
              )}
            </section>

            <Divider />

            {/* 第三方账号绑定 — the only section that writes, hence the save bar. */}
            <section id="linked-accounts" aria-labelledby="linked-accounts-title" className="flex scroll-mt-4 flex-col gap-4">
              {identitiesIsError && identitiesData ? (
                <Alert tone="danger" title="绑定信息刷新失败" action={<Button variant="secondary" onClick={() => void refetchIdentities()}>重试</Button>}>当前保留已加载绑定和待保存更改：{identitiesError?.message || '网络或服务端错误'}。</Alert>
              ) : null}
              <SectionHeader
                id="linked-accounts-title"
                title="账号安全"
                description="管理第三方登录方式。解除绑定会先暂存，保存并确认后才生效。"
              />
              {identitiesSectionError ? (
                identitiesSectionError
              ) : (
                <div className="flex flex-col gap-3">
                    {identitiesLoading ? (
                      <div className="flex flex-col gap-3" aria-busy>
                        {PROVIDERS.map((provider) => (
                          <div
                            key={provider.name}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-tonal p-4"
                          >
                            <div className="flex min-w-0 flex-1 items-start gap-2">
                              <Skeleton className="mt-0.5 h-4 w-4 shrink-0" />
                              <div className="flex min-w-0 flex-1 flex-col gap-2">
                                <SkeletonText lines={1} width="40%" />
                                <SkeletonText lines={1} width="72%" />
                              </div>
                            </div>
                            <Skeleton className="h-[var(--control-md)] w-24 rounded-control" />
                          </div>
                        ))}
                        <p className="sr-only">正在加载第三方绑定…</p>
                      </div>
                    ) : (
                      PROVIDERS.map((provider) => {
                        const identity = identityOf(provider.name)
                        const linked = Boolean(identity)
                        const pending = unlinking.includes(provider.name)
                        const staged = stagedUnlinks.includes(provider.name)
                        return (
                          // Each provider is its own tonal band: layering without a box.
                          <div
                            key={provider.name}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-tonal p-4"
                          >
                            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-2">
                              <div className="flex items-center gap-2">
                                {provider.name === 'github' ? (
                                  <GithubIcon className="h-4 w-4 shrink-0 text-foreground" />
                                ) : (
                                  <GoogleIcon className="h-4 w-4 shrink-0" />
                                )}
                                <p className="text-sm font-medium text-foreground">{provider.label}</p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {linked ? (
                                  <Badge tone="success">已绑定</Badge>
                                ) : (
                                  <Badge tone="neutral">未绑定</Badge>
                                )}
                                {staged ? <Badge tone="warning">待解除绑定</Badge> : null}
                                {identity?.email ? (
                                  <span className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{identity.email}</span>
                                ) : null}
                                {identity?.linkedAt ? (
                                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                    绑定于 {formatDate(identity.linkedAt)}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              {pending ? (
                                <Button variant="secondary" size="md" loading>
                                  解除中
                                </Button>
                              ) : linked ? (
                                staged ? (
                                  <Button
                                    variant="ghost"
                                    size="md"
                                    icon={<X weight="bold" aria-hidden="true" />}
                                    onClick={() => toggleStaged(provider.name)}
                                  >
                                    取消解除
                                  </Button>
                                ) : (
                                  <Button
                                    variant="danger-ghost"
                                    size="md"
                                    icon={<Unlink weight="bold" aria-hidden="true" />}
                                    onClick={() => toggleStaged(provider.name)}
                                  >
                                    解除绑定
                                  </Button>
                                )
                              ) : (
                                /* 绑定账号 leaves this app for the provider, so it is a
                                   link wearing button styling, never a button. */
                                <a
                                  href={API_ENDPOINTS.account.oauthLinkStart(provider.name)}
                                  className={buttonVariants({ variant: 'secondary' })}
                                >
                                  <Link2 weight="bold" aria-hidden="true" />
                                  绑定账号
                                </a>
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}
                </div>
              )}
            </section>
          </div>
        </div>

        {/* 设置页 bottom save bar: sticky, ghost 取消 + primary 保存, and only present
            while something is actually waiting to be written. */}
        {hasStagedChanges ? (
          <div className="motion-reveal sticky bottom-0 z-sticky flex w-full max-w-[var(--content-narrow)] flex-wrap items-center justify-between gap-3 rounded-panel bg-surface p-4 shadow-floating">
              <p className="text-sm text-muted-foreground">
                已标记 {stagedUnlinks.length} 个待解除的绑定，保存后生效。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" disabled={unlinking.length > 0} onClick={() => { setStagedUnlinks([]); setUnlinkFeedback(null) }}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  loading={unlinking.length > 0}
                  onClick={() => setConfirmOpen(true)}
                >
                  保存更改
                </Button>
              </div>
          </div>
        ) : null}
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        size="narrow"
        title={`确定要解除 ${stagedUnlinks.length} 个第三方账号的绑定吗？`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void saveUnlinks()}>
              解除绑定
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          解除后你将无法再使用
          {' '}
          {stagedUnlinks
            .map((provider) => PROVIDERS.find((item) => item.name === provider)?.label ?? provider)
            .join('、')}
          {' '}
          登录 MuseCanvas，需要重新前往第三方授权才能恢复。此操作无法撤销。
        </p>
      </Dialog>
    </ContentFrame>
  )
}
