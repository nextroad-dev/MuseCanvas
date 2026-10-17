import type { QueryClient } from '@tanstack/react-query'
import type { GenerationJob } from '../types'

export function prependCreatedJob(previous: GenerationJob[] | undefined, job: GenerationJob, limit?: number): GenerationJob[] {
  const items = [job, ...(previous ?? []).filter((entry) => entry.id !== job.id)]
  return limit ? items.slice(0, limit) : items
}

/** Cancel stale list reads before publishing a 202 response to every cached list. */
export async function cacheCreatedJob(queryClient: QueryClient, job: GenerationJob): Promise<void> {
  const isList = (key: readonly unknown[]) => key[0] === 'jobs'
    && (key.length === 1 || (key.length === 2 && typeof key[1] === 'number'))
  await queryClient.cancelQueries({ predicate: (query) => isList(query.queryKey) })
  for (const [key, previous] of queryClient.getQueriesData<GenerationJob[]>({
    predicate: (query) => isList(query.queryKey),
  })) {
    queryClient.setQueryData(key, prependCreatedJob(previous, job, typeof key[1] === 'number' ? key[1] : undefined))
  }
  // The workbench reads this list; seed it even before its first successful GET.
  if (!queryClient.getQueryData(['jobs', 30])) queryClient.setQueryData(['jobs', 30], [job])
}
