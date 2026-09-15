import {
  type PrimeManager,
  primeStorageFingerprint,
} from '@cortexkit/anthropic-auth-core'

type PrimeManagerEntry = {
  manager: PrimeManager
  slots: Set<string>
}

type PrimeManagerAdoption = {
  slot: string
  rebind: (manager: PrimeManager) => void
}

type SlotLease = {
  fingerprint: string
  marker: symbol
}

export interface AdoptedPrimeManager {
  manager: PrimeManager
  release: () => void
}

// Each project slot owns one lease at a time, while slots sharing a storage
// identity adopt one process-wide manager. The opaque lease marker prevents a
// disposed predecessor from releasing a same-slot successor after reload.
const primeManagers = new Map<string, PrimeManagerEntry>()
const slotLeases = new Map<string, SlotLease>()

function releaseSlot(slot: string, lease: SlotLease): void {
  const current = slotLeases.get(slot)
  if (
    current?.fingerprint !== lease.fingerprint ||
    current.marker !== lease.marker
  ) {
    return
  }

  const entry = primeManagers.get(lease.fingerprint)
  entry?.slots.delete(slot)
  if (entry?.slots.size === 0) {
    entry.manager.stop()
    primeManagers.delete(lease.fingerprint)
  }
  slotLeases.delete(slot)
}

export function adoptPrimeManager(
  storagePath: string,
  create: () => PrimeManager,
  adoption: PrimeManagerAdoption,
): AdoptedPrimeManager {
  const fingerprint = primeStorageFingerprint(storagePath)
  const existing = primeManagers.get(fingerprint)
  const manager = existing?.manager ?? create()
  if (existing) adoption.rebind(manager)

  const previous = slotLeases.get(adoption.slot)
  if (previous && previous.fingerprint !== fingerprint) {
    releaseSlot(adoption.slot, previous)
  }

  const entry = existing ?? { manager, slots: new Set<string>() }
  if (!existing) primeManagers.set(fingerprint, entry)

  const lease: SlotLease = { fingerprint, marker: Symbol(adoption.slot) }
  entry.slots.add(adoption.slot)
  slotLeases.set(adoption.slot, lease)

  return {
    manager,
    release: () => releaseSlot(adoption.slot, lease),
  }
}
