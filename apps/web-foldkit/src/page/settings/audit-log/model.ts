import { AuditActorType, AuditOutcome } from "@maple/domain/http"
import { V2AuditLogEntry } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Popover from "../../../ui/popover"
import * as Select from "../../../ui/select"

// `AuditLogSection` (apps/web/src/components/settings/audit-log-section.tsx). Filters live in the
// `/settings` search; the page passes them in and a change comes back as a navigation.

/** One `auditLog.list` request, as `auditLogPageAtom` keys it. */
export const PageRequest = Schema.Struct({
	cursor: Schema.optional(Schema.String),
	actorType: Schema.optional(AuditActorType),
	actorId: Schema.optional(Schema.String),
	outcome: Schema.optional(AuditOutcome),
	since: Schema.optional(Schema.String),
	until: Schema.optional(Schema.String),
	/** A rolling preset: part of the key, resolved to `since` when the page is fetched. */
	preset: Schema.optional(Schema.String),
})
export type PageRequest = typeof PageRequest.Type

export const AuditPage = Schema.Struct({
	data: Schema.Array(V2AuditLogEntry),
	has_more: Schema.Boolean,
	next_cursor: Schema.NullOr(Schema.String),
})
export type AuditPage = typeof AuditPage.Type

/** The accumulated list (`AuditLogView`): kept while the next page or a refresh loads. */
export const ListView = Schema.Struct({
	entries: Schema.Array(V2AuditLogEntry),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(Schema.String),
})

export const Model = Schema.Struct({
	/** The request in flight or last answered; answers for any other are dropped. */
	request: PageRequest,
	/** The filters the list was started for (no cursor, no pinned ceiling). */
	base: PageRequest,
	isWaiting: Schema.Boolean,
	failure: Schema.NullOr(LoadFailure),
	view: Schema.NullOr(ListView),
	/** Frozen on the first Load more so later offsets address a list that cannot grow. */
	pinnedUntil: Schema.NullOr(Schema.String),
	expanded: Schema.Array(Schema.String),
	copies: Schema.Record(Schema.String, CopyButton.Model),
	personSelect: Select.Model,
	dateRange: Popover.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedFetchPage: { request: PageRequest, result: Schema.Result(AuditPage, LoadFailure) },
	ClickedRefresh: {},
	ClickedRetry: {},
	ClickedLoadMore: {},
	ToggledEntry: { id: Schema.String },
	GotCopyMessage: { key: Schema.String, message: CopyButton.Message },
	ClickedActorType: { value: Schema.String },
	ClickedOutcome: { value: Schema.String },
	GotPersonSelectMessage: { message: Select.Message },
	GotDateRangeMessage: { message: Popover.Message },
	ClickedRangePreset: { value: Schema.String },
	ClickedClearFilters: {},
})
export type Message = typeof Message.Type
