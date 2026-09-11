import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"

/**
 * The signal kinds Maple distinguishes when telling a user what they have and have not wired up.
 * Stable strings — the web app keys its empty-state copy and SDK snippets on them.
 */
export const V2TelemetrySignalKind = Schema.Literals([
	"traces",
	"logs",
	"metrics",
	"sessions",
	"product_events",
])
export type V2TelemetrySignalKind = Schema.Schema.Type<typeof V2TelemetrySignalKind>

export const V2TelemetrySignal = Schema.Struct({
	object: Schema.Literal("telemetry_signal").annotate({
		description: 'The object type — always `"telemetry_signal"`.',
		examples: ["telemetry_signal"],
	}),
	signal: V2TelemetrySignalKind.annotate({
		description: "Which signal this entry describes.",
		examples: ["logs"],
	}),
	status: Schema.Literals(["present", "absent", "unknown"]).annotate({
		description:
			"`present` when the signal arrived within the window, `absent` when it did not, and `unknown` when the warehouse could not be read. Treat `unknown` as 'do not advise' — it is not evidence of absence.",
		examples: ["present"],
	}),
	count: Schema.NullOr(Schema.Number).annotate({
		description:
			"Events seen in the window, or `null` when `status` is `unknown`. An estimate for rolled-up signals, exact for sessions and product events.",
		examples: [1842],
	}),
	first_seen: Schema.NullOr(Timestamp).annotate({
		description:
			"When the signal first arrived inside the window — not the all-time first, which may predate it. `null` unless `status` is `present`.",
	}),
	last_seen: Schema.NullOr(Timestamp).annotate({
		description:
			"When the signal most recently arrived. `null` unless `status` is `present`. Hourly precision for traces, logs and metrics, which are read from an hourly rollup.",
	}),
}).annotate({
	identifier: "TelemetrySignal",
	title: "Telemetry signal",
	description: "Whether one kind of telemetry is reaching Maple, and when it last did.",
})
export type V2TelemetrySignal = Schema.Schema.Type<typeof V2TelemetrySignal>

export const V2TelemetrySignals = Schema.Struct({
	object: Schema.Literal("telemetry_signals").annotate({
		description: 'The object type — always `"telemetry_signals"`.',
		examples: ["telemetry_signals"],
	}),
	generated_at: Timestamp.annotate({
		description: "When presence was computed. Never cached as an object.",
	}),
	window_start: Timestamp.annotate({
		description:
			"Start of the window presence was evaluated over. A signal last sent before this reads as `absent`, so treat absence as 'not sending now', not 'never sent'.",
	}),
	window_end: Timestamp.annotate({ description: "End of the evaluated window." }),
	warehouse_available: Schema.Boolean.annotate({
		description:
			"Whether the warehouse could be read. When `false` every signal reports `unknown` and the response is still a 200 — callers use this to decide whether to show telemetry-dependent guidance at all.",
		examples: [true],
	}),
	signals: Schema.Array(V2TelemetrySignal).annotate({
		description:
			'One entry per signal kind, always the full set. A signal never drops out of this array — absence is reported as `status: "absent"`, so a missing entry is a bug rather than a no-data answer.',
	}),
}).annotate({
	identifier: "TelemetrySignals",
	title: "Telemetry signals",
	description:
		"What kinds of telemetry the organization is actually sending. Answers 'is this page empty because nothing is wired up, or because nothing happened?' — the question every empty view in Maple has to resolve before it can give useful advice.",
	examples: [
		wireExample({
			object: "telemetry_signals",
			generated_at: "2026-07-27T12:00:00.000Z",
			window_start: "2026-06-27T12:00:00.000Z",
			window_end: "2026-07-27T12:00:00.000Z",
			warehouse_available: true,
			signals: [
				{
					object: "telemetry_signal",
					signal: "traces",
					status: "present",
					count: 1842013,
					first_seen: "2026-06-27T12:00:00.000Z",
					last_seen: "2026-07-27T11:00:00.000Z",
				},
				{
					object: "telemetry_signal",
					signal: "logs",
					status: "absent",
					count: 0,
					first_seen: null,
					last_seen: null,
				},
			],
		}),
	],
})
export type V2TelemetrySignals = Schema.Schema.Type<typeof V2TelemetrySignals>

export class V2TelemetrySignalsApiGroup extends HttpApiGroup.make("telemetrySignals")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2TelemetrySignals,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getTelemetrySignals",
				summary: "Retrieve telemetry signal presence",
				description:
					"Reports which kinds of telemetry the organization is sending and when each last arrived, over a trailing window. " +
					"Deliberately cheap: traces, logs and metrics are read from an hourly usage rollup rather than the raw signal tables. " +
					"A warehouse outage returns `200` with every signal `unknown` rather than an error, so a caller that renders guidance from this can always render something. Requires the `instrumentation:read` scope.",
			}),
		),
	)
	.prefix("/v2/instrumentation/signals")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Telemetry Signals",
			description:
				"Which signals are reaching Maple. The input every empty state needs to tell 'nothing is wired up' apart from 'nothing happened'.",
		}),
	) {}
