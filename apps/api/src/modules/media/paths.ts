// Path segments under /api for the local-disk media endpoints. Kept free of imports so the
// storage layer can build signed URLs without importing the handlers.
export const MEDIA_ROUTE_PATHS = {
  object: 'media/object',
  upload: 'media/upload',
} as const

/** Browser-facing prefix for local signed URLs, e.g. `/api/media/object`. */
export const MEDIA_ROUTE_PREFIX = '/api'
