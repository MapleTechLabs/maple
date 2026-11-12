import { AuditTrailListResponse } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SecurityAuditLogSearch } from "../../../route/search"
import { laterPagesFields } from "../../kit/infinite-pages"
import { SessionGrants } from "../../kit/session-grants"

// `/security/audit-log`: audit events from every connected platform and Maple itself, newest
// first. The filters live in the URL; only org admins (`audit_log:read`) read the list.

export type Search = SecurityAuditLogSearch

/** One page of events and the cursor of the next. */
export const EventsPage = AuditTrailListResponse
export type EventsPage = typeof EventsPage.Type

/** The pages after the first, for the current first-page key. */
export const LaterPages = Schema.Struct({
	key: Schema.NullOr(Schema.String),
	...laterPagesFields(EventsPage),
})
export type LaterPages = typeof LaterPages.Type

/** The filters a select sets; the actor is typed and applied on Enter. */
export const SelectFilter = Schema.Literals(["provider", "category", "outcome"])
export type SelectFilter = typeof SelectFilter.Type

export const Model = Schema.Struct({
	search: SecurityAuditLogSearch,
	nowMs: Schema.Finite,
	grants: Schema.Array(Policy.PermissionName),
	/** False until the session answers: the page says nothing about access before it knows. */
	isGrantsRead: Schema.Boolean,
	firstPage: KeyedSchema(EventsPage, LoadFailure),
	laterPages: LaterPages,
	/** The events whose detail is open, by id. */
	expanded: Schema.Array(Schema.String),
	/** The actor field as typed; the URL holds what was applied. */
	actorText: Schema.String,
})
export type Model = typeof Model.Type

export const canRead = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "audit_log:read")

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedReadGrants: SessionGrants,
	CompletedFetchFirstPage: { key: Schema.String, result: Schema.Result(EventsPage, LoadFailure) },
	CompletedFetchNextPage: {
		key: Schema.String,
		generation: Schema.Number,
		result: Schema.Result(EventsPage, LoadFailure),
	},
	ClickedRetry: {},
	ClickedLoadMore: {},
	ChangedFilter: { filter: SelectFilter, value: Schema.String },
	ChangedActorText: { value: Schema.String },
	SubmittedActor: {},
	ClearedActor: {},
	ClickedClearFilters: {},
	ToggledEvent: { id: Schema.String },
})
export type Message = typeof Message.Type
