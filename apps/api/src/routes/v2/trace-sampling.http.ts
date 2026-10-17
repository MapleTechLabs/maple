import { HttpApiBuilder } from "effect/http-api"
import type { TraceSamplingPolicyDocument } from "@maple/domain/http"
import { CurrentTenant, TraceSamplingPolicyUpdateRequest } from "@maple/domain/http"
import { MapleApiV2, V2InsufficientPermissions } from "@maple/domain/http/v2"
import type { V2TraceSamplingPolicy } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { TraceSamplingPolicyService } from "@maple/backend/services/org/TraceSamplingPolicyService"
import { diffAuditChanges, pickPresentFields } from "@/routes/v2/audit-changes"

const policyAuditKeys = [
	"trace_sample_ratio",
	"always_keep_error_spans",
	"always_keep_slow_spans_ms",
] as const

const toV2Policy = (doc: TraceSamplingPolicyDocument): V2TraceSamplingPolicy => ({
	object: "trace_sampling_policy",
	trace_sample_ratio: doc.traceSampleRatio,
	always_keep_error_spans: doc.alwaysKeepErrorSpans,
	always_keep_slow_spans_ms: doc.alwaysKeepSlowSpansMs,
	updated_at: doc.updatedAt,
})

export const HttpV2TraceSamplingLive = HttpApiBuilder.group(MapleApiV2, "traceSampling", (handlers) =>
	Effect.gen(function* () {
		const sampling = yield* TraceSamplingPolicyService

		return handlers
			.handle("retrieve", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return toV2Policy(yield* sampling.get(tenant.orgId))
				}),
			)
			.handle("update", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireAdmin(tenant.roles, () =>
						V2InsufficientPermissions.make("Only org admins can change trace sampling"),
					)
					const { before, after } = yield* sampling.update(
						tenant.orgId,
						new TraceSamplingPolicyUpdateRequest({
							...(payload.trace_sample_ratio !== undefined
								? { traceSampleRatio: payload.trace_sample_ratio }
								: undefined),
							...(payload.always_keep_error_spans !== undefined
								? { alwaysKeepErrorSpans: payload.always_keep_error_spans }
								: undefined),
							...(payload.always_keep_slow_spans_ms !== undefined
								? { alwaysKeepSlowSpansMs: payload.always_keep_slow_spans_ms }
								: undefined),
						}),
					)

					const changes = diffAuditChanges(
						pickPresentFields(policyAuditKeys, payload, toV2Policy(before)),
						pickPresentFields(policyAuditKeys, payload, toV2Policy(after)),
					)
					if (changes !== undefined) {
						yield* recordHttpAudit("trace_sampling.updated", { changes })
					}

					return toV2Policy(after)
				}),
			)
	}),
)
