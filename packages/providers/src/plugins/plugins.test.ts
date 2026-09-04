import test from 'node:test'
import assert from 'node:assert/strict'
import {
  openAiImagePlugin,
  seedreamImagePlugin,
  globalProviderRegistry,
  type MediaRequest,
  type ProviderConfig,
} from '../index'

// Helper mock PNG buffer
const mockPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x00, // 1024
  0x00, 0x00, 0x04, 0x00, // 1024
  0x08, 0x06, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
])

test('OpenAiImagePlugin: submit generation fixture without network', async () => {
  let capturedUrl = ''
  let capturedBody = ''

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    capturedBody = String(init?.body || '')
    return new Response(
      JSON.stringify({
        data: [{ b64_json: mockPng.toString('base64') }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof globalThis.fetch

  const config: ProviderConfig = {
    baseUrl: 'https://api.openai.com',
    credential: {
      schema: 'legacy-api-key-v1',
      apiKey: 'sk-mock-key-1234567890',
    },
  }

  const context = globalProviderRegistry.createExecutionContext('openai-image', '1.0.0', {
    config,
    fetchImpl: mockFetch,
  })

  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'gpt-image-2',
    prompt: 'A futuristic city in watercolor',
    size: '1024x1024',
    count: 1,
  }

  const result = await openAiImagePlugin.submit(request, config, context)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.outputs?.length, 1)
  assert.equal(capturedUrl, 'https://api.openai.com/v1/images/generations')
  const parsed = JSON.parse(capturedBody)
  assert.equal(parsed.model, 'gpt-image-2')
  assert.equal(parsed.prompt, 'A futuristic city in watercolor')

  // Open output
  const output = await openAiImagePlugin.openOutput(result.outputs![0], config, context)
  assert.equal(output.mimeType, 'image/png')
  assert.equal(output.width, 1024)
  assert.equal(output.height, 1024)
  assert.equal(output.data.length, mockPng.length)
})

test('OpenAiImagePlugin: submit edit fixture without network', async () => {
  let capturedUrl = ''
  let isFormData = false

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url)
    isFormData = init?.body instanceof FormData
    return new Response(
      JSON.stringify({
        data: [{ b64_json: mockPng.toString('base64') }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof globalThis.fetch

  const config: ProviderConfig = {
    credential: {
      schema: 'legacy-api-key-v1',
      apiKey: 'sk-mock-key-1234567890',
    },
  }

  const context = globalProviderRegistry.createExecutionContext('openai-image', '1.0.0', {
    config,
    fetchImpl: mockFetch,
  })

  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'gpt-image-2',
    prompt: 'Add trees to the background',
    size: '1024x1024',
    inputImages: [
      {
        data: mockPng,
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
      },
    ],
  }

  const result = await openAiImagePlugin.submit(request, config, context)
  assert.equal(result.status, 'succeeded')
  assert.equal(capturedUrl, 'https://api.openai.com/v1/images/edits')
  assert.equal(isFormData, true)
})

test('SeedreamImagePlugin: submit and openOutput fixture without network', async () => {
  let capturedUrl = ''
  let capturedBody: any = null

  const mockDownloadPng = mockPng

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url)
    if (urlStr.includes('/api/v3/images/generations')) {
      capturedUrl = urlStr
      capturedBody = JSON.parse(String(init?.body || '{}'))
      return new Response(
        JSON.stringify({
          data: [
            { url: 'https://ark.cn-beijing.volces.com/mock-image.png' },
            { error: { code: 'content_filtered' } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    if (urlStr.includes('/mock-image.png')) {
      return new Response(mockDownloadPng, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }

    throw new Error(`Unexpected url: ${urlStr}`)
  }) as typeof globalThis.fetch

  const config: ProviderConfig = {
    credential: {
      schema: 'legacy-api-key-v1',
      apiKey: 'ark-mock-key-123',
    },
  }

  const context = globalProviderRegistry.createExecutionContext('seedream-image', '1.0.0', {
    config,
    fetchImpl: mockFetch,
  })

  const request: MediaRequest = {
    modality: 'image',
    vendorModelId: 'doubao-seedream-4-5-251128',
    prompt: 'Fantasy landscape',
    size: '2048x2048',
    count: 2,
    watermark: false,
  }

  const result = await seedreamImagePlugin.submit(request, config, context)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.outputs?.length, 1)
  assert.equal(capturedUrl, 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
  assert.equal(capturedBody.model, 'doubao-seedream-4-5-251128')
  assert.equal(capturedBody.size, '2048x2048')
  assert.equal(capturedBody.watermark, false)
  assert.equal(capturedBody.sequential_image_generation, 'auto')

  // Open output via remote URL download
  const output = await seedreamImagePlugin.openOutput(result.outputs![0], config, context)
  assert.equal(output.mimeType, 'image/png')
  assert.equal(output.width, 1024)
  assert.equal(output.height, 1024)
  assert.equal(output.data.equals(mockDownloadPng), true)
})
