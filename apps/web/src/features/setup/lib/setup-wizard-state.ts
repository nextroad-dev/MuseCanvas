// Pure wizard state: step resolution from the stored section statuses, the claim and
// OTP error copy, and the database driver cards. Type-only imports keep this module
// loadable by `node --experimental-strip-types`.
import type { OnboardingSectionKey, OnboardingSectionState, SetupDatabaseStatus } from '@musecanvas/contracts'

export type SetupStepId = 'claim' | 'site' | 'smtp' | 'admin' | 'database' | 'storage' | 'complete'

export interface SetupStepDefinition {
  id: SetupStepId
  /** Short stepper label: it has to fit a 360px row of up to seven steps. */
  label: string
  title: string
  description: string
}

export const SETUP_STEPS: readonly SetupStepDefinition[] = [
  {
    id: 'claim',
    label: '领取',
    title: '领取初始化码',
    description: '输入服务端生成的一次性领取码，以开始本次初始化。',
  },
  {
    id: 'site',
    label: '站点',
    title: '站点信息',
    description: '实例的名称与公开访问地址，用于邮件、OAuth 回调与分享链接。',
  },
  {
    id: 'smtp',
    label: '邮件',
    title: 'SMTP 邮件',
    description: '管理员验证码通过邮件发送，因此必须先验证 SMTP 连接。',
  },
  {
    id: 'admin',
    label: '管理员',
    title: '创建管理员',
    description: '管理员邮箱将收到一次性验证码，验证通过后即为第一个管理员账号。',
  },
  {
    id: 'database',
    label: '数据库',
    title: '数据库',
    description: '数据库连接在部署时通过 DATABASE_URL 设置，此处只读取其状态。',
  },
  {
    id: 'storage',
    label: '存储',
    title: '对象存储',
    description: '生成的图像与视频资产保存位置：S3 兼容存储或本地磁盘目录。',
  },
  {
    id: 'complete',
    label: '完成',
    title: '运行参数与完成',
    description: '确认运行时限制，检查各步骤状态后完成初始化。',
  },
]

export interface SetupProgressInput {
  claimed: boolean
  /** `SetupStatusResponse.claimRequired`. Absent means required (the safe default for older servers). */
  claimRequired?: boolean
  setupComplete: boolean
  sections?: Partial<Record<OnboardingSectionKey, Pick<OnboardingSectionState, 'status'>>> | null
  databaseReachable: boolean
}

export interface ResolvedSetupStep extends SetupStepDefinition {
  complete: boolean
}

function sectionDone(sections: SetupProgressInput['sections'], key: OnboardingSectionKey): boolean {
  return sections?.[key]?.status === 'complete'
}

/** Only an explicit `false` from the server opens setup without a claim code. */
export function isSetupClaimRequired(claimRequired: boolean | null | undefined): boolean {
  return claimRequired !== false
}

/**
 * The ordered steps the wizard shows. The claim step is present only when the server requires a
 * claim code; the stepper, navigation, numbering and resume all read this list.
 */
export function setupStepDefinitions(claimRequired: boolean | null | undefined): readonly SetupStepDefinition[] {
  return isSetupClaimRequired(claimRequired) ? SETUP_STEPS : SETUP_STEPS.filter((step) => step.id !== 'claim')
}

/** Completion is a stored fact per step. Missing data counts as not done, never as done. */
export function isSetupStepDone(id: SetupStepId, input: SetupProgressInput): boolean {
  switch (id) {
    case 'claim':
      // Without a required claim there is nothing to enter, so the step counts as satisfied.
      return !isSetupClaimRequired(input.claimRequired) || input.claimed
    case 'site':
      return sectionDone(input.sections, 'site')
    case 'smtp':
      return sectionDone(input.sections, 'smtp')
    case 'admin':
      return sectionDone(input.sections, 'admin')
    case 'database':
      return input.databaseReachable
    case 'storage':
      return sectionDone(input.sections, 'storage')
    case 'complete':
      return input.setupComplete
  }
}

export function resolveSetupSteps(input: SetupProgressInput): ResolvedSetupStep[] {
  return setupStepDefinitions(input.claimRequired).map((step) => ({ ...step, complete: isSetupStepDone(step.id, input) }))
}

