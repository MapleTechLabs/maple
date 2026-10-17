import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { AlwaysKeepSlowSpansMs, TraceSampleRatio, TraceSamplingPersistenceError } from "../trace-sampling"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"

const ratioField = TraceSampleRatio.annotate({
	description:
		"Fraction of traces kept, from `0.000001` to `1`. The decision hashes the trace ID, so every span of a kept trace is kept. `1` keeps everything.",
	examples: [0.25],
})

const errorSpansField = Schema.Boolean.annotate({
	description: "Keep every span whose status is `Error`, whatever the ratio.",
	examples: [true],
})

const slowSpansField = Schema.NullOr(AlwaysKeepSlowSpansMs).annotate({
	description:
		"Keep every span lasting at least this many milliseconds, whatever the ratio. `null` turns it off.",
	examples: [2000],
})

// A per-organization singleton, so there is no `id` and no list envelope.
export const V2TraceSamplingPolicy = Schema.Struct({
	object: Schema.Literal("trace_sampling_policy").annotate({
		description: 'The object type, always `"trace_sampling_policy"`.',
		examples: ["trace_sampling_policy"],
	}),
	trace_sample_ratio: ratioField,
	always_keep_error_spans: errorSpansField,
	always_keep_slow_spans_ms: slowSpansField,
	updated_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When the policy was last changed, or `null` while the organization runs on the defaults.",
	}),
}).annotate({
	identifier: "TraceSamplingPolicy",
	title: "Trace sampling policy",
	description:
		"How the ingest gateway samples your organization's traces. Kept spans carry a `SampleRate` attribute so counts can be scaled back up. Changes reach the gateway within about 30 seconds.",
	examples: [
		wireExample({
			object: "trace_sampling_policy",
			trace_sample_ratio: 0.25,
			always_keep_error_spans: true,
			always_keep_slow_spans_ms: 2000,
			updated_at: "2026-07-15T09:12:00.000Z",
		}),
	],
})
export type V2TraceSamplingPolicy = Schema.Schema.Type<typeof V2TraceSamplingPolicy>

export const V2TraceSamplingPolicyUpdateParams = Schema.Struct({
	trace_sample_ratio: Schema.optionalKey(ratioField),
	always_keep_error_spans: Schema.optionalKey(errorSpansField),
	always_keep_slow_spans_ms: Schema.optionalKey(slowSpansField),
}).annotate({
	identifier: "TraceSamplingPolicyUpdateParams",
	title: "Trace sampling policy update parameters",
	description: "Request body for updating the trace sampling policy. Omitted fields are left unchanged.",
	examples: [wireExample({ trace_sample_ratio: 0.1, always_keep_slow_spans_ms: null })],
})
export type V2TraceSamplingPolicyUpdateParams = Schema.Schema.Type<typeof V2TraceSamplingPolicyUpdateParams>

const [traceSamplingPersistence] = publicErrors(TraceSamplingPersistenceError)

export class V2TraceSamplingApiGroup extends HttpApiGroup.make("traceSampling")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2TraceSamplingPolicy,
			error: traceSamplingPersistence,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getTraceSamplingPolicy",
				summary: "Retrieve the trace sampling policy",
				description:
					"Returns your organization's trace sampling policy, or the defaults (keep everything) when none is set. Requires the `trace_sampling:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/", {
			payload: V2TraceSamplingPolicyUpdateParams,
			success: V2TraceSamplingPolicy,
			error: [V2InsufficientPermissions.schema, traceSamplingPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateTraceSamplingPolicy",
				summary: "Update the trace sampling policy",
				description:
					"Updates the trace sampling policy; omitted fields are unchanged. The gateway picks up the change within about 30 seconds. Org-admin only. Requires the `trace_sampling:write` scope.",
			}),
		),
	)
	.prefix("/v2/trace_sampling")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Trace Sampling",
			description:
				"The organization's trace sampling policy, applied by the ingest gateway: a keep ratio plus rules that always keep error and slow spans.",
		}),
	) {}
