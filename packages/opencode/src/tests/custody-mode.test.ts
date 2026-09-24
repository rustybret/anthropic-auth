import { expect, test } from 'bun:test'
import {
  CustodyStateMismatchError,
  reconcileCustodyStartup,
} from '../custody-mode.ts'

test('local OAuth and enrolled scoped custody are the only serving states', () => {
  expect(
    reconcileCustodyStartup({
      mode: 'L',
      main: 'R',
      fallbacks: 'R',
      evidence: 'V',
    }).verdict,
  ).toBe('LOCAL_SERVE')
  expect(
    reconcileCustodyStartup({
      mode: 'C',
      main: 'T',
      fallbacks: 'T',
      evidence: 'V',
    }).verdict,
  ).toBe('CLAUSTRUM_SERVE')
  for (const input of [
    { mode: 'C', main: 'T', fallbacks: 'M', evidence: 'V' },
    { mode: 'C', main: 'R', fallbacks: 'T', evidence: 'V' },
    { mode: 'C', main: 'T', fallbacks: 'T', evidence: 'N' },
    { mode: 'L', main: 'T', fallbacks: 'R', evidence: 'V' },
  ] as const) {
    expect(() => reconcileCustodyStartup(input)).toThrow(
      CustodyStateMismatchError,
    )
  }
})
