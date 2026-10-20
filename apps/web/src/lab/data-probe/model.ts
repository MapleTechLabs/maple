import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Toast from "../../ui/toast"
import { KeyedSchema } from "../../data/keyed"

import { TimeWindow } from "../../data/time-range"
import { WarehouseFailure } from "../../data/warehouse-error"

// MODEL

export const Session = Schema.Literals(["Checking", "SignedIn", "SignedOut", "Unreachable"])
export type Session = typeof Session.Type

/** How the window was asked for: `Load` on entry, `Refresh` from the button (no cache snap). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])

/** `getServicesFacets`' result (`ServicesFacetsResponse["data"]` in `@maple/web-data/warehouse/services`). */
const FacetCount = Schema.Struct({ name: Schema.String, count: Schema.Number })
export const ServicesFacets = Schema.Struct({
	environments: Schema.Array(FacetCount),
	namespaces: Schema.Array(FacetCount),
	commitShas: Schema.Array(FacetCount),
	services: Schema.Array(FacetCount),
})
export type ServicesFacets = typeof ServicesFacets.Type

/**
 * S6 data probe: one warehouse query through the batcher (`/services`' facets) and one Electric
 * collection through a liveQuery Subscription (alert rules), rendered as counts.
 */
export const Model = Schema.Struct({
	session: Session,
	orgId: Schema.NullOr(OrgId),
	facets: KeyedSchema(ServicesFacets, WarehouseFailure),
	alertRuleCount: Schema.NullOr(Schema.Number),
	toasts: Toast.Model,
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
	GotToastMessage: { message: Toast.Message },
})
export type Message = typeof Message.Type
