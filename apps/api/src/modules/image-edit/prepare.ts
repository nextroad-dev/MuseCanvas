import {
  prepareImageEditCommand,
  type PrepareImageEditInput as SharedPrepareImageEditInput,
  type PreparedImageEdit,
} from '@musecanvas/media-service'
import type { NextResponse } from 'next/server'
import type { Actor } from '../../auth/security'
import { fail } from '../../shared/http'
import { defaultImageEditPorts, type ImageEditPorts } from './input-rows'

export { createStableUploadIds } from '@musecanvas/media-service'
export type { PreparedImageEdit }
export interface PrepareImageEditInput extends Omit<SharedPrepareImageEditInput, 'ownerId' | 'ports'> {
  actor: Actor
  ports?: ImageEditPorts
}
export type PrepareImageEditResult =
  | { success: true; data: PreparedImageEdit }
  | { success: false; response: NextResponse }

export async function prepareImageEdit(input: PrepareImageEditInput): Promise<PrepareImageEditResult> {
  const { actor, ...command } = input
  const result = await prepareImageEditCommand({ ...command, ownerId: actor.id, ports: input.ports ?? defaultImageEditPorts })
  if (result.success) return result
  const { code, message, status, details } = result.error
  return { success: false, response: fail(code, message, status, details) }
}
