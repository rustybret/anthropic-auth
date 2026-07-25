/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

type PersistedQuotaState = {
  main?: {
    quota?: {
      source?: string
      five_hour?: { usedPercent?: number }
      seven_day?: { usedPercent?: number }
    }
    quotaToken?: string
  }
}

async function readQuotaState(harness: E2EHarness) {
  const statePath = join(
    harness.opencode.env.configDir,
    'anthropic-auth-state.json',
  )
  return readFile(statePath, 'utf8')
    .then((value) => JSON.parse(value) as PersistedQuotaState)
    .catch(() => null)
}

async function waitForHeaderQuotaState(harness: E2EHarness) {
  let state: PersistedQuotaState | null = null
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await readQuotaState(harness)
    if (state?.main?.quota?.source === 'headers') return state
    await Bun.sleep(50)
  }
  throw new Error(
    `relay quota state did not persist: ${JSON.stringify(state)}\n--- stdout ---\n${harness.opencode.stdout()}\n--- stderr ---\n${harness.opencode.stderr()}`,
  )
}

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

describe('quota headers through relay', () => {
  it('harvests quota headers from a websocket relay response', async () => {
    harness = await E2EHarness.create({ relay: 'websocket' })
    harness.script([
      {
        type: 'text',
        text: 'relay response',
        headers: {
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-5h-utilization': '0.78',
          'anthropic-ratelimit-unified-5h-reset': '1784246400',
          'anthropic-ratelimit-unified-7d-utilization': '0.4',
          'anthropic-ratelimit-unified-7d-reset': '1784628000',
          'anthropic-ratelimit-unified-fallback': 'available',
        },
      },
    ])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the relay response')
    await harness.waitFor(() => (harness?.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'relay request accepted',
    })

    const state = await waitForHeaderQuotaState(harness)

    expect(state?.main?.quota?.source).toBe('headers')
    expect(state?.main?.quota?.five_hour?.usedPercent).toBe(78)
    expect(state?.main?.quota?.seven_day?.usedPercent).toBe(40)
    expect(state?.main?.quotaToken).toBe(
      createHash('sha256')
        .update('test-access-token')
        .digest('hex')
      .slice(0, 16),
    )
  }, 90_000)

  it('leaves quota state untouched when websocket relay headers have no quota data', async () => {
    harness = await E2EHarness.create({ relay: 'websocket' })
    harness.script([{ type: 'text', text: 'relay response without quota' }])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the relay response')
    await harness.waitForSessionText(sessionId, 'relay response without quota')
    await harness.waitFor(() => (harness?.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'relay request accepted',
    })

    const state = await readQuotaState(harness)
    expect(state?.main?.quota).toBeUndefined()
    expect(state?.main?.quotaToken).toBeUndefined()
  }, 90_000)
})
