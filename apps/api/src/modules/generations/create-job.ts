import type { NextResponse } from 'next/server'
import { db, transaction } from '@musecanvas/database'
import { prepareGeneration, createGenerationInTransaction, generationCommandError, type CreateGenerationCommand } from '@musecanvas/media-service'
import type { Actor } from '../../auth/security'
import { fail, ok } from '../../shared/http'
import { jobDto } from '../../shared/dto'
import { loadSingleJobInputs, userJobSelect } from '../../shared/pagination'
import { resolveRuntimeSettings } from '../settings/runtime'

export interface CreateGenerationJobCommand extends Omit<CreateGenerationCommand, 'ownerId'> {
  actor: Actor
}

export interface GenerationJobPorts {
  database: typeof db
  runTransaction: typeof transaction
  runtimeLimits: () => Promise<{ maxImageBytes: number; maxTotalBytes: number; maxInputs: number }>
  jobDto: typeof jobDto
}
const generationJobPorts: GenerationJobPorts = { database: db, runTransaction: transaction, runtimeLimits: resolveRuntimeSettings, jobDto }

/** HTTP compatibility adapter; all generation writes live in the shared command. */
export async function createGenerationJob(cmd: CreateGenerationJobCommand, ports: GenerationJobPorts = generationJobPorts): Promise<NextResponse> {
  let row: Record<string, unknown>
  try {
    const { actor, ...command } = cmd
    const prepared = await prepareGeneration({ ...command, ownerId: actor.id }, ports)
    const result = await ports.runTransaction(client => createGenerationInTransaction(client, prepared))
    row = result.row
  } catch (error) {
    const { code, message, status, details } = generationCommandError(error)
    return fail(code, message, status, details)
  }
  const responseRow = await ports.database().query(`${userJobSelect} WHERE j.id=$1 AND j.created_by=$2`, [row.id, cmd.actor.id])
  const jobInputs = await loadSingleJobInputs(ports.database(), row.id as string)
  return ok(await ports.jobDto(responseRow.rows[0] || row, [], jobInputs), { status: 202 })
}
