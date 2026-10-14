/**
 * A PROPOSED fingerprint, replayed against real samples before it ships.
 *
 * Nothing in production reads this. It exists so a grouping change can be
 * measured (`bun run errors:replay`) instead of argued. It starts as a copy of
 * production (v3, `packages/domain/src/tinybird/fingerprint.ts`): edit
 * `candidateInputs` to propose a change. When a proposal wins, port it to
 * fingerprint.ts and the MV SQL, bump FINGERPRINT_VERSION, and reset this file.
 */
import { computeFingerprintInputs } from "../../packages/domain/src/tinybird/fingerprint"

export interface ReplayEvent {
	readonly serviceName: string
	readonly exceptionType: string
	readonly statusMessage: string
	readonly exceptionStacktrace: string
}

interface KeyInputs {
	readonly fpFrames: string
	readonly msgSignature: string
}

const key = (event: ReplayEvent, inputs: KeyInputs): string =>
	[event.serviceName, event.exceptionType, inputs.fpFrames, inputs.msgSignature].join("\u0000")

/** The proposal. No proposal is open, so this is production. */
const candidateInputs = (event: ReplayEvent): KeyInputs => computeFingerprintInputs(event)

/** The grouping key production computes today (the TS mirror of the MV). */
export function currentKey(event: ReplayEvent): string {
	return key(event, computeFingerprintInputs(event))
}

/** The proposed grouping key. */
export function candidateKey(event: ReplayEvent): string {
	return key(event, candidateInputs(event))
}
