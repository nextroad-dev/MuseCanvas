# @musecanvas/media-service

Server-side media application commands shared by API and Worker. This package has no HTTP, authentication Actor, Redis client or object-storage singleton. Only the application adapters serialize HTTP responses and resolve application defaults.

## Generation transaction contract

1. Call `prepareGeneration({ ownerId, ...command }, ports)` before acquiring Agent/generation transaction locks. It resolves runtime policy, clones/normalizes the request and validates the declared model contract. It throws `MediaServiceError` for business validation failures.
2. Start the application's transaction. For an Agent caller, check fencing/cancellation/input revision and reserve budget here.
3. Call `createGenerationInTransaction(client, prepared)`. It never opens, commits or rolls back a transaction. It returns `{ jobId, row, replayed }`, not an HTTP response. New jobs are revalidated against the currently locked model revision; a changed normalization is rejected rather than pairing old parameters with a new revision. A still-valid request uses the locked revision identity.
4. Write the caller's ToolJobLink and related bookkeeping using the same client. Commit only after all caller and media writes succeed.
5. **On any exception, roll back the entire transaction.** Do not catch a command failure inside a transaction and then commit. The function intentionally lets raw SQL errors escape, including errors after the job insert. `generationCommandError(error)` maps failures to a safe typed public error only after rollback at the application boundary.

The command includes job, owner-scoped input attachment, prompt optimization snapshot and `generation.requested` outbox writes. Same-owner/key replay checks the complete normalized payload and performs no new writes. An insert conflict re-reads the concurrent winner. Provider and storage network calls never execute while these transaction locks are held. The package checks stored credential configuration without decrypting or returning credentials.

`prepareImageEditCommand({ ownerId, ports, ...input })` is a separate, transaction-external preparation phase. Its typed result is `{ success: true, data } | { success: false, error: MediaServiceError }`. Model/source SQL or runtime infrastructure failures may reject. Inject the storage/runtime ports, and for Agent reserved masks inject the existing fenced `reservedMask.persist` operation. No default storage driver or callback into API generation logic is required. Stable IDs, checksums, dry runs, immutable reserved masks and tombstone/late-PUT cleanup retain their existing semantics.

## Schema compatibility

The current migrated schema is required; no migrations run on import or command execution. In particular `0016_wave1_media_uploads.sql` defines `media_uploads`, upload/asset foreign keys and role/position linkage. The existing edit preparation system additionally uses the current `0033_canvas_agent_preparations.sql` application integration.

A missing generic upload **row** may fall back to an owner-scoped legacy `generation_input_images` row. Such a binding uses `input_image_id` with `upload_id = NULL`, avoiding a foreign key to a nonexistent generic row. Generic image uploads retain their generic/legacy dual linkage. Worker input loading recognizes both, without duplicating mirrored inputs.

A missing table or other SQL error must fail the transaction. Catching a missing-table error and issuing more SQL does not restore a PostgreSQL transaction; the previous compatibility branch could not work on real PostgreSQL. No SQL failures are suppressed in shared attach/staging writes.

## Validation

- `pnpm --filter @musecanvas/media-service test`
- `pnpm --filter @musecanvas/media-service typecheck`
- `pnpm --filter @musecanvas/media-service lint`

Tests use recording transaction/SQL/storage ports and real local image decoding/mask generation. They do not start services, call real Providers, prove PostgreSQL foreign-key/concurrency behavior, or apply migrations. Existing API and Worker suites cover the compatibility adapters and consumer integration; live database verification remains a separately authorized integration check.
