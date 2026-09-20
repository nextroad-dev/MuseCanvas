import { create } from 'zustand'
import type { EditSelection } from '@musecanvas/contracts'
import type { GenerateModeTab, StagedReferenceImage } from '@/shared/types'
import type { ParameterState, ParameterValue } from '@/shared/lib/media-parameters'

/**
 * The image 局部修改 is editing.
 *
 * Only ever a job output or a library asset — both of which already own an
 * `assets` row — so the request references the source by id and no bytes leave
 * the browser. That is also why nothing here holds a `File`: an edit never
 * re-uploads, and a field for it would invite a second upload of a picture the
 * server already has.
 *
 * `selection` is the one committed rectangle, and it is stored in
 * **source-image pixels** (`EditSelection`), never in screen pixels: the stage
 * repaints it through `imageSelectionToDisplaySelection`, so a window resize
 * moves the image and the rectangle together instead of drifting them apart.
 */
export interface EditTarget {
  /** `assets.id` of the image being edited. */
  assetId: string
  /** Playable (signed) URL for the stage; it can expire, and the stage says so. */
  url: string
  /** Declared pixel size. Optional because the stage falls back to the image
   *  element's own intrinsic size, which is the authority once it has decoded. */
  width?: number
  height?: number
  selection: EditSelection | null
}

export interface GenerateUiState {
  // Core text / model selections
  prompt: string
  negativePrompt: string
  /** 'image' | 'video' creation-console tab. */
  activeTab: GenerateModeTab
  /** Model choice is remembered per tab so switching tabs never loses a selection. */
  selectedModelIdByKind: Record<GenerateModeTab, string>

  /**
   * Generation parameters, keyed by model kind and then by the canonical
   * descriptor name the model declared.
   *
   * An absent key means "use that descriptor's own default", which is why
   * switching models needs no reset and why the map stays sparse. Values that
   * the newly selected model does not accept are dropped by
   * `reconcileParams`/`buildMediaParameters` rather than remembered, so a
   * `quality=max` picked on a 2.5 model cannot be sent to one without that rung.
   */
  paramsByKind: Record<GenerateModeTab, ParameterState>

  // Staged input images
  stagedImages: StagedReferenceImage[]
  inlineUploadError: string | null

  // Inspector / UI state
  selectedJobId: string | null
  activeOutputIndex: number
  isGenerating: boolean
  advancedOpen: boolean
  /** Non-null while 局部修改 owns the stage. See `EditTarget`. */
  editTarget: EditTarget | null
  /** Kept here instead of local state so collapsing survives a remount of the console. */
  railOpen: boolean
  activeBoardOpen: boolean
  historyOpen: boolean

  // Actions
  setPrompt: (prompt: string) => void
  setNegativePrompt: (negativePrompt: string) => void
  setActiveTab: (tab: GenerateModeTab) => void
  setSelectedModelId: (tab: GenerateModeTab, modelId: string) => void
  setParam: (tab: GenerateModeTab, name: string, value: ParameterValue) => void
  clearParams: (tab: GenerateModeTab) => void
  /**
   * Replace one tab's whole parameter map. Used after a model switch, when
   * several picks become illegal at once and the rendered controls have to agree
   * with what the console is about to send.
   */
  replaceParams: (tab: GenerateModeTab, values: ParameterState) => void
  setStagedImages: (images: StagedReferenceImage[] | ((prev: StagedReferenceImage[]) => StagedReferenceImage[])) => void
  addStagedImage: (image: StagedReferenceImage) => void
  updateStagedImage: (localId: string, patch: Partial<StagedReferenceImage>) => void
  removeStagedImage: (localId: string) => void
  clearStagedImages: () => void
  setSelectedJobId: (jobId: string | null) => void
  setActiveOutputIndex: (idx: number) => void
  setIsGenerating: (generating: boolean) => void
  setInlineUploadError: (error: string | null) => void
  /** Enter 局部修改 on one image, or leave it with `null`. Takes whole targets
   *  only: the rectangle has its own action below, so a caller can never echo
   *  back a stale selection while changing the picture. */
  setEditTarget: (target: EditTarget | null) => void
  /** Commit the stage's selection in source-image pixels, or clear it. A no-op
   *  outside edit mode, because there is no image to put a rectangle on. */
  setEditSelection: (selection: EditSelection | null) => void
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
  paramsByKind: { image: {}, video: {} } as Record<GenerateModeTab, ParameterState>,
  stagedImages: [] as StagedReferenceImage[],
  inlineUploadError: null as string | null,
  selectedJobId: null as string | null,
  activeOutputIndex: 0,
  isGenerating: false,
  advancedOpen: false,
  editTarget: null as EditTarget | null,
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
  setParam: (tab, name, value) =>
    set((state) => ({
      paramsByKind: { ...state.paramsByKind, [tab]: { ...state.paramsByKind[tab], [name]: value } },
    })),
  clearParams: (tab) =>
    set((state) => ({ paramsByKind: { ...state.paramsByKind, [tab]: {} } })),
  replaceParams: (tab, values) =>
    set((state) => ({ paramsByKind: { ...state.paramsByKind, [tab]: values } })),

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
  setEditTarget: (editTarget) => set({ editTarget }),
  setEditSelection: (selection) =>
    set((state) =>
      state.editTarget ? { editTarget: { ...state.editTarget, selection } } : state,
    ),
  toggleAdvanced: () => set((state) => ({ advancedOpen: !state.advancedOpen })),
  setRailOpen: (railOpen) => set({ railOpen }),
  setActiveBoardOpen: (activeBoardOpen) => set({ activeBoardOpen }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  resetForm: () =>
    set({
      prompt: '',
      negativePrompt: '',
      paramsByKind: { image: {}, video: {} },
      stagedImages: [],
      inlineUploadError: null,
      selectedJobId: null,
      activeOutputIndex: 0,
      editTarget: null,
    }),
}))
