import { Schema } from "effect"
import {
	OrgId,
	StatusPageAutoIncidents,
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	StatusPageIncidentUpdateId,
	StatusPageUpdateSource,
	UptimeMonitorId,
	UserId,
} from "../primitives"
import { StatusPageTheme } from "../status-page"
import { HttpTaggedError } from "./error-policy"

export class StatusPageNotFoundError extends HttpTaggedError<StatusPageNotFoundError>()(
	"@maple/http/errors/StatusPageNotFoundError",
	{
		pageId: StatusPageId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "status_page_not_found",
		title: "Status page not found",
		message: "No such status page.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class StatusPageComponentNotFoundError extends HttpTaggedError<StatusPageComponentNotFoundError>()(
	"@maple/http/errors/StatusPageComponentNotFoundError",
	{
		componentId: StatusPageComponentId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "status_page_component_not_found",
		title: "Status page component not found",
		message: "No such status page component.",
		param: "componentId",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class StatusPageIncidentNotFoundError extends HttpTaggedError<StatusPageIncidentNotFoundError>()(
	"@maple/http/errors/StatusPageIncidentNotFoundError",
	{
		incidentId: StatusPageIncidentId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "status_page_incident_not_found",
		title: "Status page incident not found",
		message: "No such status page incident.",
		param: "incidentId",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class StatusPageValidationError extends HttpTaggedError<StatusPageValidationError>()(
	"@maple/http/errors/StatusPageValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "status_page_invalid",
		title: "Invalid status page",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** Slugs are global: the hosted address is `<slug>.<status domain>`. */
export class StatusPageSlugTakenError extends HttpTaggedError<StatusPageSlugTakenError>()(
	"@maple/http/errors/StatusPageSlugTakenError",
	{
		slug: Schema.String,
		message: Schema.String,
	},
	{
		status: 409,
		code: "status_page_slug_taken",
		title: "Status page address is taken",
		param: "slug",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** A conditional write whose `if_version` no longer matches the page's config. */
export class StatusPageConflictError extends HttpTaggedError<StatusPageConflictError>()(
	"@maple/http/errors/StatusPageConflictError",
	{
		pageId: StatusPageId,
		/** The config's current version, for a caller that wants to compare. */
		version: Schema.String,
		message: Schema.String,
	},
	{
		status: 409,
		code: "status_page_conflict",
		title: "Status page changed",
		param: "if_version",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class StatusPagePersistenceError extends HttpTaggedError<StatusPagePersistenceError>()(
	"@maple/http/errors/StatusPagePersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 503,
		code: "status_pages_unavailable",
		title: "Status pages are temporarily unavailable",
		message: "Status pages are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** A page as its owners see it; the break-glass hash never leaves the service. */
export const StatusPageRecord = Schema.Struct({
	id: StatusPageId,
	orgId: OrgId,
	name: Schema.String,
	slug: Schema.String,
	description: Schema.NullOr(Schema.String),
	websiteUrl: Schema.NullOr(Schema.String),
	logoUrl: Schema.NullOr(Schema.String),
	privacyUrl: Schema.NullOr(Schema.String),
	termsUrl: Schema.NullOr(Schema.String),
	theme: StatusPageTheme,
	showPoweredBy: Schema.Boolean,
	autoIncidents: StatusPageAutoIncidents,
	breakGlassTokenSuffix: Schema.NullOr(Schema.String),
	/** Not public until published; the publisher skips a draft. */
	draft: Schema.Boolean,
	revision: Schema.Number,
	publishedRevision: Schema.Number,
	publishedAt: Schema.NullOr(Schema.Number),
	lastPublishError: Schema.NullOr(Schema.String),
	createdBy: UserId,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type StatusPageRecord = Schema.Schema.Type<typeof StatusPageRecord>

export const StatusPageComponentRecord = Schema.Struct({
	id: StatusPageComponentId,
	pageId: StatusPageId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	groupName: Schema.NullOr(Schema.String),
	position: Schema.Number,
	monitorId: Schema.NullOr(UptimeMonitorId),
	manualStatus: Schema.NullOr(StatusPageComponentStatus),
	showUptime: Schema.Boolean,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type StatusPageComponentRecord = Schema.Schema.Type<typeof StatusPageComponentRecord>

export const StatusPageIncidentUpdateRecord = Schema.Struct({
	id: StatusPageIncidentUpdateId,
	status: StatusPageIncidentStatus,
	body: Schema.String,
	source: StatusPageUpdateSource,
	createdBy: Schema.NullOr(UserId),
	createdAt: Schema.Number,
})
export type StatusPageIncidentUpdateRecord = Schema.Schema.Type<typeof StatusPageIncidentUpdateRecord>

export const StatusPageIncidentRecord = Schema.Struct({
	id: StatusPageIncidentId,
	pageId: StatusPageId,
	kind: StatusPageIncidentKind,
	title: Schema.String,
	impact: StatusPageIncidentImpact,
	status: StatusPageIncidentStatus,
	published: Schema.Boolean,
	scheduledStart: Schema.NullOr(Schema.Number),
	scheduledEnd: Schema.NullOr(Schema.Number),
	startedAt: Schema.Number,
	resolvedAt: Schema.NullOr(Schema.Number),
	componentIds: Schema.Array(StatusPageComponentId),
	/** Newest first. */
	updates: Schema.Array(StatusPageIncidentUpdateRecord),
	createdBy: Schema.NullOr(UserId),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type StatusPageIncidentRecord = Schema.Schema.Type<typeof StatusPageIncidentRecord>
