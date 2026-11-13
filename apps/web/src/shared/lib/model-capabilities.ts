// 模型选择与能力推导。纯模块：只用 `import type`，可在 `node --test` 下直接运行。
//
// 默认模型优先级（产品口径）：记住的 selectedId → 管理端 isDefault → 首个非 deprecated。
// 记住的选择若已下架/停用，永远不压过在线的默认模型。

import type { MediaKind, PublicModelDto } from '@musecanvas/contracts'

/** 能力契约未通过后端校验的标记（apps/api shared/dto.ts undeclaredCapabilities）。 */
export const UNDECLARED_PROVENANCE = 'undeclared'

/** 遮罩输入角色（contracts `MASK_INPUT_ROLE`，此处本地镜像以保持零运行时依赖）。 */
const MASK_ROLE = 'mask'

export type CapabilityModel = Pick<
  PublicModelDto,
  'id' | 'modelKind' | 'enabled' | 'deprecated' | 'inputSlots' | 'flags' | 'declaredBy' | 'isDefault'
> &
  Partial<Pick<PublicModelDto, 'displayName' | 'modes' | 'parameters' | 'supportedMediaKinds' | 'maxCount'>>

export interface ModelKindRef {
  modelKind?: string | null
  /** @deprecated 兼容旧字段；modelKind 优先。 */
  mediaKind?: MediaKind | null
}

export function modelMediaKindOf(model?: ModelKindRef | null): MediaKind {
  if (!model) return 'image'
  if (model.modelKind === 'video') return 'video'
  if (model.mediaKind === 'video') return 'video'
  return 'image'
}

function isUsable(model: CapabilityModel): boolean {
  return model.enabled !== false
}

function isDeprecated(model: CapabilityModel): boolean {
  return model.deprecated === true
}

/**
 * 某媒体类型下应当使用的模型。
 *
 * @param models 模型目录（可传全量；`kind` 会再过滤一次）
 * @param kind   目标媒体类型；传 `null` 表示 models 已按类型过滤
 * @param storedId 当前记住的模型 id（`null`/空串 = 未选）
 */
export function resolveActiveModel<T extends CapabilityModel>(
  models: readonly T[],
  kind: MediaKind | null,
  storedId: string | null | undefined,
): T | null {
  if (models.length === 0) return null
  const scoped: T[] = kind ? models.filter((model) => modelMediaKindOf(model) === kind) : [...models]
  if (scoped.length === 0) return null
  // 停用行不参与候选；只有全表停用时才降级到「全部」（保持旧实现口径）。
  const live = scoped.filter(isUsable)
  const pool = live.length > 0 ? live : scoped
  if (storedId) {
    const stored = pool.find((model) => model.id === storedId)
    if (stored) return stored
  }
  const elected = pool.find((model) => model.isDefault === true)
  if (elected) return elected
  const fresh = pool.find((model) => !isDeprecated(model))
  return fresh ?? pool[0] ?? null
}

/** 图库灯箱「局部修改」入口：只要图像模型的解析结果。 */
export function resolveActiveImageModel<T extends CapabilityModel>(
  models: readonly T[],
  storedId: string | null | undefined,
): T | null {
  return resolveActiveModel(models, 'image', storedId)
}

/** 是否声明了可用的遮罩输入能力：flag 为 true 且存在 mask 输入槽，且契约不是 undeclared。 */
export function modelAcceptsMask(model: CapabilityModel | null | undefined): boolean {
  if (!model) return false
  if (model.declaredBy === UNDECLARED_PROVENANCE) return false
  if (model.flags?.mask !== true) return false
  return (model.inputSlots ?? []).some((slot) => slot.role === MASK_ROLE)
}

/** 不能做局部修改的原因（`null` = 可以做）。 */
export function maskCapabilityBlockReason(model: CapabilityModel | null | undefined): string | null {
  if (modelAcceptsMask(model)) return null
  if (model?.declaredBy === UNDECLARED_PROVENANCE) {
    return '该模型的参数契约未通过校验，无法确认支持选区遮罩'
  }
  return '当前模型不支持选区遮罩，请切换到支持局部修改的图像模型'
}

/** 模型选择器副标题：由 slots/flags 推导，绝不硬编码模型名。 */
export function describeModelCapabilities(model: CapabilityModel | null | undefined): string {
  if (!model) return ''
  if (modelMediaKindOf(model) === 'video') {
    const roles = (model.inputSlots ?? []).map((slot) => slot.role)
    if (roles.includes('first_frame')) return '视频 · 支持首帧图输入'
    if (roles.includes('reference_image')) return '视频 · 支持参考图输入'
    return '视频 · 文生视频'
  }
  const supportsInput = (model.inputSlots ?? []).length > 0
  if (modelAcceptsMask(model)) return supportsInput ? '图像 · 支持参考图与局部修改' : '图像 · 支持局部修改'
  if (supportsInput) return '图像 · 支持参考图'
  return '图像 · 文生图'
}

/** @deprecated 使用 `describeModelCapabilities`；保留旧名便于页面平滑迁移。 */
export const modelCapabilityNote = describeModelCapabilities

/** 模型是否可用于某生成模式。 */
export function modelSupportsMode(
  model: Pick<CapabilityModel, 'modes'> | null | undefined,
  mode: string,
): boolean {
  return Boolean(model?.modes?.includes(mode as never))
}
