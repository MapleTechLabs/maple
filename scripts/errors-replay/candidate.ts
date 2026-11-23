/**
 * A PROPOSED grouping, replayed against real samples before it ships.
 *
 * Nothing in production reads this. It exists so a grouping change can be
 * measured (`bun run errors:replay`) instead of argued. Production groups in two
 * steps: the warehouse hash (`fingerprint.ts`, the MV SQL) and the grouping key
 * the errors tick computes from a sample (`grouping.ts`), which only merges hashes.
 * `candidateKey` starts as a copy of production: edit it to propose a change. When a
 * proposal wins, port it (a merge belongs in grouping.ts and bumps
 * GROUPING_KEY_VERSION; a split needs the hash and FINGERPRINT_VERSION), and reset
 * this file.
 */
import { computeFingerprintInputs } from "../../packages/domain/src/tinybird/fingerprint"
import { groupingKey } from "../../packages/domain/src/tinybird/grouping"

export interface ReplayEvent {
	/** Keys the grouping like production does; a single-org sample may leave it out. */
	readonly orgId?: string | undefined
	readonly serviceName: string
	readonly exceptionType: string
	readonly statusMessage: string
	readonly exceptionStacktrace: string
	/**
	 * The failing span, which keys an error with no message, stack or named type.
	 * `error_events` does not store it: a sample without it replays those as one key
	 * per service and type, and the parity line counts them as differences.
	 */
	readonly span?: { readonly kind: string; readonly name: string } | undefined
	/** The raw `maple.fingerprint` value, when the sample carries one. */
	readonly customFingerprint?: string | undefined
}

/** The warehouse hash alone: how errors grouped before the grouping key. */
export function hashKey(event: ReplayEvent): string {
	return [event.orgId ?? "", event.serviceName, ...computeFingerprintInputs(event).hashInputs].join(
		"\u0000",
	)
}

/** How production groups today: hashes sharing a grouping key are one issue. */
export function currentKey(event: ReplayEvent): string {
	return `${event.orgId ?? ""}\u0000${groupingKey(event)}`
}

/** The proposal. No proposal is open, so this is production. */
export function candidateKey(event: ReplayEvent): string {
	return currentKey(event)
}
