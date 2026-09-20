// OpenAI / GPT Image per-model capability contracts.
//
// These declarations replace the old `OPENAI_IMAGE_MODEL_RULES` table, which
// held sizes and qualities as bare string arrays that only this file could read.
// The shape below is the shared media contract, so the same declaration now
// drives the console's controls, the browser's pre-submit check, the API's
// authoritative check and this plugin's own request body — one source, four
// consumers, and no model-name branching in any of them.
//
// Provenance of every value: the MuseCanvas product spec supplied the model
// roster, the quality ladders, the size presets, the geometry limits and the
// output-parameter rules. OpenAI's own API reference was not reachable from the
// authoring environment (HTTP 403 on both platform.openai.com and
// developers.openai.com), so anything the spec did not state for a given model
// is **left undeclared here rather than guessed** — see the per-model notes and
// the audit trail in the plugin's tests.

import type {
  ImageSizeConstraints,
  ImageSizePreset,
  InputSlotDescriptor,
  ModelCapabilities,
  ParameterCrossFieldConstraint,
  ParameterDescriptor,
  ParameterOption,
} from '@musecanvas/contracts'
import { reduceRatio } from '@musecanvas/contracts'
import type { MediaModelDeclaration } from '../../core/types'

/**
 * Total pixels above which the vendor describes output as experimental. Stated
 * as a threshold rather than baked into each preset so the caveat cannot drift
 * away from the numbers.
 */
const EXPERIMENTAL_PIXEL_FLOOR = 2560 * 1440

const EXPERIMENTAL_SIZE_NOTE = '高分辨率输出可能具有更高延迟，且部分超高分辨率能力仍属于实验性支持。'

/**
 * Geometry limits shared by the GPT Image models that accept arbitrary
 * `WIDTHxHEIGHT`: `1024x1024` up to `3840x2160`, edges on a 16-pixel grid, and
 * nothing flatter than 3:1.
 */
const GPT_IMAGE_SIZE_CONSTRAINTS: ImageSizeConstraints = {
  maxWidth: 3840,
  maxHeight: 3840,
  widthMultipleOf: 16,
  heightMultipleOf: 16,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxAspectRatio: 3,
}

/**
 * Turn `'1536x1024'` into a labelled preset with its geometry spelled out, so
 * the UI can show `3:2 · 1536 × 1024` without parsing the wire value and can
 * still send `1536x1024`.
 */
function sizePreset(value: string): ImageSizePreset {
  if (value === 'auto') return { value: 'auto', label: '自动' }
  const [width, height] = value.split('x').map(Number)
  const experimental = width * height > EXPERIMENTAL_PIXEL_FLOOR
  return {
    value,
    width,
    height,
    label: `${reduceRatio(width, height)} · ${width} × ${height}`,
    ...(experimental ? { experimental: true, description: EXPERIMENTAL_SIZE_NOTE } : {}),
  }
}

function gptImageSize(presets: string[], allowCustom: boolean) {
  return {
    type: 'image-size' as const,
    name: 'size',
    label: '尺寸',
    description: allowCustom
      ? '可选择预设尺寸，或按下方限制自定义宽高'
      : '该模型仅支持以下固定尺寸',
    presets: presets.map(sizePreset),
    ...(allowCustom ? { allowCustom: true, constraints: GPT_IMAGE_SIZE_CONSTRAINTS } : {}),
    defaultValue: presets[0],
    ui: { control: 'size-picker' as const },
  }
}

