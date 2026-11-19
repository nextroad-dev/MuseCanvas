import { CleanupJobRepository, CleanupLeaseLost, db, type CleanupBlockCode, type CleanupClaim, type CleanupKind, type CleanupWaitCode } from '@musecanvas/database'
import { accountCleanupReadiness, AccountCleanupDeferred } from './account-readiness'
import { purgeCanvasContentForActor } from './canvas-cleanup'

class CleanupBudgetExhausted extends Error {}
interface ClaimedCleanupOptions {
  now: () => number
  deadline: number
  deleteObject: (key: string, signal?: AbortSignal) => Promise<void>
}

/** Claim one job at a time. A storage operation is never inside a database transaction. */
export async function cleanupClaimedJobs({ now, deadline, deleteObject }: ClaimedCleanupOptions): Promise<void> {
  const jobs = new CleanupJobRepository(db())
  const drained = new Set<CleanupKind>()
  const checkBudget = () => { if (now() >= deadline) throw new CleanupBudgetExhausted() }
  const remove = async (claim: CleanupClaim, key: string) => {
    checkBudget()
    await jobs.renew(claim)
    checkBudget()
    await deleteObject(key, AbortSignal.timeout(Math.max(1, Math.min(10_000, Math.ceil(deadline - now())))))
  }
  for (let round = 0; round < 50; round += 1) {
    for (const kind of ['asset', 'account'] as const) {
      if (now() >= deadline) return
      if (drained.has(kind) || (kind === 'account' && round >= 10)) continue
      const claim = await jobs.claim(kind)
      if (!claim) { drained.add(kind); continue }
      try {
        if (kind === 'asset') {
          await remove(claim, claim.objectKey!)
          await jobs.withClaim(claim, async () => {}, true)
          continue
        }
        const ownerId = claim.userId!
        const readiness = await jobs.withClaim(claim, client => accountCleanupReadiness(client, ownerId))
        // Commit cancellation intent before yielding; throwing inside withClaim would roll it back.
        if (readiness) throw new AccountCleanupDeferred(readiness)
        const assets = await db().query('SELECT id,object_key,thumbnail_object_key,poster_object_key FROM assets WHERE created_by=$1 AND deleted_at IS NULL ORDER BY id LIMIT 50', [ownerId])
        for (const asset of assets.rows) {
          for (const key of new Set([asset.object_key, asset.thumbnail_object_key, asset.poster_object_key].filter(Boolean))) await remove(claim, String(key))
          await jobs.withClaim(claim, client => client.query('UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE id=$1 AND created_by=$2', [asset.id, ownerId]))
        }
        const images = await db().query('SELECT id,object_key FROM generation_input_images WHERE created_by=$1 AND object_deleted_at IS NULL ORDER BY id LIMIT 50', [ownerId])
        for (const image of images.rows) {
          await remove(claim, String(image.object_key))
          await jobs.withClaim(claim, client => client.query("UPDATE generation_input_images SET object_deleted_at=now(),status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1 AND created_by=$2", [image.id, ownerId]))
        }
        const uploads = await db().query('SELECT id,object_key FROM media_uploads WHERE created_by=$1 AND object_deleted_at IS NULL ORDER BY id LIMIT 50', [ownerId])
        for (const upload of uploads.rows) {
          await remove(claim, String(upload.object_key))
          await jobs.withClaim(claim, client => client.query("UPDATE media_uploads SET object_deleted_at=now(),status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1 AND created_by=$2", [upload.id, ownerId]))
        }
        checkBudget()
        if (assets.rows.length || images.rows.length || uploads.rows.length) { await jobs.release(claim); continue }
        await jobs.withClaim(claim, async client => {
          const reason = await accountCleanupReadiness(client, ownerId)
          if (reason) throw new AccountCleanupDeferred(reason)
          const pending = await client.query('SELECT 1 FROM asset_deletion_jobs d JOIN assets a ON a.id=d.asset_id WHERE a.created_by=$1 AND d.completed_at IS NULL LIMIT 1', [ownerId])
          if (pending.rows.length) throw new AccountCleanupDeferred('WAITING_OBJECT_DELETION')
          await purgeCanvasContentForActor(client, ownerId)
          await client.query('UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [ownerId])
          await client.query('UPDATE generation_jobs SET deleted_at=COALESCE(deleted_at,now()),prompt=NULL WHERE created_by=$1', [ownerId])
          await client.query("UPDATE prompt_optimizations SET deleted_at=COALESCE(deleted_at,now()),input_prompt='',final_prompt=NULL,template_instruction_snapshot=NULL WHERE created_by=$1", [ownerId])
          await client.query("UPDATE generation_input_images SET status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE created_by=$1", [ownerId])
          await client.query("UPDATE media_uploads SET status='deleted',deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE created_by=$1", [ownerId])
          await client.query("UPDATE users SET email=concat('deleted-',id,'@invalid.local') WHERE id=$1", [ownerId])
        }, true)
      } catch (error) {
        if (error instanceof CleanupLeaseLost) continue
        if (error instanceof AccountCleanupDeferred) {
          if (error.code.startsWith('BLOCKED_')) {
            await jobs.block(claim, error.code as CleanupBlockCode)
            console.warn('account cleanup blocked', { code: error.code })
          } else await jobs.release(claim, error.code as CleanupWaitCode)
        } else if (error instanceof CleanupBudgetExhausted) await jobs.release(claim)
        else await jobs.retry(claim)
      }
    }
    if (drained.size === 2) break
  }
}
