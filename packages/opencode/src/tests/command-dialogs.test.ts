import { describe, expect, test } from 'bun:test'
import {
  buildAccountDialogOption,
  buildKillswitchThresholdSeed,
} from '../tui/command-dialogs'

describe('buildKillswitchThresholdSeed', () => {
  test('preserves scoped killswitch thresholds in the TUI edit seed', () => {
    expect(
      buildKillswitchThresholdSeed(
        {
          main: { five_hour: 5, seven_day: 10, scoped: 20 },
          accounts: {
            umut: { five_hour: 3, seven_day: 8, scoped: 0 },
          },
        },
        ['umut'],
      ),
    ).toBe('main:5,10,20 umut:3,8,0')
  })

  test('falls back to main thresholds and scoped default for accounts without overrides', () => {
    expect(
      buildKillswitchThresholdSeed({ main: { five_hour: 5, seven_day: 10 } }, [
        'umut',
      ]),
    ).toBe('main:5,10,0 umut:5,10,0')
  })
})

describe('buildAccountDialogOption', () => {
  test('threads the tier label into the account row detail', () => {
    expect(
      buildAccountDialogOption({
        id: 'work',
        label: 'Work',
        role: 'fallback',
        enabled: true,
        quotaPercent: 22,
        tierLabel: 'Team · Max 5x',
      }),
    ).toEqual({
      title: 'Work [fallback] 22%',
      value: 'work',
      description: 'Team · Max 5x',
    })
  })
})
