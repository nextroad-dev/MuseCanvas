// 创作台易失 UI 态：模型选择、输出类型、参数草稿。
// 服务端状态（会话/模型目录/任务/画布）一律走 TanStack Query，此处不镜像。

import { create } from 'zustand'
import type { MediaKind, ParameterState, ParameterValue } from '@/shared/types'

export type GenerateKind = MediaKind

export interface GenerateUiState {
  /** 当前输出类型（图像/视频）。 */
  activeKind: GenerateKind
  /** 按类型记住的模型选择；`null` = 未选，由默认模型解析回填。 */
  selectedModelIdByKind: Record<GenerateKind, string | null>
  /**
   * 参数草稿，按类型隔离。缺省 key 表示「用该 descriptor 的默认值」，
   * 因此切模型无需清空；不合法值由 media-parameters 收敛。
   */
  paramsByKind: Record<GenerateKind, ParameterState>

  setActiveKind: (kind: GenerateKind) => void
  setSelectedModel: (kind: GenerateKind, modelId: string | null) => void
  setParam: (kind: GenerateKind, name: string, value: ParameterValue) => void
  replaceParams: (kind: GenerateKind, values: ParameterState) => void
  clearParams: (kind: GenerateKind) => void
  /**
   * 新建对话：清空两个类型的模型记忆 → 下一次解析回落到管理端默认模型。
   * 对话内用户显式切换的选择保持不变。
   */
  resetConversationSelection: () => void
}

const emptySelection = (): Record<GenerateKind, string | null> => ({ image: null, video: null })
const emptyParams = (): Record<GenerateKind, ParameterState> => ({ image: {}, video: {} })

export const useGenerateUiStore = create<GenerateUiState>((set) => ({
  activeKind: 'image',
  selectedModelIdByKind: emptySelection(),
  paramsByKind: emptyParams(),

  setActiveKind: (activeKind) => set({ activeKind }),
  setSelectedModel: (kind, modelId) =>
    set((state) => ({ selectedModelIdByKind: { ...state.selectedModelIdByKind, [kind]: modelId } })),
  setParam: (kind, name, value) =>
    set((state) => ({
      paramsByKind: { ...state.paramsByKind, [kind]: { ...state.paramsByKind[kind], [name]: value } },
    })),
  replaceParams: (kind, values) =>
    set((state) => ({ paramsByKind: { ...state.paramsByKind, [kind]: values } })),
  clearParams: (kind) => set((state) => ({ paramsByKind: { ...state.paramsByKind, [kind]: {} } })),
  resetConversationSelection: () => set({ selectedModelIdByKind: emptySelection() }),
}))
