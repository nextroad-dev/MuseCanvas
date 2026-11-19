'use client'

import { useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  CaretUpDownIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  ImageIcon,
  ImagesIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  PushPinIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  SparkleIcon,
  TrashIcon,
  UserCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { AgentSessionDTO } from '@musecanvas/contracts'
import {
  useWorkspaceShell,
  type WorkspaceShellContextValue,
} from '@/features/workspace/components/workspace-shell-context'
import { BrandMark } from '@/shared/components/brand-mark'
import {
  Avatar,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  SkeletonRow,
  ThemeToggle,
  iconSize,
} from '@/shared/components/ui'
import { useFlipList } from '@/shared/hooks/useFlipList'
import type { AgentConsoleController } from '@/shared/hooks/useAgentConsole'
import { APP_ROUTES } from '@/shared/lib/app-routes'
import { cn } from '@/shared/lib/cn'
import { formatRelativeTime } from '@/shared/lib/format'
import {
  deriveSessionStatus,
  extractArtifactPreview,
  isSafeDisplayUrl,
  shortUuid,
} from '../lib/agent-status'
import type { ReferenceImageAttachment } from '../stores/agent-console-store'

export interface SessionSidebarProps {
  console?: AgentConsoleController
  sessions?: AgentSessionDTO[]
  activeSessionId?: string | null
  pinnedSessionIds?: string[]
  sessionTitles?: Record<string, string>
  onSelectSession?: (sessionId: string) => void
  onCreateSession?: () => void
  onDeleteSession?: (sessionId: string) => void
  onClearSessions?: () => void
  onTogglePinSession?: (sessionId: string) => void
  onRenameSession?: (sessionId: string, title: string) => void
  onReuseImage?: (attachment: ReferenceImageAttachment) => void
  creatingSession?: boolean
  onCloseMobile?: () => void
  onToggleSidebar?: () => void
  activeRoute?: 'generate' | 'library'
  children?: ReactNode
}

export function resolveSessionTitle(
  session: AgentSessionDTO,
  sessionTitles?: Record<string, string>,
): string {
  const custom = sessionTitles?.[session.id]?.trim()
  if (custom) return custom
  if (session.id === '00000000-0000-4000-8000-000000000401') {
    return '晨雾水乡乌篷船写意参考样片'
  }
  const cleanHex = session.id.replace(/-/g, '').trim()
  const suffix = cleanHex.slice(-4).toUpperCase()
  return suffix ? `对话 #${suffix}` : `对话 ${shortUuid(session.id)}`
}

const FALLBACK_SHELL_STATE: WorkspaceShellContextValue = {
  mode: 'mock',
  user: null,
  loggingOut: false,
  logoutError: null,
  onLogout: () => {},
  onDismissLogoutError: () => {},
}

/**
 * 左侧可折叠工作区侧栏：整合品牌标识、工作区路由导航、会话管理或图库筛选内容，以及底部账户/主题控件。
 * 在 `/generate` 消费 `useAgentConsole` 暴露的会话列表与 `createSession` 动作，在 `/library` 承接图库筛选控件。
 */
export function SessionSidebar({
  console: agentConsole,
  sessions,
  activeSessionId,
  pinnedSessionIds,
  sessionTitles,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onClearSessions,
  onTogglePinSession,
  onRenameSession,
  onReuseImage,
  creatingSession = false,
  onCloseMobile,
  onToggleSidebar,
  activeRoute,
  children,
}: SessionSidebarProps) {
  const router = useRouter()
  const shellState = useWorkspaceShell() ?? FALLBACK_SHELL_STATE
  const currentRoute = activeRoute ?? (agentConsole ? 'generate' : 'library')
  const isDisabledService = agentConsole?.serviceStatus === 'disabled_404'
  const creating = creatingSession || (agentConsole?.mutations.createSession.isPending ?? false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [confirmClearOpen, setConfirmClearOpen] = useState(false)

  const rawSessions = sessions ?? agentConsole?.sessions ?? []
  const pinnedSet = new Set(pinnedSessionIds ?? [])
  const sortedSessions = [
    ...rawSessions.filter((s) => pinnedSet.has(s.id)),
    ...rawSessions.filter((s) => !pinnedSet.has(s.id)),
  ]
  const normalizedFilter = sessionFilter.trim().toLowerCase()
  const displayedSessions = normalizedFilter
    ? sortedSessions.filter((s) =>
        resolveSessionTitle(s, sessionTitles).toLowerCase().includes(normalizedFilter),
      )
    : sortedSessions

  const sessionArtifacts = (agentConsole?.items ?? [])
    .filter((item) => item.type === 'artifact_reference')
    .map((item) => ({ item, preview: extractArtifactPreview(item) }))
    .filter(({ preview }) => isSafeDisplayUrl(preview.thumbnailUrl || preview.url))

  const sessionListRef = useRef<HTMLUListElement>(null)
  const sessionOrderKey = displayedSessions.map((s) => s.id).join(',')
  useFlipList(sessionListRef, sessionOrderKey)

  function commitRename(sessionId: string) {
    const trimmed = editingTitle.trim()
    if (trimmed) {
      onRenameSession?.(sessionId, trimmed)
    }
    setEditingSessionId(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-3.5 pb-2.5">
        <Link
          href={APP_ROUTES.home}
          aria-label="MuseCanvas 首页"
          onClick={() => onCloseMobile?.()}
          className="inline-flex min-w-0 items-center gap-2 rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
        >
          <BrandMark variant="mark" size={24} />
          <span className="truncate text-ui font-semibold tracking-tight text-foreground">
            MuseCanvas
          </span>
        </Link>

        {onToggleSidebar ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="收起会话列表"
            onClick={onToggleSidebar}
            className="shrink-0 rounded-control"
            icon={<SidebarSimpleIcon className={iconSize.md} aria-hidden="true" />}
          />
        ) : null}
      </div>

      <div className="shrink-0 space-y-2 border-b border-border/50 px-3 pb-3">
        {onCreateSession ? (
          <Button
            size="sm"
            variant="secondary"
            fullWidth
            className="justify-start rounded-control"
            loading={creating}
            disabled={isDisabledService || creating}
            onClick={onCreateSession}
            icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
          >
            新建对话
          </Button>
        ) : (
          <Button
            asChild
            size="sm"
            variant="secondary"
            fullWidth
            className="justify-start rounded-control"
            icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
          >
            <Link href={APP_ROUTES.generate} prefetch onClick={() => onCloseMobile?.()}>
              <PlusIcon className={iconSize.sm} aria-hidden="true" />
              <span>新建对话</span>
            </Link>
          </Button>
        )}

        <nav aria-label="工作区导航" className="grid grid-cols-2 gap-1 rounded-control bg-tonal/55 p-1">
          <Link
            href={APP_ROUTES.generate}
            prefetch
            aria-current={currentRoute === 'generate' ? 'page' : undefined}
            onClick={(event) => {
              if (currentRoute === 'generate') event.preventDefault()
              onCloseMobile?.()
            }}
            className={cn(
              'motion-press inline-flex min-h-[var(--control-sm)] min-w-0 items-center justify-center gap-1.5 rounded-control px-2.5 py-1.5 text-ui font-medium',
              currentRoute === 'generate'
                ? 'bg-surface font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-surface/60 hover:text-foreground',
            )}
          >
            <SparkleIcon
              className={cn(iconSize.sm, 'shrink-0', currentRoute === 'generate' ? 'text-accent' : '')}
              weight={currentRoute === 'generate' ? 'fill' : 'regular'}
              aria-hidden="true"
            />
            <span className="truncate">操作台</span>
          </Link>

          <Link
            href={APP_ROUTES.library}
            prefetch
            aria-current={currentRoute === 'library' ? 'page' : undefined}
            onClick={(event) => {
              if (currentRoute === 'library') event.preventDefault()
              onCloseMobile?.()
            }}
            className={cn(
              'motion-press inline-flex min-h-[var(--control-sm)] min-w-0 items-center justify-center gap-1.5 rounded-control px-2.5 py-1.5 text-ui font-medium',
              currentRoute === 'library'
                ? 'bg-surface font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-surface/60 hover:text-foreground',
            )}
          >
            <ImagesIcon
              className={cn(iconSize.sm, 'shrink-0', currentRoute === 'library' ? 'text-accent' : '')}
              weight={currentRoute === 'library' ? 'fill' : 'regular'}
              aria-hidden="true"
            />
            <span className="truncate">作品图库</span>
          </Link>
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {children != null ? (
          children
        ) : agentConsole ? (
          <>
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <h2 className="text-caption font-medium text-muted-foreground">最近对话</h2>
                {sortedSessions.length > 0 ? (
                  <span className="text-caption tabular-nums text-muted-foreground">
                    ({sortedSessions.length})
                  </span>
                ) : null}
              </div>
              {sortedSessions.length > 0 && onClearSessions ? (
                <button
                  type="button"
                  aria-label="清空此设备上的对话"
                  onClick={() => setConfirmClearOpen(true)}
                  className="rounded-control px-1.5 py-0.5 text-caption text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                >
                  清空本机
                </button>
              ) : null}
            </div>

            {sortedSessions.length >= 2 || sessionFilter ? (
              <div className="mb-2.5 flex items-center gap-1.5 rounded-control border border-border/70 bg-surface/75 px-2.5 py-1.5 transition-colors focus-within:border-border-focus focus-within:bg-surface">
                <MagnifyingGlassIcon
                  className={cn(iconSize.xs, 'shrink-0 text-muted-foreground')}
                  aria-hidden="true"
                />
                <input
                  type="text"
                  role="searchbox"
                  aria-label="搜索历史对话"
                  data-session-search="true"
                  placeholder="搜索历史对话…"
                  value={sessionFilter}
                  onChange={(event) => setSessionFilter(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-caption text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
                {sessionFilter ? (
                  <button
                    type="button"
                    aria-label="清除对话搜索"
                    onClick={() => setSessionFilter('')}
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-pill text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className={iconSize.xs} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}

        {agentConsole.sessionsQuery.isPending ? (
          <div aria-busy="true" aria-label="正在加载会话列表" className="space-y-2.5 p-1">
            <SkeletonRow cells={1} />
            <SkeletonRow cells={1} />
            <SkeletonRow cells={1} />
            <SkeletonRow cells={1} />
          </div>
        ) : displayedSessions.length === 0 ? (
          <div className="motion-fade-in">
            <EmptyState
              density="compact"
              icon={ChatCircleDotsIcon}
              title={
                agentConsole.serviceStatus === 'disabled_404'
                  ? 'Agent Core 未启用'
                  : agentConsole.serviceStatus === 'admission_closed_503'
                    ? 'Agent 服务暂不可用'
                    : agentConsole.serviceStatus === 'error'
                      ? '会话列表加载失败'
                      : '暂无 Agent 会话'
              }
              description={
                agentConsole.serviceStatus === 'disabled_404'
                  ? '后端配置关闭了 Agent Core V1（404），暂时无法列出或创建会话。'
                  : agentConsole.serviceStatus === 'admission_closed_503'
                    ? '服务暂时不可用或配置尚未就绪（503），请稍后重试；如持续出现，请联系管理员检查配置。'
                    : agentConsole.serviceStatus === 'error'
                      ? agentConsole.error?.message ?? '请检查网络连接后重试。'
                      : '点击上方「新建对话」按钮，立即开启多轮对话。'
              }
              action={
                agentConsole.serviceStatus === 'admission_closed_503' ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="rounded-pill"
                      onClick={() => agentConsole.reconnect()}
                    >
                      重新检查
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      className="rounded-pill"
                      loading={creating}
                      disabled={creating}
                      onClick={onCreateSession}
                      icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                    >
                      新建对话
                    </Button>
                  </div>
                ) : agentConsole.serviceStatus === 'error' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="rounded-pill"
                    onClick={() => void agentConsole.sessionsQuery.refetch()}
                  >
                    重试
                  </Button>
                ) : agentConsole.serviceStatus === 'ready' ? (
                  <Button
                    size="sm"
                    variant="primary"
                    className="rounded-pill"
                    loading={creating}
                    disabled={creating}
                    onClick={onCreateSession}
                    icon={<PlusIcon className={iconSize.sm} aria-hidden="true" />}
                  >
                    新建对话
                  </Button>
                ) : null
              }
            />
          </div>
        ) : (
          <ul ref={sessionListRef} className="space-y-1.5" role="list" aria-label="Agent 会话列表">
            {displayedSessions.map((session) => {
              const selected = session.id === activeSessionId
              const isPinned = pinnedSet.has(session.id)
              const status = deriveSessionStatus(session)
              const isRunning = status === 'active'
              const statusLabel =
                status === 'active' ? '运行中' : status === 'archived' ? '已归档' : null
              const titleLabel = resolveSessionTitle(session, sessionTitles)
              const isEditing = editingSessionId === session.id

              return (
                <li key={session.id} data-flip-key={session.id}>
                  <div
                    className={cn(
                      'group relative flex w-full min-w-0 items-center rounded-card border transition-colors',
                      selected
                        ? 'border-border/80 bg-surface text-foreground shadow-soft'
                        : 'border-transparent bg-transparent text-foreground/90 hover:bg-surface/60 hover:text-foreground',
                    )}
                  >
                    {isEditing ? (
                      <div className="flex w-full min-w-0 items-center gap-1 px-2.5 py-2">
                        <input
                          type="text"
                          aria-label="编辑对话名称"
                          value={editingTitle}
                          onChange={(event) => setEditingTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commitRename(session.id)
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              setEditingSessionId(null)
                            }
                          }}
                          autoFocus
                          className="min-w-0 flex-1 rounded-control border border-border-focus bg-canvas px-2 py-1 text-ui text-foreground outline-none"
                        />
                        <button
                          type="button"
                          aria-label="保存对话名称"
                          onClick={() => commitRename(session.id)}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-accent transition-colors hover:bg-tonal"
                        >
                          <CheckIcon className={iconSize.xs} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label="取消重命名"
                          onClick={() => setEditingSessionId(null)}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-tonal hover:text-foreground"
                        >
                          <XIcon className={iconSize.xs} aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => {
                            onSelectSession?.(session.id)
                            onCloseMobile?.()
                          }}
                          className="motion-press flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 text-left group-hover:pr-20 group-focus-within:pr-20"
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            {isRunning ? (
                              <span
                                aria-hidden="true"
                                className="size-2 shrink-0 animate-pulse rounded-pill bg-accent"
                              />
                            ) : null}
                            {isPinned ? (
                              <PushPinIcon
                                weight="fill"
                                className={cn(iconSize.xs, 'shrink-0 text-accent')}
                                aria-hidden="true"
                              />
                            ) : null}
                            <span className="truncate text-ui font-medium">{titleLabel}</span>
                          </div>

                          <div className="flex min-w-0 items-center justify-between gap-2 text-caption text-muted-foreground">
                            <span className="truncate">{formatRelativeTime(session.updatedAt)}</span>
                            {statusLabel ? (
                              <span
                                className={cn(
                                  'shrink-0',
                                  isRunning ? 'font-medium text-accent' : 'text-muted-foreground',
                                )}
                              >
                                {statusLabel}
                              </span>
                            ) : null}
                          </div>
                        </button>

                        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-control bg-surface/90 p-0.5 opacity-0 backdrop-blur-xs transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          {onTogglePinSession ? (
                            <button
                              type="button"
                              aria-label={isPinned ? '取消置顶对话' : '置顶对话'}
                              onClick={(event) => {
                                event.stopPropagation()
                                onTogglePinSession(session.id)
                              }}
                              className={cn(
                                'inline-flex size-6 items-center justify-center rounded-control transition-colors hover:bg-tonal',
                                isPinned ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
                              )}
                            >
                              <PushPinIcon
                                weight={isPinned ? 'fill' : 'regular'}
                                className={iconSize.xs}
                                aria-hidden="true"
                              />
                            </button>
                          ) : null}
                          {onRenameSession ? (
                            <button
                              type="button"
                              aria-label="重命名对话"
                              onClick={(event) => {
                                event.stopPropagation()
                                setEditingSessionId(session.id)
                                setEditingTitle(titleLabel)
                              }}
                              className="inline-flex size-6 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-tonal hover:text-foreground"
                            >
                              <PencilSimpleIcon className={iconSize.xs} aria-hidden="true" />
                            </button>
                          ) : null}
                          {onDeleteSession ? (
                            <button
                              type="button"
                              aria-label="在此设备隐藏对话"
                              title="仅在此设备隐藏，不删除服务端记录"
                              onClick={(event) => {
                                event.stopPropagation()
                                onDeleteSession(session.id)
                              }}
                              className="inline-flex size-6 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                            >
                              <TrashIcon className={iconSize.xs} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {agentConsole.hasMoreSessions ? (
          <div className="pt-3">
            <Button
              size="sm"
              variant="ghost"
              fullWidth
              className="rounded-pill"
              loading={agentConsole.sessionsQuery.isFetchingNextPage}
              onClick={() => agentConsole.loadMoreSessions()}
            >
              加载更多会话
            </Button>
          </div>
        ) : null}

        {sessionArtifacts.length > 0 ? (
          <section
            aria-label="本对话生成产物"
            className="mt-4 space-y-2 border-t border-border/50 pt-3.5"
          >
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-caption font-medium text-muted-foreground">
                本对话产物 ({sessionArtifacts.length})
              </span>
              <Link
                href={APP_ROUTES.library}
                prefetch
                onClick={() => onCloseMobile?.()}
                className="text-caption font-medium text-accent hover:underline"
              >
                全部图库
              </Link>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {sessionArtifacts.slice(0, 6).map(({ item, preview }) => {
                const url = (preview.thumbnailUrl || preview.url)!
                const label = preview.label || preview.prompt?.slice(0, 20) || '生成产物'
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-label={`复用产物参考图：${label}`}
                    onClick={() => {
                      onReuseImage?.({
                        id: preview.assetId ? `art-${preview.assetId}` : `art-${item.id}`,
                        url,
                        name: label,
                        mimeType: preview.mimeType ?? undefined,
                        width: preview.width ?? undefined,
                        height: preview.height ?? undefined,
                        source: 'artifact',
                        assetId: preview.assetId ?? undefined,
                        prompt: preview.prompt ?? undefined,
                      })
                      onCloseMobile?.()
                    }}
                    className="group relative aspect-square overflow-hidden rounded-control border border-border/70 bg-tonal"
                  >
                    <img
                      src={url}
                      alt={label}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-[var(--motion-spring-gentle)] ease-spring-gentle group-hover:scale-[1.03] motion-reduce:transition-none"
                    />
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-overlay/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <ImageIcon className={cn(iconSize.sm, 'text-on-media')} aria-hidden="true" />
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}
          </>
        ) : null}
      </div>

      <div className="mt-auto shrink-0 space-y-2 border-t border-border/60 px-3 py-2.5">
        {shellState.logoutError ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-2 rounded-control border border-danger-border bg-danger-soft px-2.5 py-2 text-caption text-danger"
          >
            <span className="min-w-0 break-words">{shellState.logoutError}</span>
            <button
              type="button"
              aria-label="关闭退出登录错误提示"
              onClick={shellState.onDismissLogoutError}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-control text-danger hover:bg-danger/10"
            >
              <XIcon className={iconSize.xs} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {shellState.user ? (
          <div className="flex items-center justify-between gap-2">
            <DropdownMenu
              menuLabel="账户菜单"
              align="start"
              side="top"
              className="min-w-0 flex-1"
              menuClassName="w-full min-w-56"
              trigger={
                <button
                  type="button"
                  aria-label="账户菜单"
                  className="motion-press flex min-h-[var(--control-sm)] w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-tonal/60"
                >
                  <Avatar
                    size="sm"
                    initial={shellState.user.email}
                    decorative
                    className="bg-tonal-selected"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-foreground">
                      {shellState.user.email}
                    </span>
                    <span className="block truncate text-caption text-muted-foreground">
                      {shellState.user.role === 'admin' ? '管理员' : '创作者'}
                    </span>
                  </span>
                  <CaretUpDownIcon
                    className={cn(iconSize.xs, 'shrink-0 text-muted-foreground')}
                    aria-hidden="true"
                  />
                </button>
              }
              items={[
                {
                  id: 'account',
                  label: '账户设置',
                  icon: <UserCircleIcon className={iconSize.sm} aria-hidden="true" />,
                  onSelect: () => {
                    onCloseMobile?.()
                    router.push(APP_ROUTES.account)
                  },
                },
                ...(shellState.user.role === 'admin'
                  ? [
                      {
                        id: 'admin',
                        label: '管理后台',
                        icon: <ShieldCheckIcon className={iconSize.sm} aria-hidden="true" />,
                        onSelect: () => {
                          onCloseMobile?.()
                          router.push(APP_ROUTES.admin)
                        },
                      },
                    ]
                  : []),
                {
                  id: 'logout',
                  label: shellState.loggingOut ? '正在退出…' : '退出登录',
                  icon: <SignOutIcon className={iconSize.sm} aria-hidden="true" />,
                  danger: true,
                  separator: true,
                  disabled: shellState.loggingOut,
                  onSelect: () => {
                    void shellState.onLogout()
                  },
                },
              ]}
            />
            <ThemeToggle className="shrink-0" />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">
              <Avatar
                size="sm"
                initial={shellState.mode === 'mock' ? 'M' : '?'}
                decorative
                className="bg-tonal-selected"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-foreground">
                  {shellState.mode === 'mock' ? '本地演示用户' : '未登录访客'}
                </span>
                <span role="note" className="block truncate text-caption text-muted-foreground">
                  {shellState.mode === 'mock' ? 'Mock 本地演示' : '未登录'}
                </span>
              </span>
            </div>
            <ThemeToggle className="shrink-0" />
          </div>
        )}
      </div>

      <Dialog
        open={confirmClearOpen}
        onClose={() => setConfirmClearOpen(false)}
        title="清空此设备上的对话"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                onClearSessions?.()
                setConfirmClearOpen(false)
              }}
            >
              确认清空本机
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground [text-wrap:pretty]">
          只会清除此设备上的会话显示，不会删除服务端对话记录，也不会影响其他设备。清除后，这些会话将不再出现在当前设备的列表中。
        </p>
      </Dialog>
    </div>
  )
}
