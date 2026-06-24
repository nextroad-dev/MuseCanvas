export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type LanguageProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'

export type ImageModelPreset = {
  id: string
  modelKind: 'image'
  displayName: string
  adapter: 'openai' | 'seedream'
  vendorModelId: string
  baseUrl: string
  sizes: string[]
  qualityOptions: string[]
  maxCount: number
  concurrencyLimit: number
  watermark: boolean
}

export type LanguageModelPreset = {
  id: string
  modelKind: 'language'
  displayName: string
  adapter: 'openai' | 'anthropic'
  vendorModelId: string
  baseUrl: string
  languageProtocol: LanguageProtocol
  maxOutputTokens: number
  temperature?: number
  reasoningEffort?: ReasoningEffort
  concurrencyLimit: number
}

export type ModelPreset = ImageModelPreset | LanguageModelPreset

const seedreamWay2Sizes = [
  '1024x1024', '1280x720', '720x1280', '1280x960', '960x1280', '1536x1024', '1024x1536',
  '2048x2048', '2304x1296', '1296x2304', '2048x1536', '1536x2048', '2496x1664', '1664x2496',
  '3072x3072', '3072x1728', '1728x3072', '3072x2304', '2304x3072',
  '4096x4096', '4096x2304', '2304x4096', '4096x3072', '3072x4096',
]

export const modelPresets = [
  {
    modelKind: 'image',
    id: 'openai-gpt-image-2', displayName: 'GPT Image 2', adapter: 'openai', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com',
    sizes: ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'], qualityOptions: ['auto', 'low', 'medium', 'high'], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-0', displayName: 'Seedream 4.0', adapter: 'seedream', vendorModelId: 'doubao-seedream-4-0-250828', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: seedreamWay2Sizes, qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-5', displayName: 'Seedream 4.5', adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: seedreamWay2Sizes, qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'image',
    id: 'seedream-5-lite', displayName: 'Seedream 5.0 Lite', adapter: 'seedream', vendorModelId: 'seedream-5-0-260128', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: seedreamWay2Sizes, qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    id: 'openai-gpt-5-5', modelKind: 'language', displayName: 'GPT-5.5', adapter: 'openai', vendorModelId: 'gpt-5.5', baseUrl: 'https://api.openai.com',
    languageProtocol: 'openai_responses', maxOutputTokens: 25000, reasoningEffort: 'medium', concurrencyLimit: 1,
  },
  {
    id: 'openai-gpt-5-4', modelKind: 'language', displayName: 'GPT-5.4', adapter: 'openai', vendorModelId: 'gpt-5.4', baseUrl: 'https://api.openai.com',
    languageProtocol: 'openai_responses', maxOutputTokens: 25000, reasoningEffort: 'medium', concurrencyLimit: 1,
  },
] satisfies ModelPreset[]
