'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { OnboardingSectionKey, SetupStatusResponse } from '@musecanvas/contracts'

import { Alert, Badge, Button } from '@/shared/components/ui'
import { clientApi } from '@/shared/services/client-api'
import { describeSetupError, isSetupAlreadyComplete, isSetupSessionError } from '../../lib/setup-errors'
import {
  buildCompletionChecklist,
  canCompleteSetup,
  incompleteChecklistLabels,
} from '../../lib/setup-steps'
import type { SetupStepId } from '../../lib/setup-steps'
import { SetupStepShell } from '../setup-step-shell'

export interface CompleteStepProps {
  status: SetupStatusResponse
  /** 完成成功：向导会重新读取 status 并切到「安装已完成」视图。 */
  onCompleted: () => void | Promise<void>
  onSessionLost: (message: string) => void
  /** 点击未完成项时跳转到对应配置步骤。 */
  onSelectStep?: (stepId: SetupStepId) => void
}

const SECTION_TO_STEP: Partial<Record<OnboardingSectionKey, SetupStepId>> = {
  bootstrap: 'bootstrap',
  site: 'site',
  smtp: 'smtp',
  admin: 'admin',
  storage: 'storage',
  runtime: 'runtime',
}

/**
 * 最后一步：检查清单（六个必填段）+ `POST /setup/complete`。
 * 服务端在同一事务里再次校验必填段与管理员，缺段返回 `SETUP_INCOMPLETE`。
 */
export function CompleteStep({ status, onCompleted, onSessionLost, onSelectStep }: CompleteStepProps) {
  const [error, setError] = useState<string | null>(null)
  const checklist = buildCompletionChecklist(status.sections)
  const ready = canCompleteSetup(checklist)
  const missing = incompleteChecklistLabels(checklist)

  const finish = useMutation({
    mutationFn: () => clientApi.setup.complete(),
    onSuccess: async () => {
      setError(null)
      await onCompleted()
    },
    onError: (cause: unknown) => {
      if (isSetupSessionError(cause)) {
        onSessionLost(describeSetupError(cause, '初始化会话已失效。'))
        return
      }
      // 已经完成（并发/重复提交）：刷新状态即可切到完成页。
      if (isSetupAlreadyComplete(cause)) {
        void onCompleted()
        return
      }
      setError(describeSetupError(cause, '完成初始化失败，请稍后重试。'))
    },
  })

  return (
    <SetupStepShell
      headingId="setup-complete-title"
      title="完成初始化"
      description="初始化完成后向导会关闭，后续配置请以管理员身份登录后台修改。"
      status={<Badge tone={ready ? 'success' : 'warning'}>{ready ? '可以完成' : '尚未就绪'}</Badge>}
    >
      {error ? (
        <Alert tone="danger" role="alert" title="无法完成初始化">
          {error}
        </Alert>
      ) : null}

      <section aria-labelledby="setup-checklist-title" className="flex flex-col gap-3">
        <h2 id="setup-checklist-title" className="text-sm font-medium text-foreground">
          必填步骤检查清单
        </h2>
        <ul className="flex flex-col divide-y divide-border rounded-control border border-border/70 bg-tonal px-4">
          {checklist.map((item) => {
            const targetStep = SECTION_TO_STEP[item.key]
            return (
              <li key={item.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-sm text-foreground">{item.label}</span>
                <div className="flex items-center gap-2">
                  {!item.complete && targetStep && onSelectStep ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => onSelectStep(targetStep)}
                    >
                      去配置
                    </Button>
                  ) : null}
                  <Badge tone={item.complete ? 'success' : 'warning'}>{item.complete ? '已完成' : '待完成'}</Badge>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <div className="flex flex-col gap-2">
        <div>
          <Button
            size="md"
            loading={finish.isPending}
            disabled={!ready || finish.isPending}
            onClick={() => finish.mutate()}
          >
            完成初始化
          </Button>
        </div>
        {ready ? (
          <p className="text-xs text-muted-foreground">
            注意：完成后初始化入口关闭，当前管理员会话保留；如需调整配置请登录后台。
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            还有未完成的步骤：{missing.join('、')}。请返回对应步骤完成后回到这里。
          </p>
        )}
      </div>
    </SetupStepShell>
  )
}
