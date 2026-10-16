import { NextResponse } from 'next/server'
import { db, requestProviderCredentialTest } from '@musecanvas/database'
import { fail, ok } from '../../../shared/http'

/**
 * POST /api/admin/provider-credentials/:id/test
 *
 * The API never probes a provider itself: it opens a test request on the
 * credential row and apps/worker (the only process that runs plugin code)
 * claims and settles it — see apps/worker/src/credentials/probe.ts. A typical
 * probe settles within the wait below, so the response usually carries the
 * outcome just as before; a slow one answers 202 `pending` and the row's
 * `lastTestStatus` turns final once the worker is done.
 */

/** A little over the worker's probe timeout plus one claim interval. */
export const CREDENTIAL_TEST_WAIT_MS = 20_000
const POLL_INTERVAL_MS = 400

const FAILURE_MESSAGES: Record<string, string> = {
  NO_API_KEY: '未配置凭据内容，无法测试',
  INVALID_CREDENTIAL: '凭据无法解密或未通过插件校验，请重新录入凭据内容',
  PROMPT_MODEL_NOT_CONFIGURED: '请先将该凭据关联到已启用的语言模型',
  PLUGIN_NOT_LINKED: '没有可用于测试该凭据的媒体插件，请先关联模型或从插件模板创建凭据',
  PLUGIN_NOT_REGISTERED: '该凭据对应的供应商插件尚未可用，请稍后重试',
  PLUGIN_PROBE_UNSUPPORTED: '该插件不支持连接测试，请通过一次生成任务验证',
  PROVIDER_REJECTED: '凭据已连接到供应商，但被拒绝访问，请检查模型授权或凭据权限',
  PROVIDER_TEMPORARY_ERROR: '供应商暂时不可用，请稍后重试',
  PROVIDER_EMPTY_RESULT: '供应商没有返回可用结果',
  PROMPT_OPTIMIZATION_REJECTED: '语言模型拒绝了测试请求，请检查 API Key 与模型权限',
  PROMPT_OPTIMIZATION_TEMPORARY_ERROR: '语言模型服务暂时不可用，请稍后重试',
  LANGUAGE_MODEL_RESPONSE_INVALID: '语言模型返回了无法解析的结果',
}

/** The message shown for a settled failure code; unknown codes get a generic hint. */
export function credentialTestFailureMessage(code: string): string {
  return FAILURE_MESSAGES[code] ?? '凭据测试失败，请检查凭据内容和 Base URL'
}

type TestRow = { last_test_status: string | null; last_test_error_code: string | null; test_requested_at: Date | null }

/**
 * The settled outcome, or null while a request is still open. When a newer click
 * superseded this request, the row's latest outcome is the one worth showing, so
 * there is no per-request matching here: whatever settles first is returned.
 */
export function settledOutcome(row: TestRow | undefined): { status: 'success' } | { status: 'failed'; code: string } | null {
  if (!row || row.test_requested_at !== null) return null
  if (row.last_test_status === 'success') return { status: 'success' }
  if (row.last_test_status === 'failed') return { status: 'failed', code: row.last_test_error_code || 'CONNECTIVITY_FAILED' }
  return null
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function testProviderCredential(
  actor: { id: string },
  id: string,
  options: { waitMs?: number } = {},
): Promise<NextResponse> {
  const opened = await requestProviderCredentialTest(db(), id, actor.id)
  if (!opened) return fail('NOT_FOUND', '供应商凭据不存在', 404)
  const deadline = Date.now() + (options.waitMs ?? CREDENTIAL_TEST_WAIT_MS)
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const r = await db().query<TestRow>(
      'SELECT last_test_status,last_test_error_code,test_requested_at FROM provider_credentials WHERE id=$1',
      [id],
    )
    const outcome = settledOutcome(r.rows[0])
    if (!outcome) continue
    return outcome.status === 'success'
      ? ok({ tested: true, status: 'success' })
      : fail(outcome.code, credentialTestFailureMessage(outcome.code))
  }
  return ok({ tested: false, status: 'pending' }, { status: 202 })
}
