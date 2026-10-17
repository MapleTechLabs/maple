import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../data/keyed"
import { ServicesFacets } from "../../data/queries/services-facets"
import { TimeWindow } from "../../data/time-range"
import { WarehouseFailure } from "../../data/warehouse-error"

// MODEL

export const Session = Schema.Literals(["Checking", "SignedIn", "SignedOut", "Unreachable"])
export type Session = typeof Session.Type

/** How the window was asked for: `Load` on entry, `Refresh` from the button (no cache snap). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])

/**
 * S6 data probe: one warehouse query through the batcher (`/services`' facets) and one Electric
 * collection through a liveQuery Subscription (alert rules), rendered as counts.
 */
export const Model = Schema.Struct({
	session: Session,
	orgId: Schema.NullOr(OrgId),
	facets: KeyedSchema(ServicesFacets, WarehouseFailure),
	alertRuleCount: Schema.NullOr(Schema.Number),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
	SucceededCheckProbeSession: { orgId: OrgId },
	FailedCheckProbeSession: { session: Session },
	CompletedResolveWindow: { window: TimeWindow, mode: RequestMode },
	CompletedFetchServicesFacets: {
		key: Schema.String,
		result: Schema.Result(ServicesFacets, WarehouseFailure),
	},
	UpdatedAlertRules: { orgId: OrgId, count: Schema.Number },
	ClickedRefresh: {},
})
export type Message = typeof Message.Type
