import type {
  MediaModelDefaultsDto,
  UpdateMediaModelDefaultsRequest,
} from '@musecanvas/contracts'

export interface MediaModelDefaultsSelection {
  imageModelId: string
  videoModelId: string
}

/** Empty selections and unchanged ids are omitted; null is never sent to PATCH. */
export function buildMediaModelDefaultsRequest(
  current: MediaModelDefaultsDto,
  selection: MediaModelDefaultsSelection,
): UpdateMediaModelDefaultsRequest {
  const request: UpdateMediaModelDefaultsRequest = {}
  if (selection.imageModelId && selection.imageModelId !== current.imageModelId) {
    request.imageModelId = selection.imageModelId
  }
  if (selection.videoModelId && selection.videoModelId !== current.videoModelId) {
    request.videoModelId = selection.videoModelId
  }
  return request
}
