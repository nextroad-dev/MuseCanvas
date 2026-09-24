// Media model capability & parameter metadata.
//
// This module is the single source of truth for what a media model can do.
// The whole point is that the declaration is written **once**, by the plugin
// that actually talks to the vendor, and then consumed unchanged by four
// different places: the browser's parameter UI, the browser's pre-submit
// validation, the API's authoritative validation, and the plugin's own request
// adapter. Any place where a capability is restated is a place where it can
// drift, so nothing here is duplicated into apps/* or packages/domain.
//
// Everything in this file (and in media-parameter-validation.ts) must stay a
// pure, dependency-free type/function module: `apps/web-next` imports it at
// runtime through the webpack alias in next.config.mjs, so a Node or DOM
// reference here would break the browser bundle.

import type {
  GenerationMode,
  InputSlotDescriptor,
  JsonPrimitive,
  JsonValue,
  MediaKind,
  ParameterDescriptor,
} from './index'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * One selectable value of an `enum` (or of an `image-size` preset family).
 *
 * `options` intentionally accepts a bare `string` as well as this object, and
 * consumers must go through `normalizeParameterOptions` rather than indexing
 * `options` directly. The reason is durability, not convenience: every
 * `model_config_revisions.capabilities` row written to date stores
 * `"options": ["1024x1024", ...]`, and an immutable revision can outlive any
 * migration we run today. Accepting both spellings means an old snapshot keeps
 * validating without a rewrite.
 */
export interface ParameterOption {
  value: string
  /** Display text. Falls back to `value` when absent. */
  label?: string
  /** Help text surfaced under the control, e.g. why a size is experimental. */
  description?: string
  /**
   * Supported but not yet guaranteed — rendered as a caveat, never as a
   * prohibition. High-resolution GPT Image output is the case that motivated
   * this flag: slower, partly experimental, and still the user's call.
   */
  experimental?: boolean
}

// ---------------------------------------------------------------------------
// Cross-parameter rules
// ---------------------------------------------------------------------------

/**
 * A parameter that only exists while another parameter holds one of a set of
 * values. `output_compression` is the canonical case: the vendor only accepts
 * it for `jpeg` / `webp`, so it must be hidden in the UI *and* dropped from the
 * request *and* rejected by the API when `output_format` is `png`.
 *
 * Visibility and legality are deliberately the same predicate for all three
 * consumers. If the browser hid a control that the server still accepted, we
 * would be back to sending values nobody intended to send.
 */
export interface ParameterDependency {
  parameter: string
  values: Array<JsonPrimitive>
}

// ---------------------------------------------------------------------------
// Rendering hints
// ---------------------------------------------------------------------------

export type ParameterControlKind =
  | 'select'
  | 'segmented'
  | 'number'
  | 'slider'
  | 'text'
  | 'switch'
  | 'size-picker'

/**
 * Presentation only. A control hint never widens what a value may be — the
 * descriptor's own `type` / `options` / `constraints` do that — so a hostile or
 * buggy manifest can produce an ugly form but never a lax check.
 */
export interface ParameterUiHint {
  control?: ParameterControlKind
  /** Grouped behind an "advanced" disclosure instead of the main control bar. */
  advanced?: boolean
  /** Render order within the parameter list; ties fall back to declaration order. */
  order?: number
  /** Suffix rendered after the value, e.g. `' 秒'`. Never part of the wire value. */
  unit?: string
}

// ---------------------------------------------------------------------------
// Image size
// ---------------------------------------------------------------------------

export interface ImageSizePreset {
  label: string
  /** Wire value: `auto`, or `${width}x${height}`. */
  value: string
  /** Structured dimensions so the UI can render `1:1 · 1024 × 1024` without parsing `value`. */
  width?: number
  height?: number
  description?: string
  experimental?: boolean
}

/**
 * Geometry limits for *custom* sizes, stated as numbers rather than as an
 * enumeration of allowed strings.
 *
 * This is the reason a plain `options: ['1024x1024']` was not enough: models
 * like GPT Image 2.5 accept any `WIDTHxHEIGHT` inside a band, so the set of
 * legal sizes is uncountably larger than any preset list, and a preset list
 * would silently forbid sizes the vendor supports while an `enum` would fail to
 * forbid the ones it does not.
 */
export interface ImageSizeConstraints {
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  widthMultipleOf?: number
  heightMultipleOf?: number
  minPixels?: number
  maxPixels?: number
  /** Long edge over short edge. `3` rejects `3840x1024` but allows `3840x1280`. */
  maxAspectRatio?: number
}

