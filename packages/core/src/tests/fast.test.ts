import { expect, test } from 'bun:test'
import { isFastModeSupportedModel } from '../constants'

for (const [model, expected] of [
  ['claude-opus-4-6', false],
  ['claude-opus-4-7', false],
  ['claude-opus-4-7[1m]', false],
  ['claude-opus-4-8', true],
  ['claude-opus-4-8-20260901', true],
  ['claude-opus-5', true],
  ['claude-opus-5-5', true],
  ['claude-opus-5-5[1m]', true],
  ['claude-sonnet-5', false],
] as const) {
  test(`fast mode eligibility for ${model} is ${expected}`, () => {
    expect(isFastModeSupportedModel(model)).toBe(expected)
  })
}
