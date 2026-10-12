// Which models a feature can actually be offered on.
//
// One home for the 局部修改 gate because two entry points need the same answer:
// the console's per-image action and the library lightbox that hands an asset to
// it. A diverging second copy is how a feature ends up callable from one door and
// refused by the other.

import { MASK_INPUT_ROLE } from '@musecanvas/contracts'
import type { MediaParameterProvenance, ModelConfig } from '@/shared/types'
import { modelMediaKind } from '@/shared/types'

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
  return (model.inputSlots ?? []).some((slot) => slot.role === MASK_INPUT_ROLE)
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
 * catalogue still offers it, else the first non-deprecated image model.
 *
 * Mirrors the resolution inside `generate-console.tsx`, which owns the `<select>`
 * and scopes it to the active tab; this exists for the call site that needs the
 * same answer without mounting the console — the library lightbox gates its
 * 局部修改 action here. The console writes its resolved fallback back into
 * `selectedModelIdByKind`, so the two agree from the second render onward.
 */
export function resolveActiveImageModel(
  models: readonly ModelConfig[],
  storedModelId: string,
): ModelConfig | undefined {
  const imageModels = models
    .filter((model) => modelMediaKind(model) !== 'video')
    .sort((left, right) => Number(left.deprecated === true) - Number(right.deprecated === true))
  return imageModels.find((model) => model.id === storedModelId) ?? imageModels[0]
}
