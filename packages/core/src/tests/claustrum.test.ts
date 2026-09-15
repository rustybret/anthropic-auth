import { describe, expect, test } from 'bun:test'
import { basename, win32 } from 'node:path'

import { __deriveCustodyManifestStaleLockPrefix } from '../claustrum.ts'

describe('custody manifest stale-lock prefix', () => {
  test('derives prefixes from POSIX and Windows path basenames', () => {
    expect(
      __deriveCustodyManifestStaleLockPrefix(
        '/tmp/handles.json.lock',
        basename,
      ),
    ).toBe('handles.json.lock.stale-')
    expect(
      __deriveCustodyManifestStaleLockPrefix(
        'C:\\Users\\x\\handles.json.lock',
        win32.basename,
      ),
    ).toBe('handles.json.lock.stale-')
  })
})
