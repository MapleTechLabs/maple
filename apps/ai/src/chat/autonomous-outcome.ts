/**
 * How an autonomous turn's phases ended, and what the turn as a whole ends on.
 *
 * A pass, its restart or continuation, and its close-out are separate runs. Each one's ending is
 * recorded here as it settles, so the turn's final `turn-end` and the reason the pull request is
 * told are derived from every phase rather than from whichever variable the last one overwrote.
 */
import type { PrReviewFailureReason } from "@maple/domain/http"
import { Array as Arr, Option } from "effect"
import type { TurnEnding } from "./ChatSession"

/** Which run of the turn a phase was. A restart starts the pass over, so it resets the failure. */
export type PhaseKind = "pass" | "restart" | "continue" | "close-out" | "verdict"

export interface PhaseOutcome {
	readonly kind: PhaseKind
	readonly submitted: boolean
	/** The reason the run's own `turn-end` gave, held back while the turn decides what comes next. */
	readonly ending: TurnEnding["reason"] | undefined
	/** Why the phase did not end in a report, when that is known. */
	readonly failure: PrReviewFailureReason | undefined
}

/** A phase's own failure: one it raised, or a pass (not a close-out) that ran out of steps. */
const phaseFailure = (
	kind: PhaseKind,
	submitted: boolean,
	ending: TurnEnding["reason"] | undefined,
	raised: PrReviewFailureReason | undefined,
): PrReviewFailureReason | undefined =>
	raised ?? (!submitted && kind !== "close-out" && ending === "max-steps" ? "step_limit" : undefined)

export const makeAutonomousOutcome = () => {
	const phases: Array<PhaseOutcome> = []
	let held: TurnEnding["reason"] | undefined

	/** The phases since the latest restart: a restart discards the attempt it replaced. */
	const current = (): ReadonlyArray<PhaseOutcome> => {
		const restart = Arr.findLastIndex(phases, (phase) => phase.kind === "restart")
		return Option.match(restart, { onNone: () => phases, onSome: (index) => phases.slice(index) })
	}

	return {
		/** The running phase's `turn-end`, held rather than written. */
		hold: (reason: TurnEnding["reason"]): void => {
			held = reason
		},
		/** Settle the running phase. `raised` is the failure it fell over with, if it did. */
		record: (kind: PhaseKind, submitted: boolean, raised?: PrReviewFailureReason): PhaseOutcome => {
			const phase: PhaseOutcome = {
				kind,
				submitted,
				ending: held,
				failure: phaseFailure(kind, submitted, held, raised),
			}
			held = undefined
			phases.push(phase)
			return phase
		},
		/** A failure decided between phases rather than by one, such as a pass that answered in prose. */
		fail: (failure: PrReviewFailureReason): void => {
			phases.push({ kind: "verdict", submitted: false, ending: undefined, failure })
		},
		/** The first reason the current attempt stopped short, which is the one the pull request is told. */
		failure: (): PrReviewFailureReason | undefined =>
			Option.getOrUndefined(Arr.findFirst(current(), (phase) => Option.fromUndefinedOr(phase.failure))),
		submitted: (): boolean => Arr.some(phases, (phase) => phase.submitted),
		/** The turn's `turn-end`: a report that landed after any phase hit the step limit says so. */
		ending: (unsubmitted: string): TurnEnding =>
			Arr.some(phases, (phase) => phase.submitted)
				? { reason: Arr.some(phases, (phase) => phase.ending === "max-steps") ? "max-steps" : "stop" }
				: { reason: "error", error: unsubmitted },
	}
}

export type AutonomousOutcome = ReturnType<typeof makeAutonomousOutcome>
