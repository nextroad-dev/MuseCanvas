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
