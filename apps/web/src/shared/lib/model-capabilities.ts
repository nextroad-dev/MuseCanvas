// Which models a feature can actually be offered on.
//
// One home for the 局部修改 gate because two entry points need the same answer:
// the console's per-image action and the library lightbox that hands an asset to
// it. A diverging second copy is how a feature ends up callable from one door and
// refused by the other.
//
// This module keeps zero runtime external imports on purpose: the default-model
// resolution below is covered by `model-capabilities.test.mjs` under plain
// `node --test`, which cannot resolve the contracts package's extensionless
// internals or the `@/` path alias. The two mirrored values are pinned by name
// to their canonical owners in the comments; both owners have tests that pin
// their own values (`image-edit.test.ts` pins `MASK_INPUT_ROLE` to `'mask'`).

import type { MediaParameterProvenance, ModelConfig } from '@/shared/types'

/**
 * Mirrors `MASK_INPUT_ROLE` in `@musecanvas/contracts` (`image-edit.ts`, pinned
 * to `'mask'` by `image-edit.test.ts`). A local copy so this module stays
 * runnable under plain `node --test`.
 */
const MASK_ROLE = 'mask'

/**
 * Mirrors `modelMediaKind` in `@/shared/types` — the one img-vs-video decision
 * point — for the same test-runnability reason. Keep the two in sync: both read
 * `modelKind` first and fall back to the legacy `mediaKind`.
 */
function pickerModelKind(model?: Pick<ModelConfig, 'modelKind' | 'mediaKind'> | null): 'image' | 'video' {
  if (!model) return 'image'
  if (model.modelKind === 'video') return 'video'
  if (model.modelKind === 'language') return 'image'
  if ((model as { mediaKind?: string }).mediaKind === 'video') return 'video'
  return 'image'
}

/** What the API writes for a revision whose capability snapshot failed structural
 *  validation (`undeclaredCapabilities()` in `apps/api/src/shared/dto.ts`). */
const UNDECLARED: MediaParameterProvenance = 'undeclared'

/** The fields 局部修改 reads. `flags` is conditionally present on the DTO, which
 *  is why every consumer here optional-chains it. */
export type MaskCapableModel = Partial<Pick<ModelConfig, 'flags' | 'inputSlots' | 'declaredBy'>>

/**
 * `true` only when the model states it accepts a mask *and* its input contract
 * can carry one.
 *
 * Both halves are required on purpose: the API passes a revision's `flags` and
 * `inputSlots` through from the plugin snapshot without cross-checking them
 * against each other, so a flag with no slot describes a mask that could never
 * reach the worker and a slot with no flag is an unconfirmed capability. An
 * explicit `'undeclared'` contract is a stop as well: with no authored
 * descriptors there is nothing to trust a flag against.
 *
 * `flags` is conditionally present on the DTO, hence the optional chain — an
 * absent flag means *unconfirmed*, never *supported*.
 */
export function modelAcceptsMask(model: MaskCapableModel | null | undefined): boolean {
  if (!model) return false
  if (model.declaredBy === UNDECLARED) return false
  if (model.flags?.mask !== true) return false
  return (model.inputSlots ?? []).some((slot) => slot.role === MASK_ROLE)
}

/** Why the model cannot take a mask, so every entry point can state it instead of
 *  just rendering a dead button. `null` means it can. */
export function maskCapabilityBlockReason(
  model: MaskCapableModel | null | undefined,
): string | null {
  if (modelAcceptsMask(model)) return null
  if (model?.declaredBy === UNDECLARED) {
    return '该模型的参数契约未通过校验，无法确认支持选区遮罩'
  }
  return '当前模型不支持选区遮罩，请切换到支持局部修改的图像模型'
}

/**
 * The image model the console would submit with: the remembered pick when the
 * catalogue still offers it, else the admin default, else the first
 * non-deprecated image model.
 *
 * Kept for the call site that needs the answer without mounting the console —
 * the library lightbox gates its 局部修改 action here. Now a thin wrapper over
 * `resolveActiveModel`; the console writes its resolved fallback back into
 * `selectedModelIdByKind`, so the two agree from the second render onward.
 */
export function resolveActiveImageModel(
  models: readonly ModelConfig[],
  storedModelId: string,
): ModelConfig | undefined {
  return resolveActiveModel(
    models.filter((model) => pickerModelKind(model) !== 'video'),
    storedModelId,
  )
}

/**
 * A model row with the admin-chosen default flag `GET /api/models` now serves
 * (`PublicModelDto.isDefault`). `ModelConfig` does not declare it yet, so the
 * resolution reads it structurally instead of requiring a wide type migration.
 */
export type DefaultAwareModel = ModelConfig & { isDefault?: boolean }

/**
 * The model a creation surface should submit with, for one media kind: the
 * caller passes the already kind-filtered catalogue and the remembered pick for
 * that kind.
 *
 * Order: the remembered id when that row is still offered and enabled, else the
 * admin-chosen default, else the first non-deprecated row. A remembered pick of
 * a disabled or retired row never wins over a live default — that is what lets
 * a fresh conversation land on the admin's default while a mid-session switch
 * stays put.
 *
 * Pure: no store, no clock, safe to call during render and under `node --test`.
 */
export function resolveActiveModel(
  models: readonly DefaultAwareModel[],
  storedModelId: string,
): ModelConfig | undefined {
  if (models.length === 0) return undefined
  const live = models.filter((model) => model.enabled !== false)
  const pool = live.length > 0 ? live : [...models]
  const stored = pool.find((model) => model.id === storedModelId)
  if (stored) return stored
  const elected = pool.find((model) => model.isDefault === true)
  if (elected) return elected
  const ranked = [...pool].sort(
    (left, right) => Number(left.deprecated === true) - Number(right.deprecated === true),
  )
  return ranked.find((model) => !model.deprecated) ?? ranked[0]
}

/**
 * The two-line capability note under a model name in the model picker. Derived
 * from the model's own slots and flags, never from a hardcoded model name, so a
 * future provider ships its note without a frontend change.
 */
export function modelCapabilityNote(model: DefaultAwareModel | null | undefined): string {
  if (!model) return ''
  if (pickerModelKind(model) === 'video') {
    const roles = (model.inputSlots ?? []).map((slot) => slot.role)
    if (roles.includes('first_frame')) return '视频 · 支持首帧图输入'
    return '视频 · 文生视频'
  }
  const supportsInput = (model.inputSlots ?? []).length > 0
  if (modelAcceptsMask(model)) return supportsInput ? '图像 · 支持参考图与局部修改' : '图像 · 支持局部修改'
  if (supportsInput) return '图像 · 支持参考图'
  return '图像 · 文生图'
}