/** The first step that is not complete; the last step when everything is already done. */
export function resolveResumeIndex(steps: ReadonlyArray<{ complete: boolean }>): number {
  const index = steps.findIndex((step) => !step.complete)
  return index === -1 ? Math.max(0, steps.length - 1) : index
}

/**
 * Index of the step to show. A `?step=` deep link that is not in the resolved list (for example
 * `claim` while the claim is not required) falls back to the resume index, never to the first step.
 */
export function resolveActiveStepIndex(steps: ReadonlyArray<{ id: SetupStepId; complete: boolean }>, requested: SetupStepId | null): number {
  const resumeIndex = resolveResumeIndex(steps)
  if (requested === null) return resumeIndex
  const index = steps.findIndex((step) => step.id === requested)
  return index === -1 ? resumeIndex : index
}

/** Human position for the progress copy, e.g. `第 2 / 6 步`, counted from the resolved list. */
export function setupStepPosition(steps: ReadonlyArray<unknown>, index: number): string {
  return `第 ${index + 1} / ${steps.length} 步`
}

/** Shown on the first visible step only, and only while no claim code is required. */
export function shouldShowOpenSetupNotice(claimRequired: boolean | null | undefined, activeIndex: number): boolean {
  return !isSetupClaimRequired(claimRequired) && activeIndex === 0
}

export const OPEN_SETUP_NOTICE = '初始化期间任何能访问此地址的人都可以配置，创建管理员后此页面将自动仅对管理员开放。'

/** Intro sentence under the page title; it names only the steps this server will show. */
export function setupIntroDescription(claimRequired: boolean | null | undefined): string {
  const names = isSetupClaimRequired(claimRequired) ? '领取、站点、邮件、管理员、数据库、存储与运行参数' : '站点、邮件、管理员、数据库、存储与运行参数'
  return `按顺序完成${names}。已完成的步骤可以随时回来修改。`
}

export function parseSetupStepId(raw: string | null | undefined): SetupStepId | null {
  return SETUP_STEPS.find((step) => step.id === raw)?.id ?? null
}

export function stepDefinition(id: SetupStepId): SetupStepDefinition {
  const definition = SETUP_STEPS.find((step) => step.id === id)
  if (!definition) throw new Error(`unknown setup step ${id}`)
  return definition
}

// ---------------------------------------------------------------- completion gate

export interface SetupChecklistItem {
  key: OnboardingSectionKey
  label: string
  complete: boolean
}

/** Sections the server requires before `setup.complete` succeeds (plus an active admin, implied by `admin`). */
const REQUIRED_SECTIONS: ReadonlyArray<{ key: OnboardingSectionKey; label: string }> = [
  { key: 'bootstrap', label: '环境引导（服务端启动检查）' },
  { key: 'site', label: '站点信息' },
  { key: 'smtp', label: 'SMTP 邮件（已验证）' },
  { key: 'admin', label: '管理员账号' },
  { key: 'storage', label: '对象存储（已验证）' },
  { key: 'runtime', label: '运行时限制' },
]

export function resolveCompletionChecklist(sections: SetupProgressInput['sections']): SetupChecklistItem[] {
  return REQUIRED_SECTIONS.map(({ key, label }) => ({ key, label, complete: sectionDone(sections, key) }))
}

export function canCompleteSetup(items: ReadonlyArray<SetupChecklistItem>): boolean {
  return items.length > 0 && items.every((item) => item.complete)
}

// ---------------------------------------------------------------- claim

const CLAIM_LOCATION_HINT = '领取码 15 分钟内有效且只能使用一次。请到 API 服务日志中查找最新一条以 [MUSECANVAS SETUP CLAIM] 开头的记录，复制其中的 code 值。'

/** Session-scoped codes: any of these means the operator must claim again. */
export function isSetupSessionError(code: string | null | undefined): boolean {
  return code === 'SETUP_SESSION_INVALID' || code === 'SETUP_SESSION_EXPIRED' || code === 'SETUP_SESSION_CONSUMED' || code === 'UNAUTHORIZED'
}

/**
 * What a failed claim means on screen. `SETUP_CLAIM_NOT_REQUIRED` is not an error for the operator:
 * the cached status is stale, so it is refetched and the wizard moves on without a message.
 */
export type ClaimFailureOutcome = { kind: 'refetch-status' } | { kind: 'message'; message: string }