export interface ImageSizeParameterDescriptor {
  type: 'image-size'
  name: string
  label?: string
  description?: string
  required?: boolean
  /** Offered one-click. Presets are a convenience, not the legal set. */
  presets: ImageSizePreset[]
  allowCustom?: boolean
  /** Evaluated only when `allowCustom`; meaningless otherwise. */
  constraints?: ImageSizeConstraints
  defaultValue?: string
  dependsOn?: ParameterDependency
  ui?: ParameterUiHint
}

// ---------------------------------------------------------------------------
// Numeric (non-integer)
// ---------------------------------------------------------------------------

export interface NumberParameterDescriptor {
  type: 'number'
  name: string
  label?: string
  description?: string
  required?: boolean
  min?: number
  max?: number
  step?: number
  /** Decimal places accepted; guards against float noise like `0.30000000000000004`. */
  precision?: number
  defaultValue?: number
  dependsOn?: ParameterDependency
  ui?: ParameterUiHint
}

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/**
 * What a model can be asked to do, as opposed to what knobs it exposes.
 *
 * Every field is `boolean | undefined` and `undefined` means **unconfirmed**,
 * not `false`. That distinction is the whole point: a plugin that has not
 * declared `inpainting` must not have it rendered as "not supported" *and* must
 * not have it guessed as supported. Consumers gate on `=== true`.
 */
export interface ModelCapabilityFlags {
  textToImage?: boolean
  imageToImage?: boolean
  imageEdit?: boolean
  inpainting?: boolean
  mask?: boolean
  transparentBackground?: boolean
}

// ---------------------------------------------------------------------------
// Cross-field constraints
// ---------------------------------------------------------------------------

/**
 * Relational rules between two already-validated parameters. Lives here rather
 * than in `packages/domain` because the browser has to evaluate the exact same
 * rules to disable a submit button, and two implementations of "is this
 * combination legal" is the bug this module exists to remove.
 *
 * `targetValues` narrows a `forbidden` pair to specific values of the target,
 * which is how "transparent background may not be combined with `jpeg`, but
 * `png` and `webp` are fine" is expressed without inventing a second mechanism.
 */
