// Step model shared by the setup wizard page and its progress UI.
import type { OnboardingSectionKey } from '@/shared/types'

export type SetupStepId =
  | 'claim'
  | 'site'
  | 'smtp-admin'
  | 'storage'
  | 'providers-models'
  | 'oauth-templates'
  | 'runtime'
  | 'review'

export interface SetupStep {
  id: SetupStepId
  label: string
  optional: boolean
  sections: OnboardingSectionKey[]
}

export const SETUP_STEPS: SetupStep[] = [
  { id: 'claim', label: '实例验证', optional: false, sections: ['bootstrap'] },
  { id: 'site', label: '站点', optional: false, sections: ['site'] },
  { id: 'smtp-admin', label: '邮件与管理员', optional: false, sections: ['smtp', 'admin'] },
  { id: 'storage', label: '对象存储', optional: false, sections: ['storage'] },
  { id: 'providers-models', label: '供应商与模型', optional: true, sections: ['providers', 'models'] },
  { id: 'oauth-templates', label: '登录与模板', optional: true, sections: ['oauth', 'templates'] },
  { id: 'runtime', label: '高级设置', optional: false, sections: ['runtime'] },
  { id: 'review', label: '检查并完成', optional: false, sections: [] },
]

export function isSetupStepId(value: unknown): value is SetupStepId {
  return SETUP_STEPS.some((step) => step.id === value)
}

/**
 * Resume target derived from server section status: the first required step
 * with an incomplete section. Optional steps may stay pending (skipped), so
 * they never determine the resume position; users can still reach them via
 * the stepper or `?step=`.
 */
export function resumeStepId(
  sectionStatus: (key: OnboardingSectionKey) => 'pending' | 'complete',
): SetupStepId {
  for (const step of SETUP_STEPS) {
    if (step.optional || step.sections.length === 0) continue
    if (step.sections.some((key) => sectionStatus(key) !== 'complete')) {
      return step.id
    }
  }
  return 'review'
}
