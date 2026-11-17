import type { ParameterErrorDetails } from '@musecanvas/contracts'

/** Safe public command failure. Persistence failures must escape caller-owned transactions. */
export class MediaServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: ParameterErrorDetails,
  ) {
    super(message)
    this.name = 'MediaServiceError'
  }
}

/** Map only at the application boundary, after its transaction has rolled back. */
export function generationCommandError(error: unknown): MediaServiceError {
  if (error instanceof MediaServiceError) return error
  const code = error instanceof Error ? error.message : ''
  if (code === 'IDEMPOTENCY_CONFLICT') return new MediaServiceError(code, '同一请求标识不能用于不同的生成内容', 409)
  if (code === 'MODEL_NOT_AVAILABLE') return new MediaServiceError(code, '模型当前不可用', 409)
  if (code === 'PROVIDER_NOT_CONFIGURED') return new MediaServiceError(code, '生成供应商凭据未配置', 503)
  if (code === 'PROMPT_MODEL_NOT_CONFIGURED') return new MediaServiceError(code, '提示词优化模型配置不完整', 503)
  return new MediaServiceError('GENERATION_CREATE_FAILED', '创建生成任务失败', 503)
}
