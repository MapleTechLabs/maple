/**
 * The phases of an unattended pass: the pass, a restart or continuation when its agent has one,
 * and a close-out when nothing filed. Shared by the Durable Object's turn and the local review
 * runner, so a local run takes the same path a production one does.
 *
 * Still one agent turn: every phase is a run of the same agent on the same session, and each one
 * is settled into the turn's {@link AutonomousOutcome} rather than ending the turn.
 */
import type { ChatMessage } from "@maple/domain/chat-session"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Cause, Clock, Duration, Effect } from "effect"
import type { AgentCompletion, AgentDefinition } from "./agents"
import type { AutonomousOutcome, PhaseKind } from "./autonomous-outcome"
import { withToolTranscript } from "./close-out"
import { reviewFailureReason } from "./review-failure"
import type { ChatRunOutcome } from "./run"

/** A phase with less than this much of the pass's clock left is not started. */
const MIN_CONTINUE_MS = 2 * 60 * 1000

/** One run of the turn. */
export interface PhaseTurn {
	readonly text: string
	readonly history: ReadonlyArray<ChatMessage>
	readonly closeOut?: boolean
	/** A restart's or continuation's agent: the session's, with only what is left of the pass's clock. */
	readonly agent?: AgentDefinition
}

export interface AutonomousPhasesInput<E, R> {
	readonly agent: AgentDefinition
	readonly completion: AgentCompletion
	/** The kickoff the pass answers, and the conversation before it. */
	readonly text: string
	readonly prior: ReadonlyArray<ChatMessage>
	readonly outcome: AutonomousOutcome
	readonly holdsTurn: () => boolean
	/** The transcript so far, which a continuation or close-out replays. */
	readonly transcript: () => ReadonlyArray<ChatMessage>
	/** One run of the turn; its `turn-end` must be held in `outcome`, not written. */
	readonly run: (turn: PhaseTurn) => Effect.Effect<ChatRunOutcome, E, R>
	/** The turn runs on the org's own key, which decides how a provider failure reads. */
	readonly ownKey: boolean
	readonly onCompactions?: (compactions: number) => void
	/** Context for the log line a failed phase writes. */
	readonly logAnnotations?: Readonly<Record<string, string>>
}

export const runAutonomousPhases = <E, R>(input: AutonomousPhasesInput<E, R>): Effect.Effect<void, E, R> => {
	const { agent, completion, outcome, holdsTurn, text } = input

	/**
	 * One phase, settled into `outcome`. A pass that failed is a pass with no report yet, not a
	 * dead turn: the close-out still gets its say. Interrupts stay interrupts.
	 */
	const phase = (kind: PhaseKind, turn: PhaseTurn) =>
		input.run(turn).pipe(
			Effect.map((result) => ({ result, raised: undefined })),
			Effect.catchCauseIf(
				(cause) => !Cause.hasInterruptsOnly(cause),
				(cause) =>
					Effect.logWarning("Autonomous pass failed; closing it out").pipe(
						Effect.annotateLogs({ ...input.logAnnotations, cause: summarizeCause(cause) }),
						Effect.as({
							result: { submitted: false, compactions: 0 },
							raised: reviewFailureReason(cause, { ownKey: input.ownKey }),
						}),
					),
			),
			Effect.map(({ result, raised }) => {
				input.onCompactions?.(result.compactions)
				return outcome.record(kind, result.submitted, raised)
			}),
		)

	return Effect.gen(function* () {
		const passDeadline =
			(yield* Clock.currentTimeMillis) +
			Duration.toMillis(Duration.fromInputUnsafe(agent.budget.maxDuration))
		/** What is left of the pass's clock, or `undefined` when too little is left to start a phase. */
		const remainingAgent = Effect.map(Clock.currentTimeMillis, (now): AgentDefinition | undefined => {
			const remaining = passDeadline - now
			return remaining < MIN_CONTINUE_MS
				? undefined
				: { ...agent, budget: { ...agent.budget, maxDuration: Duration.millis(remaining) } }
		})
		yield* phase("pass", { text, history: input.prior })
		const continuePrompt = completion.continuePrompt
		// A pass stopped for failing tool calls is usually a bad start, not an impossible task: it
		// starts over once from the kickoff, inside the same wall clock, without the failed calls.
		if (
			continuePrompt !== undefined &&
			!outcome.submitted() &&
			outcome.failure() === "stuck" &&
			holdsTurn()
		) {
			const remaining = yield* remainingAgent
			if (remaining !== undefined) {
				const restarted = yield* phase("restart", { text, history: input.prior, agent: remaining })
				yield* Effect.annotateCurrentSpan("maple.pr_review.restarted", restarted.submitted)
			}
		}
		// A pass that answered in prose with no limit hit was not stopped, it stopped itself. With
		// time left it gets one more pass that may still read, inside the same wall clock.
		if (
			continuePrompt !== undefined &&
			!outcome.submitted() &&
			outcome.failure() === undefined &&
			holdsTurn()
		) {
			const remaining = yield* remainingAgent
			if (remaining !== undefined) {
				const continued = yield* phase("continue", {
					// The replayed history keeps only its newest part, which can drop the kickoff.
					text: `${continuePrompt}\n\n${text}`,
					history: withToolTranscript(input.transcript()),
					agent: remaining,
				})
				yield* Effect.annotateCurrentSpan("maple.pr_review.continued", continued.submitted)
			}
			if (!outcome.submitted() && outcome.failure() === undefined) outcome.fail("answered_in_prose")
		}
		if (!outcome.submitted() && holdsTurn()) {
			const closeOut = yield* phase("close-out", {
				text: completion.closeOutPrompt,
				history: withToolTranscript(input.transcript()),
				closeOut: true,
			})
			yield* Effect.annotateCurrentSpan(completion.closedOutAttribute, closeOut.submitted)
		}
	})
}