export function claimFailureOutcome(code: string | null | undefined): ClaimFailureOutcome {
  if (code === 'SETUP_CLAIM_NOT_REQUIRED') return { kind: 'refetch-status' }
  return { kind: 'message', message: claimErrorMessage(code) }
}

export function claimErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'INVALID_INPUT':
      return '请输入领取码。'
    case 'SETUP_SESSION_INVALID':
    case 'SETUP_SESSION_EXPIRED':
    case 'SETUP_SESSION_CONSUMED':
    case 'UNAUTHORIZED':
      return `领取码无效、已过期或已被使用。${CLAIM_LOCATION_HINT}`
    case 'RATE_LIMITED':
      return '验证尝试过多，已暂时锁定。请约 10 分钟后再试。'
    case 'SETUP_ALREADY_COMPLETE':
      return '系统已完成初始化，请使用管理员账号登录。'
    case 'NETWORK_ERROR':
    case 'ABORTED':
      return '无法连接服务，请检查网络后重试。'
    default:
      return '领取失败，请稍后重试。'
  }
}

/** Session expiry during a later step sends the operator back to the claim step. */
export function sessionLostMessage(): string {
  return `初始化会话已过期，请重新领取。${CLAIM_LOCATION_HINT}`
}

// ---------------------------------------------------------------- administrator OTP

export const ADMIN_OTP_LENGTH = 6
export const OTP_RESEND_COOLDOWN_SECONDS = 60

/** Whole seconds left before a new code may be requested; 0 when resending is allowed. */
export function resendCooldownRemaining(sentAtMs: number | null, nowMs: number): number {
  if (sentAtMs === null) return 0
  return Math.max(0, OTP_RESEND_COOLDOWN_SECONDS - Math.floor((nowMs - sentAtMs) / 1000))
}

export function adminRequestErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'INVALID_INPUT':
      return '邮箱格式不正确。'
    case 'RATE_LIMITED':
      return '请求过于频繁，请稍后再试。'
    case 'EMAIL_DELIVERY_FAILED':
      return '验证码邮件发送失败。请确认 SMTP 已验证通过后重试。'
    case 'SETUP_ALREADY_COMPLETE':
      return '管理员账号已存在，无需再次创建。'
    case 'SETUP_SESSION_INVALID':
    case 'SETUP_SESSION_EXPIRED':
    case 'SETUP_SESSION_CONSUMED':
    case 'UNAUTHORIZED':
      return sessionLostMessage()
    default:
      return '发送验证码失败，请稍后重试。'
  }
}

export function adminVerifyErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'INVALID_OTP':
      return '验证码错误或已过期，请检查邮件或重新发送。'
    case 'RATE_LIMITED':
      return '验证尝试过多，请稍后再试。'
    case 'SETUP_ALREADY_COMPLETE':
      return '管理员账号已存在，无需再次创建。'
    case 'SETUP_SESSION_INVALID':
    case 'SETUP_SESSION_EXPIRED':
    case 'SETUP_SESSION_CONSUMED':
    case 'UNAUTHORIZED':
      return sessionLostMessage()
    default:
      return '创建管理员失败，请稍后重试。'
  }
}

// ---------------------------------------------------------------- database

export interface DatabaseDriverCard {
  id: string
  label: string
  selected: boolean
  enabled: boolean
  /** Why the card is disabled. Null when enabled. */
  reason: string | null
}

/** Cards mirror the server's driver list exactly: availability and reason are never inferred here. */
export function databaseDriverCards(status: Pick<SetupDatabaseStatus, 'driver' | 'availableDrivers'> | null | undefined): DatabaseDriverCard[] {
  if (!status) return []
  return status.availableDrivers.map((driver) => ({
    id: driver.id,
    label: driver.label,
    selected: driver.id === status.driver,
    enabled: driver.available,
    reason: driver.available ? null : driver.reason?.trim() || '当前版本暂不支持此驱动',
  }))
}

/** Host and user name are partially masked; the summary never carries the password. */
export function maskConnectionValue(value: string | null | undefined): string {
  if (!value) return '未提供'
  if (value.length <= 4) return `${value.slice(0, 1)}•••`
  return `${value.slice(0, 2)}•••${value.slice(-2)}`
}
