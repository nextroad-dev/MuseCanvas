// 安装向导的步骤模型与完成判定（纯逻辑，node:test 可直接导入）。
//
// 完成状态唯一来自服务端：`GET /setup/status` 的 `sections`（bootstrap 由 status
// 读取时自动标记，smtp/storage 只有在连接测试通过后才 complete）。本模块不推断
// 「做过就算完成」，缺失数据一律按未完成处理。

import type {
  OnboardingSectionKey,
  OnboardingSectionState,
  SetupStatusResponse,
} from '@musecanvas/contracts'

export type SetupStepId =
  | 'claim'
  | 'bootstrap'
  | 'site'
  | 'smtp'
  | 'admin'
  | 'storage'
  | 'runtime'
  | 'templates'
  | 'complete'

export interface SetupStepDefinition {
  id: SetupStepId
  /** 步骤条上的短标签。 */
  label: string
  title: string
  description: string
}

/**
 * 顺序按服务端依赖排列：SMTP 必须先于管理员步骤，因为首个管理员的验证码
 * 是通过邮件发送的（历史实现同样把「邮件」放在「管理员」之前）。
 */
export const SETUP_STEPS: readonly SetupStepDefinition[] = [
  {
    id: 'claim',
    label: '领取',
    title: '领取初始化码',
    description: '输入服务端生成的一次性领取码，验证通过后才能开始配置。',
  },
  {
    id: 'bootstrap',
    label: '环境',
    title: '环境诊断',
    description: '检查数据库、缓存、应用主密钥与运行环境；未通过项需要先在部署侧修复。',
  },
  {
    id: 'site',
    label: '站点',
    title: '站点信息',
    description: '实例名称与公开访问地址，用于邮件、OAuth 回调与分享链接。',
  },
  {
    id: 'smtp',
    label: '邮件',
    title: 'SMTP 邮件',
    description: '管理员验证码通过邮件发送，因此需要先验证 SMTP 连接。',
  },
  {
    id: 'admin',
    label: '管理员',
    title: '创建管理员',
    description: '管理员邮箱会收到一次性验证码，验证通过后即成为第一个管理员账号。',
  },
  {
    id: 'storage',
    label: '存储',
    title: '对象存储',
    description: '生成作品的保存位置：S3 兼容存储或本地磁盘目录。',
  },
  {
    id: 'runtime',
    label: '运行参数',
    title: '运行时限制',
    description: '上传、签名链接与任务等运行时上限，保存后生效。',
  },
  {
    id: 'templates',
    label: '模板',
    title: '提示词模板',
    description: '可选步骤：导入提示词模板集，也可以完成安装后在后台管理。',
  },
  {
    id: 'complete',
    label: '完成',
    title: '完成初始化',
    description: '确认必填步骤全部完成后结束安装。',
  },
]

/** 完成初始化必须为 complete 的六个段（`packages/database` 的 REQUIRED_COMPLETION_SECTIONS）。 */
export const REQUIRED_COMPLETION_SECTIONS: ReadonlyArray<{ key: OnboardingSectionKey; label: string }> = [
  { key: 'bootstrap', label: '环境诊断' },
  { key: 'site', label: '站点信息' },
  { key: 'smtp', label: 'SMTP 邮件（连接已验证）' },
  { key: 'admin', label: '管理员账号' },
  { key: 'storage', label: '对象存储（连接已验证）' },
  { key: 'runtime', label: '运行时限制' },
]

/** 只有服务端明确给出 `false` 才跳过领取码（与后端 resolveClaimRequired 一致）。 */
export function isSetupClaimRequired(claimRequired: boolean | null | undefined): boolean {
  return claimRequired !== false
}

export interface SetupProgressInput {
  /** 服务端已认可初始化访问（成功读到 /setup/config，或领取码已验证）。 */
  hasAccess: boolean
  claimRequired: boolean | null | undefined
  setupComplete: boolean
  sections: Partial<Record<OnboardingSectionKey, Pick<OnboardingSectionState, 'status'>>> | null | undefined
  /** `status.bootstrap.ready`：四项引导检查全部通过。 */
  bootstrapReady: boolean
  /** 可选步骤被用户主动跳过（仅影响步骤条与导航，不写服务端）。 */
  templatesSkipped?: boolean
}

export interface ResolvedSetupStep extends SetupStepDefinition {
  complete: boolean
}

function sectionDone(input: SetupProgressInput, key: OnboardingSectionKey): boolean {
  return input.sections?.[key]?.status === 'complete'
}

