/** Longest short name a caption shows before it is cut with an ellipsis. */
const ASSET_TITLE_MAX_CHARS = 16

/**
 * Short display name for a work, taken from its prompt's first clause, so a tile and the
 * lightbox heading agree. `null` when the prompt is blank (the caller supplies the fallback).
 */
export function assetTitle(prompt: string | null | undefined): string | null {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  const clause = flat.split(/[，,。.！!？?；;、]/)[0]?.trim() || flat
  const chars = Array.from(clause)
  return chars.length > ASSET_TITLE_MAX_CHARS ? `${chars.slice(0, ASSET_TITLE_MAX_CHARS).join('')}…` : clause
}

/** Desktop density is a preference; small screens always keep a readable single column. */
export function libraryGridClass(columns: 2 | 3 | 4 | 6): string {
  if (columns === 2) return 'grid-cols-1 sm:grid-cols-2'
  if (columns === 3) return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
  if (columns === 6) return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6'
  return 'grid-cols-1 sm:grid-cols-2 md:grid-cols-4'
}

/** Wait for every deletion before reporting partial success, keeping failed IDs retryable. */
export async function deleteSelectedAssets(ids: readonly string[], remove: (id: string) => Promise<unknown>) {
  const results = await Promise.allSettled(ids.map((id) => remove(id)))
  return {
    succeeded: ids.filter((_, index) => results[index].status === 'fulfilled'),
    failed: ids.filter((_, index) => results[index].status === 'rejected'),
  }
}
