/**
 * Consecutive streamed deltas of one part, joined before the engine sees them.
 *
 * effect-agent counts every delta as a run event (65,536 per run) and a response part (16,384 per
 * call), and neither ceiling can be raised. A model that streams a delta per token spends them on
 * reasoning: a 126-call review died on the event ceiling (2026-09-25). Joined deltas keep the text
 * and cost nothing but live streaming, so only unattended runs use this.
 */
import { Stream } from "effect"
import type { Response } from "effect/unstable/ai"

/** The most a joined delta holds, so one never grows past a response's byte bound in one piece. */
export const COALESCED_DELTA_CHARS = 4_000

type DeltaPart = Response.TextDeltaPart | Response.ReasoningDeltaPart | Response.ToolParamsDeltaPart

const isDelta = <A extends { readonly type: string }>(part: A): part is A & DeltaPart =>
	part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-params-delta"

/** A later delta's metadata is dropped: the first carries the part's, and providers put theirs on the end part. */
export const coalesceDeltas = <A extends { readonly type: string }, E, R>(
	stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
	stream.pipe(
		Stream.mapAccum(
			(): (A & DeltaPart) | undefined => undefined,
			(pending, part): readonly [(A & DeltaPart) | undefined, ReadonlyArray<A>] => {
				if (!isDelta(part)) return [undefined, pending === undefined ? [part] : [pending, part]]
				if (
					pending !== undefined &&
					pending.type === part.type &&
					pending.id === part.id &&
					pending.delta.length + part.delta.length <= COALESCED_DELTA_CHARS
				) {
					return [{ ...pending, delta: pending.delta + part.delta }, []]
				}
				return [part, pending === undefined ? [] : [pending]]
			},
			{ onHalt: (pending) => (pending === undefined ? [] : [pending]) },
		),
	)
