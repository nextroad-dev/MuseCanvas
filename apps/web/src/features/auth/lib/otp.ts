// 6 位数字验证码的纯字符串逻辑：输入清洗、整串粘贴合并、退格删除与焦点推导。
// 与 DOM 无关，node:test 可直接导入（otp-input.tsx 只负责事件与渲染）。

/** 后端签发 6 位数字码（`POST /auth/otp/verify` 的 `code: /^\d{6}$/`）。 */
export const OTP_LENGTH = 6

/** 只保留 ASCII 数字，并截断到验证码长度。 */
export function sanitizeOtpChunk(raw: string, length: number = OTP_LENGTH): string {
  return raw.replace(/[^0-9]/g, '').slice(0, length)
}

/**
 * 把一段（可能多位）数字合并进当前值：从 `index` 起逐位覆盖。
 * 返回的字符串长度不超过 `length`，因此可以安全地直接回写给受控组件。
 */
export function mergeOtpChunk(
  current: string,
  chunk: string,
  index: number,
  length: number = OTP_LENGTH,
): string {
  const digits = current.slice(0, length).split('')
  const start = Math.max(0, Math.min(length - 1, Math.floor(index)))
  for (let offset = 0; offset < chunk.length && start + offset < length; offset += 1) {
    digits[start + offset] = chunk[offset]
  }
  return digits.join('').slice(0, length)
}

/** 删除某个格子的数字；后续数字左移，保持「连续前缀」的取值语义。 */
export function removeOtpDigit(current: string, index: number, length: number = OTP_LENGTH): string {
  if (index < 0 || index >= length) return current.slice(0, length)
  return (current.slice(0, index) + current.slice(index + 1, length)).slice(0, length)
}

/** 当前该聚焦的格子：第一个空位（= 已输入位数）；输满时停在最后一格。 */
export function activeOtpIndex(value: string, length: number = OTP_LENGTH): number {
  const filled = value.slice(0, length).replace(/[^0-9]/g, '').length
  return Math.min(filled, length - 1)
}
