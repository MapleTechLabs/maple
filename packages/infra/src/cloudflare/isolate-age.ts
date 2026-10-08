import { Clock, Context, Effect, Layer, Option, Ref } from "effect"

interface Served {
	readonly firstAt: Option.Option<number>
	readonly count: number
}

interface Stamp {
	readonly ageMs: number
	readonly ordinal: number
}

/** Counts one request at `now`; the first one counted fixes the isolate's start. */
const serve =
	(now: number) =>
	({ firstAt, count }: Served): readonly [Stamp, Served] => {
		const first = Option.getOrElse(firstAt, () => now)
		return [
			{ ageMs: now - first, ordinal: count + 1 },
			{ firstAt: Option.some(first), count: count + 1 },
		]
	}

export interface IsolateAgeApi {
	/** Stamps the current span with the isolate's age and this request's ordinal. */
	readonly record: Effect.Effect<void>
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
			const { ageMs, ordinal } = yield* Ref.modify(served, serve(now))
			yield* Effect.annotateCurrentSpan({
				"maple.isolate.age_ms": ageMs,
				"maple.isolate.request_ordinal": ordinal,
			})
		})
		return { record } satisfies IsolateAgeApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
