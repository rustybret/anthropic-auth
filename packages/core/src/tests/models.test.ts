import { describe, expect, test } from 'bun:test'
import { isClaudeSonnet5Model } from '../models'

describe('isClaudeSonnet5Model', () => {
  test('matches the bare claude-sonnet-5 id', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5')).toBe(true)
  })

  test('matches a dated claude-sonnet-5 snapshot', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5-20260630')).toBe(true)
  })

  test('does not match claude-sonnet-4-6', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-4-6')).toBe(false)
  })

  test('does not match the Fable/Mythos ids', () => {
    expect(isClaudeSonnet5Model('claude-fable-5')).toBe(false)
    expect(isClaudeSonnet5Model('claude-mythos-5')).toBe(false)
  })

  test('does not match a non-dash prefix collision', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5x')).toBe(false)
  })

  test('does not match non-string input', () => {
    expect(isClaudeSonnet5Model(undefined)).toBe(false)
    expect(isClaudeSonnet5Model(42)).toBe(false)
  })
})
