import type { DatasetIdentity } from "../contract.ts"

/** Frozen wall clock shared by every dataset: browser clock, warehouse seed and fixture rows. */
export const FROZEN_NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0)
export const FROZEN_NOW = new Date(FROZEN_NOW_MS).toISOString()

/** `FROZEN_NOW` minus a duration, as an ISO string (what timestamptz columns carry). */
export const isoBefore = (ms: number): string => new Date(FROZEN_NOW_MS - ms).toISOString()

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** The Acme Shop admin; same person in every dataset that has an org. */
export const acmeAdmin: DatasetIdentity = {
	orgId: "org_parity_acme",
	userId: "user_parity_ada",
	email: "ada@acme.test",
	name: "Ada Lovelace",
	orgName: "Acme Shop",
	orgSlug: "acme-shop",
	role: "admin",
}

/** A brand-new org with no telemetry: every page shows its empty state. */
export const newOrgAdmin: DatasetIdentity = {
	orgId: "org_parity_new",
	userId: "user_parity_grace",
	email: "grace@newco.test",
	name: "Grace Hopper",
	orgName: "NewCo",
	orgSlug: "newco",
	role: "admin",
}

/**
 * Deterministic UUIDs for fixture rows. Version 7 layout on purpose: the call log only rewrites
 * v4 UUIDs (random ones the app mints), so ids the app echoes back stay distinguishable.
 */
export const fixtureUuid = (namespace: number, index: number): string =>
	`0199a${namespace.toString(16).padStart(3, "0")}-0000-7000-8000-${index.toString(16).padStart(12, "0")}`
