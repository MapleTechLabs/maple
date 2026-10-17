import { Duration, Effect, Option, Schema } from "effect"
import type { FaultFailure, Faults } from "../contract.ts"

/** `Faults` as the capture side sends them in `FAULTS_HEADER`. */
const FaultsFromJson = Schema.fromJsonString(
	Schema.Struct({
		delays: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
		failures: Schema.optionalKey(
			Schema.Record(
				Schema.String,
				Schema.Struct({ status: Schema.Number, body: Schema.Record(Schema.String, Schema.Json) }),
			),
		),
	}),
)
const decodeFaults = Schema.decodeUnknownOption(FaultsFromJson)

/** The dataset's faults with a scenario's header faults over them, per prefix; `None` = bad header. */
export const mergeFaults = (dataset: Faults | undefined, header: string | undefined): Option.Option<Faults> =>
	Option.map(header === undefined ? Option.some({}) : decodeFaults(header), (scenario: Faults) => ({
		delays: { ...dataset?.delays, ...scenario.delays },
		failures: { ...dataset?.failures, ...scenario.failures },
	}))

const longestPrefix = <A>(table: Readonly<Record<string, A>> | undefined, tag: string): A | undefined => {
	const entries = Object.entries(table ?? {}).filter(([prefix]) => tag.startsWith(prefix))
	const [best] = entries.sort(([a], [b]) => b.length - a.length)
	return best?.[1]
}

export interface ResolvedFault {
	readonly delayMs: number
	readonly failure: FaultFailure | undefined
}

export const resolveFault = (faults: Faults, tag: string): ResolvedFault => ({
	delayMs: longestPrefix(faults.delays, tag) ?? 0,
	failure: longestPrefix(faults.failures, tag),
})

/** Counts the requests each capture has on hold, so a capture can tell "loading" from "still busy". */
export const makeHolds = () => {
	const counts = new Map<string, number>()
	const shift = (captureId: string, delta: number) =>
		Effect.sync(() => counts.set(captureId, (counts.get(captureId) ?? 0) + delta))
	return {
		held: (captureId: string) => counts.get(captureId) ?? 0,
		/** Sleeps `ms`; counted while asleep, including when the browser aborts the request. */
		hold: (captureId: string | null, ms: number) =>
			captureId === null
				? Effect.sleep(Duration.millis(ms))
				: Effect.acquireUseRelease(
						shift(captureId, 1),
						() => Effect.sleep(Duration.millis(ms)),
						() => shift(captureId, -1),
					),
	}
}

export type Holds = ReturnType<typeof makeHolds>
