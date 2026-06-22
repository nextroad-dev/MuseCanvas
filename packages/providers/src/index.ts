export { encryptApiKey, decryptApiKey, fingerprintApiKey } from './crypto'
export type GenerateInput = { adapter: 'openai' | 'seedream'; vendorModelId: string; baseUrl?: string; apiKey?: string; prompt: string; size: string; quality?: string; count: number; watermark: boolean }
export type GeneratedImage = { data: Buffer; mimeType: string; width: number; height: number }

export function providerEndpoint(adapter: GenerateInput['adapter'], configuredBaseUrl?: string): string {
  const fallback = adapter === 'openai' ? process.env.OPENAI_BASE_URL || 'https://api.openai.com' : process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com'
  const base = (configuredBaseUrl || fallback).replace(/\/$/, '')
  if (adapter === 'openai') return `${base.endsWith('/v1') ? base : `${base}/v1`}/images/generations`
  return `${base.endsWith('/api/v3') ? base : `${base}/api/v3`}/images/generations`
}

function dimensions(data: Buffer): { width: number; height: number } {
  if (data.length > 24 && data.subarray(1, 4).toString() === 'PNG') return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < data.length) { if (data[offset] !== 0xff) { offset++; continue }; const marker = data[offset + 1]; const length = data.readUInt16BE(offset + 2); if (marker >= 0xc0 && marker <= 0xc3) return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) }; offset += 2 + length }
  }
  throw new Error('UNSUPPORTED_IMAGE_FORMAT')
}
async function checkedDownload(url: string): Promise<GeneratedImage> {
  if (new URL(url).protocol !== 'https:') throw new Error('UNSAFE_PROVIDER_URL')
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) }); if (!response.ok) throw new Error('PROVIDER_DOWNLOAD_FAILED')
  const declared = response.headers.get('content-type')?.split(';')[0] || ''; const data = Buffer.from(await response.arrayBuffer())
  if (data.length === 0 || data.length > Number(process.env.MAX_IMAGE_BYTES || 25_000_000)) throw new Error('INVALID_IMAGE_SIZE')
  const size = dimensions(data); const mimeType = declared === 'image/jpeg' || data[0] === 0xff ? 'image/jpeg' : 'image/png'
  return { data, mimeType, ...size }
}
export async function generateImages(input: GenerateInput): Promise<GeneratedImage[]> {
  const resolveApiKey = (envKey: string) => {
    if (input.apiKey) return input.apiKey
    if (process.env.ALLOW_PROVIDER_ENV_FALLBACK === 'true') return process.env[envKey] || ''
    throw new Error('PROVIDER_NOT_CONFIGURED')
  }
  if (input.adapter === 'openai') {
    const apiKey = resolveApiKey('OPENAI_API_KEY')
    if (!apiKey) throw new Error('PROVIDER_NOT_CONFIGURED')
    const response = await fetch(providerEndpoint('openai', input.baseUrl), { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: input.vendorModelId, prompt: input.prompt, size: input.size, quality: input.quality, output_format: 'png', n: input.count }), signal: AbortSignal.timeout(Number(process.env.PROVIDER_TIMEOUT_MS || 300_000)) })
    if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED')
    const json = await response.json() as { data?: { b64_json?: string }[] }; if (!json.data?.length) throw new Error('PROVIDER_EMPTY_RESULT')
    return json.data.map(item => { if (!item.b64_json) throw new Error('PROVIDER_EMPTY_RESULT'); const data = Buffer.from(item.b64_json, 'base64'); if (data.length > Number(process.env.MAX_IMAGE_BYTES || 25_000_000)) throw new Error('INVALID_IMAGE_SIZE'); return { data, mimeType: 'image/png', ...dimensions(data) } })
  }
  const apiKey = resolveApiKey('ARK_API_KEY')
  if (!apiKey) throw new Error('PROVIDER_NOT_CONFIGURED')
  const response = await fetch(providerEndpoint('seedream', input.baseUrl), { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: input.vendorModelId, prompt: input.prompt, size: input.size, response_format: 'url', watermark: input.watermark, stream: false, ...(input.count > 1 ? { sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: input.count } } : {}) }), signal: AbortSignal.timeout(Number(process.env.PROVIDER_TIMEOUT_MS || 300_000)) })
  if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'PROVIDER_TEMPORARY_ERROR' : 'PROVIDER_REJECTED')
  const json = await response.json() as { data?: { url?: string }[] }; const urls = json.data?.map(item => item.url).filter((url): url is string => !!url); if (!urls?.length) throw new Error('PROVIDER_EMPTY_RESULT')
  return Promise.all(urls.map(checkedDownload))
}