const GPT_IMAGE_QUALITY_OPTIONS: ParameterOption[] = [
  { value: 'auto', label: '自动', description: '由模型结合尺寸与提示词自行选择档位' },
  { value: 'low', label: 'Low', description: '最快，细节较少' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High', description: '细节更完整，耗时更长' },
]

/** The 2.5 ladder adds two rungs above `high`; older models must not show them. */
const GPT_IMAGE_EXTENDED_QUALITY_OPTIONS: ParameterOption[] = [
  ...GPT_IMAGE_QUALITY_OPTIONS,
  { value: 'xhigh', label: 'XHigh', description: '高于 High 的档位' },
  { value: 'max', label: 'Max', description: '最高质量档位，延迟与消耗最大' },
]

function quality(options: ParameterOption[]) {
  return {
    type: 'enum' as const,
    name: 'quality',
    label: '质量',
    options,
    defaultValue: 'auto',
  }
}

function count(max: number) {
  return {
    type: 'integer' as const,
    name: 'count',
    label: '数量',
    description: '一次请求生成的图片张数',
    min: 1,
    max,
    defaultValue: 1,
  }
}

const GPT_IMAGE_BACKGROUND_OPTIONS: ParameterOption[] = [
  { value: 'auto', label: '自动' },
  { value: 'opaque', label: '不透明' },
  { value: 'transparent', label: '透明', description: '输出带 alpha 通道，只能配合 png 或 webp' },
]

const GPT_IMAGE_BACKGROUND = {
  type: 'enum' as const,
  name: 'background',
  label: '背景',
  options: GPT_IMAGE_BACKGROUND_OPTIONS,
  defaultValue: 'auto',
}

const GPT_IMAGE_OUTPUT_FORMAT = {
  type: 'enum' as const,
  name: 'output_format',
  label: '输出格式',
  options: [
    { value: 'png', label: 'PNG', description: '支持 alpha 通道' },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP', description: '支持 alpha 通道' },
  ] satisfies ParameterOption[],
  // `png` is what this plugin hardcoded on the wire before the parameter
  // existed, so keeping it as the default preserves current behaviour.
  defaultValue: 'png',
}

/**
 * Only meaningful for lossy formats — the vendor rejects it alongside `png`, so
 * the dependency is declared rather than filtered imperatively in the UI.
 */
const GPT_IMAGE_OUTPUT_COMPRESSION = {
  type: 'integer' as const,
  name: 'output_compression',
  label: '输出压缩',
  description: 'lossy 格式的压缩质量（0 最压缩，100 最保真）',
  min: 0,
  max: 100,
  defaultValue: 100,
  dependsOn: { parameter: 'output_format', values: ['jpeg', 'webp'] },
  ui: { control: 'slider' as const, advanced: true },
}

/**
 * Edit-side input fidelity. Offered **only** on the legacy model that documents
 * it: the current models apply high input fidelity automatically and must not
 * expose a knob they do not read.
 */
const GPT_IMAGE_INPUT_FIDELITY = {
  type: 'enum' as const,
  name: 'input_fidelity',
  label: '输入保真度',
  description: '编辑时保留输入图片细节的程度',
  options: [
    { value: 'low', label: '较低' },
    { value: 'high', label: '较高' },
  ] satisfies ParameterOption[],
  defaultValue: 'high',
}

/**
 * `background=transparent` needs an alpha channel, and jpeg has none. Expressed
 * as one declarative rule so the browser greys out jpeg, the API rejects the
 * combination, and the adapter never builds a request the vendor would answer
 * with an opaque 400.
 */
const GPT_IMAGE_CROSS_FIELD: ParameterCrossFieldConstraint[] = [
  {
    type: 'forbidden',
    parameter: 'background',
    whenValueEquals: 'transparent',
    targetParameter: 'output_format',
    targetValues: ['jpeg'],
    message: 'background=transparent 需要 alpha 通道，output_format 只能是 png 或 webp',
  },
]

const GPT_IMAGE_EDIT_SLOTS: InputSlotDescriptor[] = [
  {
    role: 'reference_image',
    required: false,
    minCount: 0,
    maxCount: 4,
    allowedMediaKinds: ['image'],
    label: '参考图',
    description: '作为编辑基础或风格参考的图片',
  },
  {
    role: 'mask',
    required: false,
    minCount: 0,
    maxCount: 1,
    allowedMediaKinds: ['image'],
    label: '选区遮罩',
    description: '带 alpha 通道的 PNG，限定可重绘的区域',
  },
]

/** Parameters every current GPT Image model shares. */
function gptImageModernParameters(extendedQuality: boolean) {
  return [
    quality(extendedQuality ? GPT_IMAGE_EXTENDED_QUALITY_OPTIONS : GPT_IMAGE_QUALITY_OPTIONS),
    GPT_IMAGE_BACKGROUND,
    GPT_IMAGE_OUTPUT_FORMAT,
    GPT_IMAGE_OUTPUT_COMPRESSION,
  ]
}

/**
 * Attach the shared modern-model skeleton to an already-built parameter array.
 *
 * The parameters are passed in by reference rather than constructed per model on
 * purpose: variants that behave identically must *share* one schema object, so a
 * later edit lands on every model that reuses it instead of on whichever entry a
 * copy-paste happened to reach.
 */
function modernCapabilitiesWith(
  parameters: ParameterDescriptor[],
  maxCount: number,
): ModelCapabilities {
  return {
    modes: ['text_to_image', 'image_to_image'],
    parameters,
    inputSlots: GPT_IMAGE_EDIT_SLOTS,
    maxCount,
    supportedMediaKinds: ['image'],
    flags: {
      textToImage: true,
      imageToImage: true,
      imageEdit: true,
      mask: true,
      inpainting: true,
      transparentBackground: true,
    },
    crossFieldConstraints: GPT_IMAGE_CROSS_FIELD,
    declaredBy: 'plugin-manifest',
  }
}

const GPT_IMAGE_2_5_SIZE_PRESETS = [
  'auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840',
]

/**
 * `gpt-image-2` additionally advertises the two 720p sizes it shipped with
 * before this contract existed. Dropping them would have made saved model
 * configurations and in-flight revisions illegal, so the preset list is the
 * union — and both remain inside the model's own geometry band.
 */
const GPT_IMAGE_2_SIZE_PRESETS = [
  'auto', '1024x1024', '1280x720', '720x1280', '1536x1024', '1024x1536',
  '2048x2048', '2048x1152', '3840x2160', '2160x3840',
]

const GPT_IMAGE_1_5_SIZE_PRESETS = ['auto', '1024x1024', '1024x1536', '1536x1024']

const GPT_IMAGE_2_5_DEFAULTS = {
  size: 'auto', quality: 'auto', background: 'auto', output_format: 'png', count: 1,
}

/**
 * The two 2.5 variants share this exact array — one definition, referenced
 * twice, so `sunburst` and `flare` cannot drift apart.
 */
const GPT_IMAGE_2_5_PARAMETERS: ParameterDescriptor[] = [
  gptImageSize(GPT_IMAGE_2_5_SIZE_PRESETS, true),
  ...gptImageModernParameters(true),
  count(4),
]

/**
 * `gpt-image-2` is the same contract minus the two upper quality rungs, and with
 * the two 720p sizes it shipped with kept in the preset list: they satisfy this
 * model's own geometry band, and dropping them would have made saved model
 * configurations and already-pinned revisions illegal.
 */
const GPT_IMAGE_2_PARAMETERS: ParameterDescriptor[] = [
  gptImageSize(GPT_IMAGE_2_SIZE_PRESETS, true),
  ...gptImageModernParameters(false),
  count(4),
]

/**
 * The roster, ordered so a deprecated model can never occupy the recommended
 * first position that `buildManifest` produces.
 */
export const OPENAI_IMAGE_MODELS: MediaModelDeclaration[] = [
  {
    id: 'gpt-image-2.5-sunburst',
    name: 'GPT Image 2.5 Sunburst',
    modalities: ['image'],
    capabilities: modernCapabilitiesWith(GPT_IMAGE_2_5_PARAMETERS, 4),
    defaults: GPT_IMAGE_2_5_DEFAULTS,
  },
  {
    id: 'gpt-image-2.5-flare',
    name: 'GPT Image 2.5 Flare',
    modalities: ['image'],
    // Same contract as Sunburst: the spec states the two 2.5 variants share
    // their parameter surface, and only Sunburst is individually attested for
    // editing. Treat `flare`'s edit flags as inherited, and re-confirm against
    // the vendor reference before either model gains or loses a capability.
    capabilities: modernCapabilitiesWith(GPT_IMAGE_2_5_PARAMETERS, 4),
    defaults: GPT_IMAGE_2_5_DEFAULTS,
  },
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    modalities: ['image'],
    capabilities: modernCapabilitiesWith(GPT_IMAGE_2_PARAMETERS, 4),
    defaults: GPT_IMAGE_2_5_DEFAULTS,
  },
  {
    id: 'gpt-image-1.5',
    name: 'GPT Image 1.5',
    modalities: ['image'],
    // Fixed sizes only: this generation documents an enumerated set and no
    // custom `WIDTHxHEIGHT` band, so `allowCustom` stays off and no
    // `constraints` block is declared.
    //
    // `background` / `output_format` / `output_compression` are deliberately
    // absent — unconfirmed for this model, and offering a control the vendor
    // rejects is worse than offering one fewer.
    capabilities: {
      modes: ['text_to_image', 'image_to_image'],
      parameters: [
        gptImageSize(GPT_IMAGE_1_5_SIZE_PRESETS, false),
        quality(GPT_IMAGE_QUALITY_OPTIONS),
        GPT_IMAGE_INPUT_FIDELITY,
        count(4),
      ],
      // The count of reference images for this model is unconfirmed; 1 is the
      // conservative choice, since under-offering is recoverable by the admin
      // while over-offering produces requests the vendor will refuse.
      inputSlots: [{ ...GPT_IMAGE_EDIT_SLOTS[0], maxCount: 1 }],
      maxCount: 4,
      supportedMediaKinds: ['image'],
      flags: { textToImage: true, imageToImage: true, imageEdit: true },
      declaredBy: 'plugin-manifest',
    },
    defaults: { size: 'auto', quality: 'auto', input_fidelity: 'high', count: 1 },
  },
  {
    id: 'dall-e-3',
    name: 'DALL-E 3',
    modalities: ['image'],
    deprecated: true,
    deprecationNote: 'DALL-E 3 已被 GPT Image 系列取代，仅保留兼容既有配置，不建议新建模型。',
    // Declares only what this plugin actually does with dall-e-3: its own
    // quality vocabulary (`standard`/`hd`, *not* the GPT Image ladder), its
    // three fixed sizes, a single image per request, and no input images.
    capabilities: {
      modes: ['text_to_image'],
      parameters: [
        gptImageSize(['1024x1024', '1792x1024', '1024x1792'], false),
        {
          type: 'enum',
          name: 'quality',
          label: '质量',
          options: [
            { value: 'standard', label: 'Standard' },
            { value: 'hd', label: 'HD' },
          ],
          defaultValue: 'standard',
        },
        count(1),
      ],
      inputSlots: [],
      maxCount: 1,
      supportedMediaKinds: ['image'],
      flags: { textToImage: true, imageToImage: false, imageEdit: false },
      declaredBy: 'plugin-manifest',
    },
    defaults: { size: '1024x1024', quality: 'standard', count: 1 },
  },
]

