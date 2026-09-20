import type { NormalizedProviderErrorDiagnostic } from './types'

/**
 * Legacy language-model transport error codes (string-matched by apps/api and persisted
 * into prompt_optimizations.error_code; do NOT rename these).
 */
export type LanguageModelErrorCode =
  | 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR'
  | 'PROMPT_OPTIMIZATION_REJECTED'

/**
 * Maps a legacy language-model error code onto the normalized provider code used by
 * plugins, without renaming the source codes.
 */
export function languageErrorToNormalizedCode(
  code: LanguageModelErrorCode,
): Extract<NormalizedProviderErrorDiagnostic['code'], 'PROVIDER_TEMPORARY_ERROR' | 'PROVIDER_REJECTED'> {
  return code === 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR' ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED'
}

const NORMALIZED_PROVIDER_CODES: readonly NormalizedProviderErrorDiagnostic['code'][] = [
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_TEMPORARY_ERROR',
  'PROVIDER_REJECTED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_EMPTY_RESULT',
  'INVALID_REQUEST',
  'INVALID_CONFIG',
  'INVALID_CREDENTIAL',
  'UNSAFE_URL',
  'OUTPUT_READ_FAILED',
  'UNKNOWN_ERROR',
]

export function isNormalizedProviderCode(value: string): value is NormalizedProviderErrorDiagnostic['code'] {
  return (NORMALIZED_PROVIDER_CODES as readonly string[]).includes(value)
}

/**
 * Inverse of `languageErrorToNormalizedCode`: an uploaded plugin signals failure with a
 * normalized provider code (`throw Object.assign(new Error('<CODE>'), { diagnostic })`), and
 * the four existing prompt-optimization callers only understand the legacy pair. Folding
 * through this mapping keeps one vocabulary pair instead of inventing a third; PROVIDER_TIMEOUT
 * has no forward mapping but belongs in the temporary bucket.
 */
export function normalizedCodeToLanguageError(
  code: NormalizedProviderErrorDiagnostic['code'],
): LanguageModelErrorCode {
  const temporary = languageErrorToNormalizedCode('PROMPT_OPTIMIZATION_TEMPORARY_ERROR')
  return code === temporary || code === 'PROVIDER_TIMEOUT'
    ? 'PROMPT_OPTIMIZATION_TEMPORARY_ERROR'
    : 'PROMPT_OPTIMIZATION_REJECTED'
}