export interface ParameterCrossFieldConstraint {
  type: 'requires' | 'forbidden' | 'mutually_exclusive' | 'max_product'
  parameter: string
  targetParameter?: string
  parameters?: [string, string]
  whenValueEquals?: JsonValue
  /** With `targetParameter`: the offending values of the target parameter. */
  targetValues?: JsonPrimitive[]
  maxProduct?: number
  message?: string
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a model's parameter contract came from, recorded so the system can tell
 * "this model takes no parameters" apart from "nobody ever declared this model".
 *
 * `undeclared` is a hard stop at the API boundary rather than a permissive
 * fallback. Falling back to "accept anything" is precisely the behaviour that
 * let `size: "9999x9999"` reach a vendor and fail there with an opaque error,
 * so an unknown model surfaces as an admin problem instead of a guessed one.
 */
export type MediaParameterProvenance = 'plugin-manifest' | 'host-synthesized' | 'undeclared'

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Every code the generation pipeline can return.
 *
 * The pre-existing literals are reproduced byte-for-byte: they are persisted in
 * `generation_jobs.error_code` and surfaced through `jobDto.errorCode`, so a
 * rename would rewrite history for no functional gain. The three `MEDIA_*` /
 * `MODEL_CAPABILITIES_*` additions are new and only ever produced by parameter
 * validation.
 *
 * Modelled on `SetupErrorCode` / `PromptTemplateErrorCode` — a const object
 * plus a derived union, so the values stay importable at runtime.
 */
export const GenerationErrorCode = {
  INVALID_MODEL_ID: 'INVALID_MODEL_ID',
  INVALID_PROMPT: 'INVALID_PROMPT',
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  UNKNOWN_PARAMETER: 'UNKNOWN_PARAMETER',
  MISSING_REQUIRED_PARAMETER: 'MISSING_REQUIRED_PARAMETER',
  INVALID_PARAMETER_TYPE: 'INVALID_PARAMETER_TYPE',
  INVALID_PARAMETER_VALUE: 'INVALID_PARAMETER_VALUE',
  PARAMETER_OUT_OF_RANGE: 'PARAMETER_OUT_OF_RANGE',
  PARAMETER_STEP_MISMATCH: 'PARAMETER_STEP_MISMATCH',
  TEXT_TOO_SHORT: 'TEXT_TOO_SHORT',
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  TEXT_PATTERN_MISMATCH: 'TEXT_PATTERN_MISMATCH',
  UNSUPPORTED_GENERATION_MODE: 'UNSUPPORTED_GENERATION_MODE',
  EMPTY_PROMPT: 'EMPTY_PROMPT',
  INVALID_COUNT: 'INVALID_COUNT',
  UNKNOWN_INPUT_ROLE: 'UNKNOWN_INPUT_ROLE',
  INVALID_INPUT_ROLE: 'INVALID_INPUT_ROLE',
  INVALID_INPUT_ITEM: 'INVALID_INPUT_ITEM',
  INVALID_INPUTS: 'INVALID_INPUTS',
  INVALID_INPUT_POSITION: 'INVALID_INPUT_POSITION',
  DUPLICATE_INPUT_POSITION: 'DUPLICATE_INPUT_POSITION',
  INVALID_INPUT_UPLOAD_ID: 'INVALID_INPUT_UPLOAD_ID',
  INVALID_INPUT_REF: 'INVALID_INPUT_REF',
  DUPLICATE_INPUT_REF: 'DUPLICATE_INPUT_REF',
  MISSING_REQUIRED_INPUT: 'MISSING_REQUIRED_INPUT',
  INPUT_COUNT_TOO_LOW: 'INPUT_COUNT_TOO_LOW',
  INPUT_COUNT_EXCEEDED: 'INPUT_COUNT_EXCEEDED',
  REQUIRED_FIELD_MISSING: 'REQUIRED_FIELD_MISSING',
  FORBIDDEN_FIELD_PRESENT: 'FORBIDDEN_FIELD_PRESENT',
  MUTUALLY_EXCLUSIVE_PARAMETERS: 'MUTUALLY_EXCLUSIVE_PARAMETERS',
  MAX_PRODUCT_EXCEEDED: 'MAX_PRODUCT_EXCEEDED',

  /** A value the model does not offer: `quality=max` on a model without `max`. */
  UNSUPPORTED_MEDIA_PARAMETER: 'UNSUPPORTED_MEDIA_PARAMETER',
  /** A well-formed value that breaks a geometry or combination rule. */
  MEDIA_PARAMETER_CONSTRAINT_FAILED: 'MEDIA_PARAMETER_CONSTRAINT_FAILED',
  /** The pinned revision carries no parameter contract, so nothing can be checked. */
  MODEL_CAPABILITIES_UNDECLARED: 'MODEL_CAPABILITIES_UNDECLARED',
} as const

export type GenerationErrorCode = (typeof GenerationErrorCode)[keyof typeof GenerationErrorCode]

/**
 * Machine-readable context attached to a validation failure so the client can
 * point at the offending control instead of showing a sentence.
 */
export interface ParameterErrorDetails {
  parameter?: string
  value?: JsonValue
  constraint?: string
}

// ---------------------------------------------------------------------------
// Public model DTO
// ---------------------------------------------------------------------------

/**
 * The wire shape of `GET /api/models`.
 *
 * Declared here because until now it existed only as the return value of
 * `publicModelDto` plus a hand-maintained mirror in `apps/web-next` that every
 * response was `as`-cast to. That cast is the reason backend/frontend drift was
 * invisible: a renamed field typechecked forever. With a real contract type the
 * mirror can be checked against it.
 */
export interface PublicModelDto {
  id: string
  displayName: string
  modelKind: MediaKind
  providerId?: string
  pluginId?: string
  pluginVersion: string
  modes: GenerationMode[]
  parameters: ParameterDescriptor[]
  inputSlots: InputSlotDescriptor[]
  defaults: Record<string, JsonValue>
  maxCount: number
  maxInputImages: number
  supportedMediaKinds: MediaKind[]
  flags?: ModelCapabilityFlags
  crossFieldConstraints?: ParameterCrossFieldConstraint[]
  declaredBy?: MediaParameterProvenance
  deprecated?: boolean
  deprecationNote?: string
  /**
   * @deprecated Derived mirrors of the descriptor set, kept because the columns
   * are NOT NULL and older job rows echo them. Never authoritative, and no new
   * reader should consume them.
   */
  adapter: string
  /** @deprecated Read `parameters` / the `image-size` descriptor instead. */
  sizes: string[]
  /** @deprecated Read the `quality` descriptor's options instead. */
  qualityOptions: string[]
  enabled: boolean
  sortOrder: number
}
