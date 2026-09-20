import { create } from 'zustand'
import type { GenerateModeTab, Quality, StagedReferenceImage } from '@/shared/types'

export interface GenerateUiState {
  // Core text / model selections
  prompt: string
  negativePrompt: string
  /** 'image' | 'video' creation-console tab. */
  activeTab: GenerateModeTab
  /** Model choice is remembered per tab so switching tabs never loses a selection. */
  selectedModelIdByKind: Record<GenerateModeTab, string>

  // Image controls
  selectedSize: string
  selectedQuality: Quality
  size: string
  quality: Quality
  count: number

  // Video controls: keyed by canonical parameter name. `{}` means "use each
  // descriptor's own default", so changing models needs no reset.
  videoParams: Record<string, string | number | boolean>

  // Staged input images
  stagedImages: StagedReferenceImage[]
  inlineUploadError: string | null

  // Inspector / UI state
  selectedJobId: string | null
  activeOutputIndex: number
  isGenerating: boolean
  advancedOpen: boolean
  /** Kept here instead of local state so collapsing survives a remount of the console. */
  railOpen: boolean
  activeBoardOpen: boolean
  historyOpen: boolean

  // Actions
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setActiveTab: (tab: GenerateModeTab) => void
  setSelectedModelId: (tab: GenerateModeTab, modelId: string) => void
  setSelectedSize: (size: string) => void
  setSelectedQuality: (quality: Quality) => void
  setSize: (size: string) => void
  setQuality: (quality: Quality) => void
  setCount: (count: number) => void

  setVideoParam: (name: string, value: string | number | boolean) => void
  clearVideoParams: () => void
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
  setRailOpen: (open: boolean) => void
  setActiveBoardOpen: (open: boolean) => void
  setHistoryOpen: (open: boolean) => void
  resetForm: () => void
}

const initialState = {
  prompt: '',
  negativePrompt: '',
  activeTab: 'image' as GenerateModeTab,
  selectedModelIdByKind: { image: '', video: '' } as Record<GenerateModeTab, string>,
  selectedSize: '1024x1024',
  selectedQuality: 'auto' as Quality,
  size: '1024x1024',
  quality: 'auto' as Quality,
  count: 1,
  videoParams: {} as Record<string, string | number | boolean>,
  stagedImages: [] as StagedReferenceImage[],
  inlineUploadError: null as string | null,
  selectedJobId: null as string | null,
  activeOutputIndex: 0,
  isGenerating: false,
  advancedOpen: false,
  railOpen: true,
  activeBoardOpen: true,
  historyOpen: true,
}

export const useGenerateUiStore = create<GenerateUiState>((set) => ({
  ...initialState,

  setPrompt: (prompt) => set({ prompt }),
  setNegativePrompt: (negativePrompt) => set({ negativePrompt }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedModelId: (tab, id) =>
    set((state) => ({
      selectedModelIdByKind: { ...state.selectedModelIdByKind, [tab]: id },
    })),
  setSelectedSize: (selectedSize) => set({ selectedSize, size: selectedSize }),
  setSelectedQuality: (selectedQuality) => set({ selectedQuality, quality: selectedQuality }),
  setSize: (size) => set({ selectedSize: size, size }),
  setQuality: (quality) => set({ selectedQuality: quality, quality }),
  setCount: (count) => set({ count }),

  setVideoParam: (name, value) =>
    set((state) => ({ videoParams: { ...state.videoParams, [name]: value } })),
  clearVideoParams: () => set({ videoParams: {} }),

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
  setRailOpen: (railOpen) => set({ railOpen }),
  setActiveBoardOpen: (activeBoardOpen) => set({ activeBoardOpen }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  resetForm: () =>
    set({
      prompt: '',
      negativePrompt: '',
      videoParams: {},
      stagedImages: [],
      inlineUploadError: null,
      selectedJobId: null,
      activeOutputIndex: 0,
    }),
}))
