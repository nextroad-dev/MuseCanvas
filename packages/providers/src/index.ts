export { encryptApiKey, decryptApiKey, fingerprintApiKey } from './crypto'
export { loadPromptTemplateIndex, promptTemplateIndexDto, renderPromptTemplate } from './prompt-templates'
export type { PromptTemplateEntry, PromptTemplateIndex } from './prompt-templates'
export { buildLanguageModelRequest, parseLanguageModelResponse, callLanguageModel, parseExactJsonString, LanguageModelHttpError } from './language-model'
export type { LanguageProtocol, LanguageModelInput, LanguageModelResult, ReasoningEffort, LanguageModelErrorDiagnostic } from './language-model'

// Image generation compatibility exports
export type { GenerateInput, GeneratedImage, ImageGenerationBody, ProviderErrorDiagnostic, InputImage, InspectedInputImage } from './image-generation'
export { ProviderHttpError, providerEndpoint, providerModelsEndpoint, generateImages, imageGenerationBody, normalizeSeedreamSize, limitGeneratedImages, inspectInputImage, validateInputImages, MAX_UPLOAD_IMAGE_BYTES, MAX_UPLOAD_TOTAL_BYTES, MAX_INPUT_IMAGES, MIN_INPUT_IMAGE_DIMENSION, MAX_INPUT_IMAGE_DIMENSION, MAX_INPUT_IMAGE_ASPECT_RATIO } from './image-generation'

// Kernel & Plugin exports
export * from './core/index'
export * from './plugins/index'