export const OPENAI_IMAGE_SUPPORTED_MODELS: string[] = OPENAI_IMAGE_MODELS.map(model => model.id)

/**
 * Models served by the pre-`output_format` request shape: they take
 * `response_format: 'b64_json'` and exactly one image per call.
 *
 * This is deliberately *not* part of `capabilities`. Which HTTP contract a model
 * is reached through is this plugin's own routing fact, not a knob to render or a
 * value to validate, and smuggling it into the capability set would put a control
 * in front of users that selects nothing.
 */
export const OPENAI_IMAGE_LEGACY_ENDPOINT_MODELS: ReadonlySet<string> = new Set(['dall-e-3'])

export function openAiImageModelDeclaration(vendorModelId: string): MediaModelDeclaration | undefined {
  return OPENAI_IMAGE_MODELS.find(model => model.id === vendorModelId)
}

/** The size preset values, for error text that enumerates what *is* allowed. */
export function openAiImageSizeValues(model: MediaModelDeclaration): string[] {
  const size = model.capabilities?.parameters.find(descriptor => descriptor.name === 'size')
  return size && size.type === 'image-size' ? size.presets.map(preset => preset.value) : []
}

/** The accepted values of a named enum parameter, for validation messages. */
export function openAiImageEnumValues(model: MediaModelDeclaration, name: string): string[] | null {
  const descriptor = model.capabilities?.parameters.find(entry => entry.name === name)
  if (!descriptor || descriptor.type !== 'enum') return null
  return descriptor.options.map(option => (typeof option === 'string' ? option : option.value))
}

export function openAiImageMaxBatchSize(model: MediaModelDeclaration): number {
  const descriptor = model.capabilities?.parameters.find(entry => entry.name === 'count')
  return descriptor && descriptor.type === 'integer' ? (descriptor.max ?? 1) : 1
}
