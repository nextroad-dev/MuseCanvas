export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'
export type LanguageProtocol = 'openai_chat' | 'openai_responses' | 'anthropic_messages'

export type ImageModelPreset = {
  id: string
  modelKind: 'image'
  displayName: string
  adapter: 'openai' | 'seedream'
  providerId: 'openai' | 'volcengine'
  pluginId: 'openai-image' | 'seedream-image'
  pluginVersion: string
  vendorModelId: string
  baseUrl: string
  sizes: string[]
  qualityOptions: string[]
  maxCount: number
  maxInputImages: number
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

export type VideoParameterDescriptor =
  | { type: 'enum'; name: string; label?: string; options: string[]; defaultValue?: string; required?: boolean }
  | { type: 'integer'; name: string; label?: string; min?: number; max?: number; defaultValue?: number; required?: boolean }
  | { type: 'boolean'; name: string; label?: string; defaultValue?: boolean; required?: boolean }
  | { type: 'text'; name: string; label?: string; maxLength?: number; defaultValue?: string; required?: boolean }

export type VideoInputSlotDescriptor = {
  role: 'first_frame' | 'last_frame' | 'reference_image' | 'prompt_image' | string
  required: boolean
  minCount: number
  maxCount: number
  allowedMediaKinds: ('image' | 'video')[]
  label?: string
}

export type VideoModelPreset = {
  id: string
  modelKind: 'video'
  displayName: string
  providerId: string
  pluginId: string
  pluginVersion: string
  vendorModelId: string
  baseUrl: string
  modes: ('text_to_video' | 'image_to_video')[]
  parameters: VideoParameterDescriptor[]
  inputSlots: VideoInputSlotDescriptor[]
  pricing: { scheme: 'per_second_v1'; creditsPerSecond: number; minDurationSeconds?: number; maxDurationSeconds?: number }
  defaults: Record<string, string | number | boolean>
  maxCount: number
  concurrencyLimit: number
}

export type ModelPreset = ImageModelPreset | LanguageModelPreset | VideoModelPreset

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

// Seedance validates durationSeconds as a number in [1, 30]; the old generic
// 1-60 integer range contradicted the plugin, so this preset pins 1-30 here.
const seedanceDurationParameter: VideoParameterDescriptor = {
  type: 'integer', name: 'durationSeconds', label: '时长（秒）', min: 1, max: 30, defaultValue: 5, required: false,
}
// Veo only accepts durations 4/6/8. Enum strings keep the descriptor
// serializable; request normalization Number-converts them before validation.
const veoDurationParameter: VideoParameterDescriptor = {
  type: 'enum', name: 'durationSeconds', label: '时长（秒）', options: ['4', '6', '8'], defaultValue: '8', required: false,
}
// Veo only accepts 16:9 and 9:16; other ratios are normalized or rejected.
const veoAspectParameter: VideoParameterDescriptor = {
  type: 'enum', name: 'aspectRatio', label: '宽高比',
  options: ['16:9', '9:16'], defaultValue: '16:9', required: false,
}
// Veo resolutions are 720p/1080p/4k; 1080p+ requires the standard model at 8s.
const veoResolutionParameter: VideoParameterDescriptor = {
  type: 'enum', name: 'resolution', label: '分辨率',
  options: ['720p', '1080p', '4k'], defaultValue: '1080p', required: false,
}
const videoAspectParameter: VideoParameterDescriptor = {
  type: 'enum', name: 'aspectRatio', label: '宽高比',
  options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], defaultValue: '16:9', required: false,
}
const videoResolutionParameter: VideoParameterDescriptor = {
  type: 'enum', name: 'resolution', label: '分辨率',
  options: ['720p', '1080p'], defaultValue: '720p', required: false,
}
const videoAudioParameter: VideoParameterDescriptor = {
  type: 'boolean', name: 'audio', label: '生成音频', defaultValue: true, required: false,
}
const videoCountParameter: VideoParameterDescriptor = {
  type: 'integer', name: 'count', label: '生成数量', min: 1, max: 4, defaultValue: 1, required: false,
}
const videoFrameSlots: VideoInputSlotDescriptor[] = [
  { role: 'first_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'], label: '首帧' },
  { role: 'last_frame', required: false, minCount: 0, maxCount: 1, allowedMediaKinds: ['image'], label: '尾帧' },
  { role: 'reference_image', required: false, minCount: 0, maxCount: 4, allowedMediaKinds: ['image'], label: '参考图' },
]

