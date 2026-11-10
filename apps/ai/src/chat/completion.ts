/**
 * The tool a run answers through, as the run sees it: whoever starts the turn picks the completion
 * for its session's row, and the run builds it with what only the run knows.
 */
import type { Layer } from "effect"
import type { Toolkit } from "effect/ai"
import type { ReviewTurnState } from "./tools"
import type { RunUsage } from "./tools"

export const SUBMIT_DIAGNOSIS = "submit_diagnosis"
export const SUBMIT_REVIEW = "submit_review"
export const SUBMIT_REPLY = "submit_reply"

/** What the run hands a completion as it builds it. */
export interface CompletionRun {
	/** The turn's message id: a later turn's diagnosis supersedes this one's. */
	readonly turnId: string
	/** Accumulated across the run; a submission reports the running total. */
	readonly usage: RunUsage
	readonly modelName: string
	/** This run is an autonomous pass's close-out: whatever it files is a partial. */
	readonly partial: boolean
	/** The run's agent-session identity, stamped on the tool span like every other tool's. */
	readonly sessionAttributes: Readonly<Record<string, string>>
}

/**
 * The completion tool and its handlers. `submitted` is read by the turn runner after the run: a
 * completion whose tool never landed is a pass the runner closes out itself, because the engine is
 * never told the tool is required.
 */
export interface RunCompletion {
	readonly tool: string
	readonly toolkit: Toolkit.Any
	readonly layer: Layer.Layer<never>
	/** The raw handlers, which tests drive directly. */
	readonly handlers: unknown
	readonly submitted: () => boolean
	/** A review's turn state: the run's Maple tools feed its coverage, its children its findings. */
	readonly review?: ReviewTurnState
}

export type MakeCompletion = (run: CompletionRun) => RunCompletion
