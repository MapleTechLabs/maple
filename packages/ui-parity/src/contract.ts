/**
 * The seam between the capture side (cli, build, capture, compare, report) and the fixture
 * backend (backend/*, fixtures/*). Both sides import only this file from each other.
 */

import type { Schema } from "effect"

/** Dataset chosen per request; the capture side sets it on every request it lets through. */
export const DATASET_HEADER = "x-parity-dataset"
/** Capture id, so the backend can attribute each call to one variant's call log. */
export const CAPTURE_HEADER = "x-parity-capture"

/** Scenario-level `Faults` as JSON, merged over the dataset's own (the scenario wins per prefix). */
export const FAULTS_HEADER = "x-parity-faults"

/**
 * Deliberate slowness and failures, keyed by endpoint tag prefix (`queryEngine.executeBatch`,
 * `alerts.`); the longest matching prefix wins, and a key ending in `$` matches one tag exactly.
 * HttpApi endpoints only, not Electric or raw routes.
 */
export interface Faults {
	/** Milliseconds the backend holds a matching request (after logging it) before answering. */
	readonly delays?: Readonly<Record<string, number>>
	/** Matching requests are answered with this status and encoded error body instead. */
	readonly failures?: Readonly<Record<string, FaultFailure>>
	/**
	 * Local server tags (`local.status`, `local.query`) refused at the network level, as when
	 * `maple start` is not running. The capture aborts them before the backend sees them.
	 */
	readonly refusals?: ReadonlyArray<string>
}

/** An encoded error the endpoint declares, e.g. `{ _tag: "@maple/http/errors/...", message }`, at its status. */
export interface FaultFailure {
	readonly status: number
	readonly body: Schema.JsonObject
}

/** One request the app made, as the backend saw it. */
export interface CallLogEntry {
	/** `"<group>.<endpoint>"` for HttpApi endpoints, `"warehouse:<query fingerprint>"` for each query inside an execute-batch, `"shape:<table>"` for Electric. */
	readonly tag: string
	/** Decoded payload / url params / query, normalized (sorted keys, random UUIDs replaced). */
	readonly payload: Schema.Json
}

export interface DatasetIdentity {
	readonly orgId: string
	readonly userId: string
	readonly email: string
	readonly name: string
	readonly orgName: string
	readonly orgSlug: string
	readonly role: "admin" | "member"
	/** Clerk only: the organization's public metadata (rollout flags, regions). Empty when absent. */
	readonly orgPublicMetadata?: Readonly<Record<string, unknown>>
}

export interface DatasetSummary {
	readonly name: string
	/** Frozen wall clock for the browser (`page.clock.setFixedTime`) and the seeded warehouse. */
	readonly now: string
	/** `null` = signed out. */
	readonly identity: DatasetIdentity | null
	/** Which auth the browser runs: self-hosted token in localStorage, or the `window.Clerk` stub. */
	readonly auth: "self_hosted" | "clerk"
}

export interface FixtureBackend {
	/** Origin the builds are configured with (`VITE_API_BASE_URL` etc. are derived from it). */
	readonly apiOrigin: string
	readonly electricOrigin: string
	readonly datasets: ReadonlyArray<DatasetSummary>
	/** Calls recorded for one capture id, then forgotten. */
	readonly takeCalls: (captureId: string) => {
		readonly calls: ReadonlyArray<CallLogEntry>
		/** Requests no handler answered: each one fails the variant. */
		readonly unmocked: ReadonlyArray<string>
	}
	/** Requests of one capture the backend is holding right now (`Faults.delays`). */
	readonly held: (captureId: string) => number
	readonly close: () => Promise<void>
}

export interface StartBackendOptions {
	/** `PARITY_PORT_BASE + 0` (API) and `+ 3` (Electric). */
	readonly apiPort: number
	readonly electricPort: number
}

export type StartBackend = (options: StartBackendOptions) => Promise<FixtureBackend>