export const modelPresets: ModelPreset[] = [
  {
    modelKind: 'image',
    id: 'openai-gpt-image-2', displayName: 'GPT Image 2', adapter: 'openai', providerId: 'openai', pluginId: 'openai-image', pluginVersion: '1.1.0', vendorModelId: 'gpt-image-2', baseUrl: 'https://api.openai.com',
    sizes: ['1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536'], qualityOptions: ['auto', 'low', 'medium', 'high'], maxCount: 4, maxInputImages: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-0', displayName: 'Seedream 4.0', adapter: 'seedream', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', vendorModelId: 'doubao-seedream-4-0-250828', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: seedream40Way2Sizes, qualityOptions: [], maxCount: 4, maxInputImages: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'image',
    id: 'seedream-4-5', displayName: 'Seedream 4.5', adapter: 'seedream', providerId: 'volcengine', pluginId: 'seedream-image', pluginVersion: '1.1.0', vendorModelId: 'doubao-seedream-4-5-251128', baseUrl: 'https://ark.cn-beijing.volces.com',
    sizes: seedream45Way2Sizes, qualityOptions: [], maxCount: 4, maxInputImages: 4, concurrencyLimit: 1, watermark: false,
  },
  {
    modelKind: 'video',
    id: 'seedance-1-0', displayName: 'Seedance 2.0 Fast', providerId: 'volcengine', pluginId: 'seedance-video', pluginVersion: '1.0.0', vendorModelId: 'doubao-seedance-2-0-fast-260128', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modes: ['text_to_video', 'image_to_video'],
    parameters: [seedanceDurationParameter, videoAspectParameter, videoResolutionParameter, videoAudioParameter, videoCountParameter],
    inputSlots: videoFrameSlots,
    pricing: { scheme: 'per_second_v1', creditsPerSecond: 10, minDurationSeconds: 1, maxDurationSeconds: 30 },
    defaults: { durationSeconds: 5, aspectRatio: '16:9', resolution: '720p', audio: true, count: 1 },
    maxCount: 4, concurrencyLimit: 1,
  },
  {
    modelKind: 'video',
    id: 'veo-3-1', displayName: 'Veo 3.1', providerId: 'google', pluginId: 'veo-video', pluginVersion: '1.0.0', vendorModelId: 'veo-3.1-generate-001', baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    modes: ['text_to_video', 'image_to_video'],
    parameters: [veoDurationParameter, veoAspectParameter, veoResolutionParameter, videoAudioParameter, videoCountParameter],
    inputSlots: videoFrameSlots,
    pricing: { scheme: 'per_second_v1', creditsPerSecond: 20, minDurationSeconds: 4, maxDurationSeconds: 8 },
    defaults: { durationSeconds: 8, aspectRatio: '16:9', resolution: '1080p', audio: true, count: 1 },
    maxCount: 4, concurrencyLimit: 1,
  },
  {
    id: 'openai-gpt-5-5', modelKind: 'language', displayName: 'GPT-5.5', adapter: 'openai', vendorModelId: 'gpt-5.5', baseUrl: 'https://api.openai.com',
    languageProtocol: 'openai_responses', maxOutputTokens: 25000, reasoningEffort: 'medium', concurrencyLimit: 1,
  },
  {
    id: 'openai-gpt-5-4', modelKind: 'language', displayName: 'GPT-5.4', adapter: 'openai', vendorModelId: 'gpt-5.4', baseUrl: 'https://api.openai.com',
    languageProtocol: 'openai_responses', maxOutputTokens: 25000, reasoningEffort: 'medium', concurrencyLimit: 1,
  },
]
