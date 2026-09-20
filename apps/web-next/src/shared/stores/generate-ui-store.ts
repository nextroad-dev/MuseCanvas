import { create } from 'zustand'
import type { Quality, StagedReferenceImage } from '@/shared/types'

export interface GenerateUiState {
  // Core text / model selections
  prompt: string
  negativePrompt: string
  selectedModelId: string

  // Image controls
  selectedSize: string
  selectedQuality: Quality
  size: string
  quality: Quality
  count: number

  // Video controls
  videoDuration: number
  videoAspectRatio: string
  videoResolution: string
  videoAudio: boolean

  // Staged input images
  stagedImages: StagedReferenceImage[]
  inlineUploadError: string | null

  // Inspector / UI state
  selectedJobId: string | null
  activeOutputIndex: number
  isGenerating: boolean
  advancedOpen: boolean

  // Actions
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setSelectedModelId: (modelId: string) => void
  setSelectedSize: (size: string) => void
  setSelectedQuality: (quality: Quality) => void
  setSize: (size: string) => void
  setQuality: (quality: Quality) => void
  setCount: (count: number) => void

  setVideoDuration: (duration: number) => void
  setVideoAspectRatio: (aspectRatio: string) => void
  setVideoResolution: (resolution: string) => void
  setVideoAudio: (audio: boolean) => void
  setStagedImages: (images: StagedReferenceImage[] | ((prev: StagedReferenceImage[]) => StagedReferenceImage[])) => void
  addStagedImage: (image: StagedReferenceImage) => void
  updateStagedImage: (localId: string, patch: Partial<StagedReferenceImage>) => void
  removeStagedImage: (localId: string) => void
  clearStagedImages: () => void
  setSelectedJobId: (jobId: string | null) => void
  setActiveOutputIndex: (idx: number) => void
  setIsGenerating: (generating: boolean) => void
  setInlineUploadError: (error: string | null) => void
  toggleAdvanced: () => void
  resetForm: () => void
}

const initialState = {
  prompt: '',
  negativePrompt: '',
  selectedModelId: '',
  selectedSize: '1024x1024',
  selectedQuality: 'auto' as Quality,
  size: '1024x1024',
  quality: 'auto' as Quality,
  count: 1,
  videoDuration: 4,
  videoAspectRatio: '16:9',
  videoResolution: '720p',
  videoAudio: true,
  stagedImages: [] as StagedReferenceImage[],
  inlineUploadError: null as string | null,
  selectedJobId: null as string | null,
  activeOutputIndex: 0,
  isGenerating: false,
  advancedOpen: false,
}

export const useGenerateUiStore = create<GenerateUiState>((set) => ({
  ...initialState,

  setPrompt: (prompt) => set({ prompt }),
  setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
  setSelectedModelId: (selectedModelId) => set({ selectedModelId }),
  setSelectedSize: (selectedSize) => set({ selectedSize, size: selectedSize }),
  setSelectedQuality: (selectedQuality) => set({ selectedQuality, quality: selectedQuality }),
  setSize: (size) => set({ selectedSize: size, size }),
  setQuality: (quality) => set({ selectedQuality: quality, quality }),
  setCount: (count) => set({ count }),

  setVideoDuration: (videoDuration) => set({ videoDuration }),
  setVideoAspectRatio: (videoAspectRatio) => set({ videoAspectRatio }),
  setVideoResolution: (videoResolution) => set({ videoResolution }),
  setVideoAudio: (videoAudio) => set({ videoAudio }),

  setStagedImages: (images) =>
    set((state) => ({
      stagedImages: typeof images === 'function' ? images(state.stagedImages) : images,
    })),

  addStagedImage: (image) =>
    set((state) => ({
      stagedImages: [...state.stagedImages, image],
    })),

  updateStagedImage: (localId, patch) =>
    set((state) => ({
      stagedImages: state.stagedImages.map((img) =>
        img.localId === localId ? { ...img, ...patch } : img,
      ),
    })),

  removeStagedImage: (localId) =>
    set((state) => ({
      stagedImages: state.stagedImages.filter((img) => img.localId !== localId),
    })),

  clearStagedImages: () => set({ stagedImages: [] }),
  setSelectedJobId: (selectedJobId) => set({ selectedJobId, activeOutputIndex: 0 }),
  setActiveOutputIndex: (activeOutputIndex) => set({ activeOutputIndex }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setInlineUploadError: (inlineUploadError) => set({ inlineUploadError }),
  toggleAdvanced: () => set((state) => ({ advancedOpen: !state.advancedOpen })),
  resetForm: () =>
    set({
      prompt: '',
      negativePrompt: '',
      stagedImages: [],
      inlineUploadError: null,
      selectedJobId: null,
      activeOutputIndex: 0,
    }),
}))
