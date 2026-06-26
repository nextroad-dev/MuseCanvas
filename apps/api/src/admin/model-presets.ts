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

const seedream1kWay2Sizes = [
  '1024x1024', '1152x864', '864x1152', '1280x720', '720x1280', '1248x832', '832x1248', '1512x648',
]
const seedream2kWay2Sizes = [
  '2048x2048', '2304x1728', '1728x2304', '2848x1600', '1600x2848', '2496x1664', '1664x2496', '3136x1344',
]
const seedream4kWay2Sizes = [
  '4096x4096', '4704x3520', '3520x4704', '5504x3040', '3040x5504', '4992x3328', '3328x4992', '6240x2656',
]
const seedream40Way2Sizes = [...seedream1kWay2Sizes, ...seedream2kWay2Sizes, ...seedream4kWay2Sizes]
const seedream45Way2Sizes = [...seedream2kWay2Sizes, ...seedream4kWay2Sizes]

export const modelPresets = [
  {
    modelKind: 'image',
    id: 'openai-gpt-image-2', displayName: 'GPT Image 2', adapter: 'openai', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com',
    sizes: ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'], qualityOptions: ['auto', 'low', 'medium', 'high'], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-0', displayName: 'Seedream 4.0', adapter: 'seedream', vendorModelId: 'doubao-seedream-4-0-250828', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: seedream40Way2Sizes, qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-5', displayName: 'Seedream 4.5', adapter: 'seedream', vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: seedream45Way2Sizes, qualityOptions: [], maxCount: 4, concurrencyLimit: 1, watermark: false,
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
