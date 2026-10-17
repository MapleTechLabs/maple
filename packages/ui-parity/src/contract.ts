/**
 * The seam between the capture side (cli, build, capture, compare, report) and the fixture
 * backend (backend/*, fixtures/*). Both sides import only this file from each other.
 */

/** Dataset chosen per request; the capture side sets it on every request it lets through. */
export const DATASET_HEADER = "x-parity-dataset"
/** Capture id, so the backend can attribute each call to one variant's call log. */
export const CAPTURE_HEADER = "x-parity-capture"

/** One request the app made, as the backend saw it. */
export interface CallLogEntry {
	/** `"<group>.<endpoint>"` for HttpApi endpoints, `"warehouse:<query fingerprint>"` for each query inside an execute-batch, `"shape:<table>"` for Electric. */
	readonly tag: string
	/** Decoded payload / url params / query, normalized (sorted keys, random UUIDs replaced). */
	readonly payload: unknown
}

export interface DatasetIdentity {
	readonly orgId: string
	readonly userId: string
	readonly email: string
	readonly name: string
	readonly orgName: string
	readonly orgSlug: string
	readonly role: "admin" | "member"
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
	readonly close: () => Promise<void>
}

export interface StartBackendOptions {
	/** `PARITY_PORT_BASE + 0` (API) and `+ 3` (Electric). */
	readonly apiPort: number
	readonly electricPort: number
}

export type StartBackend = (options: StartBackendOptions) => Promise<FixtureBackend>
