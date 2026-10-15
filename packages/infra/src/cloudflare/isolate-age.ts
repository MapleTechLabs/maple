import { Clock, Context, Effect, Layer, Option, Ref } from "effect"

interface Served {
	readonly firstAt: Option.Option<number>
	readonly count: number
}

export interface IsolateStamp {
	readonly ageMs: number
	readonly ordinal: number
}

/**
 * Headers a Worker reached over a service binding answers with, so the caller can tell a cold
 * callee apart. The callee's own span cannot: workerd's clock stands still during startup CPU.
 */
export const ISOLATE_ORDINAL_HEADER = "x-maple-isolate-ordinal"
export const ISOLATE_AGE_HEADER = "x-maple-isolate-age-ms"

export const isolateStampHeaders = ({ ageMs, ordinal }: IsolateStamp): Record<string, string> => ({
	[ISOLATE_ORDINAL_HEADER]: String(ordinal),
	[ISOLATE_AGE_HEADER]: String(ageMs),
})

/** Counts one request at `now`; the first one counted fixes the isolate's start. */
const serve =
	(now: number) =>
	({ firstAt, count }: Served): readonly [IsolateStamp, Served] => {
		const first = Option.getOrElse(firstAt, () => now)
		return [
			{ ageMs: now - first, ordinal: count + 1 },
			{ firstAt: Option.some(first), count: count + 1 },
		]
	}

export interface IsolateAgeApi {
	/** Stamps the current span with the isolate's age and this request's ordinal, and returns both. */
	readonly record: Effect.Effect<IsolateStamp>
}

/**
 * How old the isolate is when a request reaches it. Built once per isolate by the Worker's init:
 * ordinal 1 is the isolate's first counted request, and its age is measured from that request.
 * `Ref.modify` counts and ages in one synchronous step, so no request waits on another's fiber.
 */
export class IsolateAge extends Context.Service<IsolateAge, IsolateAgeApi>()("@maple/infra/IsolateAge", {
	make: Effect.gen(function* () {
		const served = yield* Ref.make<Served>({ firstAt: Option.none(), count: 0 })
		const record = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const stamp = yield* Ref.modify(served, serve(now))
			yield* Effect.annotateCurrentSpan({
				"maple.isolate.age_ms": stamp.ageMs,
				"maple.isolate.request_ordinal": stamp.ordinal,
			})
			return stamp
		})
		return { record } satisfies IsolateAgeApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
