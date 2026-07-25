import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CACHE_KEEP_REGISTRY_LEASE_MS,
  CacheKeepSessionRegistry,
  type CacheKeepTrackedSession,
} from '@cortexkit/anthropic-auth-core'

function session(id: string, cacheExpiresAt: number): CacheKeepTrackedSession {
  return {
    id,
    cacheExpiresAt,
    nextPrewarmAt: cacheExpiresAt - 5 * 60_000,
  }
}

describe('CacheKeepSessionRegistry', () => {
  let directory: string
  let now: number

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cachekeep-registry-test-'))
    now = new Date('2026-07-13T10:00:00Z').getTime()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('aggregates and sorts live sessions from multiple plugin instances', async () => {
    const first = new CacheKeepSessionRegistry({
      directory,
      instanceId: 'first',
      now: () => now,
    })
    const second = new CacheKeepSessionRegistry({
      directory,
      instanceId: 'second',
      now: () => now,
    })

    await first.publish([session('ses_b', now + 60 * 60_000)])
    await second.publish([session('ses_a', now + 45 * 60_000)])

    expect(await first.list()).toEqual([
      session('ses_a', now + 45 * 60_000),
      session('ses_b', now + 60 * 60_000),
    ])
  })

  test('deduplicates a session using the newest cache expiry', async () => {
    const first = new CacheKeepSessionRegistry({
      directory,
      instanceId: 'first',
      now: () => now,
    })
    const second = new CacheKeepSessionRegistry({
      directory,
      instanceId: 'second',
      now: () => now,
    })

    await first.publish([session('ses_shared', now + 30 * 60_000)])
    await second.publish([session('ses_shared', now + 60 * 60_000)])

    expect(
      await first.list([session('ses_shared', now + 15 * 60_000)]),
    ).toEqual([session('ses_shared', now + 60 * 60_000)])
  })

  test('excludes expired instance leases while retaining the caller local state', async () => {
    const active = new CacheKeepSessionRegistry({
      directory,
      instanceId: 'active',
      now: () => now,
    })
    const stopped = new CacheKeepSessionRegistry({
      directory,
      instanceId: 'stopped',
      now: () => now,
    })
    await active.publish([session('ses_active', now + 60 * 60_000)])
    await stopped.publish([session('ses_stopped', now + 60 * 60_000)])

    now += CACHE_KEEP_REGISTRY_LEASE_MS + 1
    const current = session('ses_active', now + 60 * 60_000)
    expect(await active.list([current])).toEqual([current])
  })

  test('removes an instance record when it no longer tracks sessions', async () => {
    const registry = new CacheKeepSessionRegistry({
      directory,
      instanceId: 'instance',
      now: () => now,
    })
    await registry.publish([session('ses_one', now + 60 * 60_000)])
    expect(await registry.list()).toHaveLength(1)

    await registry.publish([])
    expect(await registry.list()).toEqual([])
  })
})
