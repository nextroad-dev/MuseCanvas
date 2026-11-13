'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { clientApi } from '@/shared/services/client-api'
import { Alert, Badge, Button, Field, Input, buttonVariants } from '@/shared/components/ui'
import type { BootstrapDiagnostics } from '@musecanvas/contracts'
import {
  describeSetupError,
  isSetupAlreadyComplete,
  isSetupClaimNotRequired,
  isSetupSessionError,
} from '../../lib/setup-errors'
import { SetupStepShell } from '../setup-step-shell'

export interface ClaimStepProps {
  /** 服务端已认可初始化访问（成功读到受保护的配置）。 */
  hasAccess: boolean
  /** 启动期引导检查：未通过时领取本身也可能失败，先给出部署侧提示。 */
  bootstrap: BootstrapDiagnostics | null
  /** 领取成功：由向导刷新状态并前进。 */
  onClaimed: () => void | Promise<void>
}

/**
 * 领取一次性初始化码。领取码只写入服务端日志 / 领取码文件，任何 API 都不会返回它。
 * claim-optional 部署不会出现这一步（步骤列表里直接没有 claim）。
 */
export function ClaimStep({ hasAccess, bootstrap, onClaimed }: ClaimStepProps) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const claim = useMutation({
    mutationFn: () => clientApi.setup.claim({ code: code.trim() }),
    onSuccess: async () => {
      setError(null)
      setCode('')
      await onClaimed()
    },
    onError: async (cause: unknown) => {
      // 状态可能是旧的：服务端已不需要领取码 / 已完成初始化时，刷新并前进，不展示错误。
      if (isSetupClaimNotRequired(cause) || isSetupAlreadyComplete(cause)) {
        await onClaimed()
        return
      }
      if (isSetupSessionError(cause)) {
        setError(
          '领取码无效、已过期或已被使用。请到 API 服务启动日志（以 [MUSECANVAS SETUP CLAIM] 开头）或领取码文件中获取最新领取码后重试。',
        )
        return
      }
      setError(describeSetupError(cause, '领取失败，请稍后重试。'))
    },
  })

  if (hasAccess) {
    return (
      <SetupStepShell
        headingId="setup-claim-title"
        title="领取初始化码"
        description="一次性领取码用于证明你有权初始化这个实例。"
        status={<Badge tone="success">已领取</Badge>}
      >
        <Alert tone="success" role="status" title="初始化会话有效">
          领取码已验证。初始化会话 30 分钟内有效，超时后需要重新领取；其余步骤可以随时回来修改。
        </Alert>
      </SetupStepShell>
    )
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (claim.isPending) return
    if (!code.trim()) {
      setError('请输入领取码。')
      return
    }
    setError(null)
    claim.mutate()
  }

  return (
    <SetupStepShell
      headingId="setup-claim-title"
      title="领取初始化码"
      description="输入服务端生成的一次性领取码，验证通过后才能继续配置。"
    >
      {error ? (
        <Alert tone="danger" role="alert" title="无法领取">
          {error}
        </Alert>
      ) : null}

      {bootstrap && !bootstrap.ready ? (
        <Alert
          tone="warning"
          role="status"
          title="启动环境检查未全部通过"
          action={
            <a href="/setup" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              重新检测
            </a>
          }
        >
          领取与保存都依赖数据库与缓存服务。请先在部署侧修复以下问题，然后刷新本页：
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
            {bootstrap.checks
              .filter((check) => check.status !== 'ok')
              .map((check) => (
                <li key={check.key}>
                  {check.key === 'database'
                    ? '数据库'
                    : check.key === 'redis'
                      ? '缓存服务'
                      : check.key === 'masterKey'
                        ? '应用主密钥'
                        : '运行环境'}
                  ：{check.message ?? '未就绪'}
                </li>
              ))}
          </ul>
        </Alert>
      ) : null}

      <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
        <Field
          id="setup-claim-code"
          label="领取码"
          required
          hint="原样粘贴即可，首尾空格会被忽略。"
        >
          <Input
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
            value={code}
            disabled={claim.isPending}
            onChange={(event) => {
              setCode(event.target.value)
              if (error) setError(null)
            }}
          />
        </Field>
        <div>
          <Button type="submit" loading={claim.isPending}>
            领取并开始
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-2 rounded-control bg-tonal p-4">
        <h3 className="text-sm font-medium text-foreground">领取码在哪里找</h3>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground marker:text-muted-foreground">
          <li>
            查看 API 服务启动日志中以 <code className="font-mono text-foreground">[MUSECANVAS SETUP CLAIM]</code>{' '}
            开头的记录，复制其中的 code 值。
          </li>
          <li>
            若部署配置了领取码文件（<code className="font-mono text-foreground">SETUP_CLAIM_FILE</code>），打开该文件即可看到。
          </li>
          <li>领取码 15 分钟内有效且只能使用一次；重新生成后旧码立即失效。</li>
        </ol>
      </div>
    </SetupStepShell>
  )
}
