import type { RetentionSignal } from "@maple/domain/retention"
import { Effect } from "effect"
import { RetentionService } from "@maple/backend/services/retention/RetentionService"
import { CurrentMcpTenant } from "../tenant"

/**
 * How many days back a read of `signal` reaches for the calling org: the longest any of its
 * sources keeps it. Served from the retention service's cache, and the defaults when the
 * policy cannot be read, so it never fails a tool.
 */
export const readHorizonDays = Effect.fnUntraced(function* (signal: RetentionSignal) {
	const tenant = yield* CurrentMcpTenant
	const retention = yield* RetentionService
	const horizon = yield* retention.readHorizon(tenant.orgId)
	const days = horizon.days[signal]
	yield* Effect.annotateCurrentSpan(`maple.retention.read_horizon_days.${signal}`, days)
	return days
})
