import type { InjectionKey } from 'vue'

/**
 * Context published by `Field` so the control it wraps can link itself to the
 * label, hint and error text without every call site wiring ids by hand.
 */
export interface FieldContext {
  /** Id of the control, referenced by `<label for>`. */
  controlId: string
  /** `aria-describedby` value for the hint/error text, when present. */
  describedBy: () => string | undefined
  /** Whether the field currently has an error. */
  invalid: () => boolean
}

export const FIELD_CONTEXT_KEY: InjectionKey<FieldContext> = Symbol('musecanvas-field')