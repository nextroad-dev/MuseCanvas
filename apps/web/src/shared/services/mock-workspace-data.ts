import type { PublicModelDto } from '@musecanvas/contracts'
import type { AssetDto } from '../types'
import { SHOWCASE_ITEMS } from '../lib/showcase'

export const MOCK_MODEL: PublicModelDto = {
  id: 'mock-showcase-image', displayName: '本地样片演示 · 非真实生成', modelKind: 'image',
  pluginVersion: 'mock-v1', modes: ['text_to_image'], inputSlots: [],
  parameters: [
    { name: 'size', type: 'enum', label: '样片画幅', options: SHOWCASE_ITEMS.map((item) => `${item.width}x${item.height}`), defaultValue: '1200x1200' },
    { name: 'count', type: 'integer', label: '样片数量', min: 1, max: 4, defaultValue: 1 },
  ],
  defaults: { size: '1200x1200', count: 1 }, maxCount: 4, maxInputImages: 0,
  supportedMediaKinds: ['image'], adapter: 'local-showcase-preview',
  sizes: SHOWCASE_ITEMS.map((item) => `${item.width}x${item.height}`), qualityOptions: [],
  enabled: true, sortOrder: 0, isDefault: true,
}

/** Uses actual local artwork only. Dimensions describe the sample, not inference output. */
export function mockSampleAsset(id: string, index: number, prompt: string, createdAt: string): AssetDto {
  const item = SHOWCASE_ITEMS[index % SHOWCASE_ITEMS.length]!
  return {
    id, mediaKind: 'image', prompt: `【本地样片 · 非真实生成】${prompt}`,
    inputPrompt: prompt, url: item.src, downloadUrl: item.src, imageUrl: item.src,
    thumbnailUrl: item.src, mimeType: 'image/webp', width: item.width, height: item.height, createdAt,
  }
}

export function mockSeedAssets(): AssetDto[] {
  return SHOWCASE_ITEMS.map((item, index) => mockSampleAsset(
    `mock-sample-${index + 1}`, index, item.prompt,
    new Date(Date.UTC(2026, 0, 5 - index, 12)).toISOString(),
  ))
}