/** 领取码为必需时的步骤列表；claim-optional 部署直接不显示领取步骤。 */
export function setupStepDefinitions(
  claimRequired: boolean | null | undefined,
): readonly SetupStepDefinition[] {
  return isSetupClaimRequired(claimRequired)
    ? SETUP_STEPS
    : SETUP_STEPS.filter((step) => step.id !== 'claim')
}

export function isSetupStepDone(id: SetupStepId, input: SetupProgressInput): boolean {
  switch (id) {
    case 'claim':
      // 没有领取码要求时这一步天然满足；claim-required 下成功读到受保护配置也算已通过
      //（管理员会话或旧 setup 会话同样代表访问已开放）。
      return !isSetupClaimRequired(input.claimRequired) || input.hasAccess
    case 'bootstrap':
      return sectionDone(input, 'bootstrap') || input.bootstrapReady
    case 'site':
      return sectionDone(input, 'site')
    case 'smtp':
      return sectionDone(input, 'smtp')
    case 'admin':
      return sectionDone(input, 'admin')
    case 'storage':
      return sectionDone(input, 'storage')
    case 'runtime':
      return sectionDone(input, 'runtime')
    case 'templates':
      return sectionDone(input, 'templates') || input.templatesSkipped === true
    case 'complete':
      return input.setupComplete
  }
}

export function resolveSetupSteps(input: SetupProgressInput): ResolvedSetupStep[] {
  return setupStepDefinitions(input.claimRequired).map((step) => ({
    ...step,
    complete: isSetupStepDone(step.id, input),
  }))
}

/** 第一个未完成的步骤；全部完成时停在最后一步。 */
export function resolveResumeIndex(steps: ReadonlyArray<{ complete: boolean }>): number {
  const index = steps.findIndex((step) => !step.complete)
  return index === -1 ? Math.max(0, steps.length - 1) : index
}

/** `?step=` 深链若指向当前列表不存在的步骤（例如 claim-optional 的 claim），回落到恢复位置。 */
export function resolveActiveStepIndex(
  steps: ReadonlyArray<{ id: SetupStepId; complete: boolean }>,
  requested: SetupStepId | null,
): number {
  const resumeIndex = resolveResumeIndex(steps)
  if (requested === null) return resumeIndex
  const index = steps.findIndex((step) => step.id === requested)
  return index === -1 ? resumeIndex : index
}

/** 进度文案：`第 2 / 8 步`。 */
export function setupStepPosition(steps: ReadonlyArray<unknown>, index: number): string {
  return `第 ${index + 1} / ${steps.length} 步`
}

/** 标题下的说明：只列出本部署实际会出现的步骤。 */
export function setupIntroDescription(claimRequired: boolean | null | undefined): string {
  const names = isSetupClaimRequired(claimRequired)
    ? '领取、环境诊断、站点、邮件、管理员、存储、运行参数、模板与完成'
    : '环境诊断、站点、邮件、管理员、存储、运行参数、模板与完成'
  return `按顺序完成${names}。已完成的步骤可以随时回来修改。`
}

export function parseSetupStepId(raw: string | null | undefined): SetupStepId | null {
  if (!raw) return null
  return SETUP_STEPS.find((step) => step.id === raw)?.id ?? null
}

export function setupStepDefinition(id: SetupStepId): SetupStepDefinition {
  const definition = SETUP_STEPS.find((step) => step.id === id)
  if (!definition) throw new Error(`unknown setup step: ${id}`)
  return definition
}

export interface SetupChecklistItem {
  key: OnboardingSectionKey
  label: string
  complete: boolean
}

/** 完成页的检查清单，与服务端 completion gate 一一对应。 */
export function buildCompletionChecklist(
  sections: SetupStatusResponse['sections'] | null | undefined,
): SetupChecklistItem[] {
  return REQUIRED_COMPLETION_SECTIONS.map(({ key, label }) => ({
    key,
    label,
    complete: sections?.[key]?.status === 'complete',
  }))
}

export function canCompleteSetup(items: ReadonlyArray<SetupChecklistItem>): boolean {
  return items.length > 0 && items.every((item) => item.complete)
}

/** 未完成项的可读列表，用于 `SETUP_INCOMPLETE` 的就地说明。 */
export function incompleteChecklistLabels(items: ReadonlyArray<SetupChecklistItem>): string[] {
  return items.filter((item) => !item.complete).map((item) => item.label)
}
