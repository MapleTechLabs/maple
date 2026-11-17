import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { AlertDestinationId, AlertRuleId } from "@maple/primitives"
import { AlertSeverity } from "../alerts"
import { AuditDetectionFilters } from "../audit-trail"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

// The Security hub's audit log: audit events from connected platforms and Maple itself in one
// list. Dashboard only (the session tier refuses API keys) and behind `audit_log:read`.

const PAGE_LIMIT_MAX = 100

/** 2100-01-01: past it a bound is a typo, and far past it the warehouse cannot parse the date. */
const EPOCH_MS_MAX = 4_102_444_800_000

/**
 * One stored event. `provider`, `category`, `actor.type` and `outcome` are plain strings on the
 * wire: the ingest gateway writes rows too and deploys on its own schedule, so a value this
 * build does not know must show as itself and not fail the page.
 */
export const AuditTrailEntry = Schema.Struct({
	id: Schema.String,
	provider: Schema.String,
	account: Schema.NullOr(Schema.String),
	/** The platform's own id for the event. */
	providerEventId: Schema.String,
	/** Epoch ms. `ingestedAt` trails `occurredAt` by the provider's delivery delay. */
	occurredAt: Schema.Finite,
	ingestedAt: Schema.Finite,
	actor: Schema.Struct({
		type: Schema.String,
		id: Schema.NullOr(Schema.String),
		name: Schema.NullOr(Schema.String),
		email: Schema.NullOr(Schema.String),
	}),
	action: Schema.String,
	category: Schema.String,
	outcome: Schema.String,
	/** Why it failed or was refused, in the platform's words. */
	outcomeReason: Schema.NullOr(Schema.String),
	target: Schema.Struct({
		type: Schema.NullOr(Schema.String),
		id: Schema.NullOr(Schema.String),
		name: Schema.NullOr(Schema.String),
	}),
	originIp: Schema.NullOr(Schema.String),
	originCountry: Schema.NullOr(Schema.String),
	userAgent: Schema.NullOr(Schema.String),
	/** The provider's payload, or null when none was kept. */
	raw: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
})
export type AuditTrailEntry = typeof AuditTrailEntry.Type

const EpochMs = Schema.FiniteFromString.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 0, maximum: EPOCH_MS_MAX }),
)

/** `<occurredAt ms>:<event id>` of the last event on the previous page. */
const AuditTrailCursor = Schema.String.check(Schema.isPattern(/^\d{1,13}:[0-9a-f]{32}$/))

const Filter = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const AuditTrailListQuery = Schema.Struct({
	provider: Schema.optional(Filter),
	account: Schema.optional(Filter),
	category: Schema.optional(Filter),
	outcome: Schema.optional(Filter),
	action: Schema.optional(Filter),
	/** An actor's provider id or email. A Maple member's email finds their events too. */
	actor: Schema.optional(Filter),
	since: Schema.optional(EpochMs),
	until: Schema.optional(EpochMs),
	cursor: Schema.optional(AuditTrailCursor),
	limit: Schema.optional(
		Schema.FiniteFromString.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: PAGE_LIMIT_MAX }),
		),
	),
})
export type AuditTrailListQuery = typeof AuditTrailListQuery.Type

/** Newest first. `nextCursor` is null on the last page. */
export const AuditTrailListResponse = Schema.Struct({
	events: Schema.Array(AuditTrailEntry),
	nextCursor: Schema.NullOr(Schema.String),
})
export type AuditTrailListResponse = typeof AuditTrailListResponse.Type

/**
 * Where a platform's audit events stand. `built_in`: Maple's own, always on. `receiving`: events
 * arrived in the window. `waiting`: the feed is on but nothing arrived yet. `off`: the platform is
 * connected with its audit feed switched off. `failing`: the feed reports an error.
 * `not_connected`: the platform is not connected at all.
 */
export const AuditTrailSourceState = Schema.Literals([
	"built_in",
	"receiving",
	"waiting",
	"off",
	"failing",
	"not_connected",
])
export type AuditTrailSourceState = typeof AuditTrailSourceState.Type

/** One platform that can feed the audit log, and what it has sent. */
export const AuditTrailSource = Schema.Struct({
	/** A plain string for the same reason as an entry's: a newer adapter must not fail the page. */
	provider: Schema.String,
	state: AuditTrailSourceState,
	/** The connected account, team or project scope, when the platform is connected. */
	account: Schema.NullOr(Schema.String),
	/** Why a feed is failing, in the integration's words; null otherwise. */
	problem: Schema.NullOr(Schema.String),
	/** Distinct events that happened in the last `windowDays`. */
	events: Schema.Finite,
	/** Epoch ms of the newest event in the window, or null. */
	lastEventAt: Schema.NullOr(Schema.Finite),
})
export type AuditTrailSource = typeof AuditTrailSource.Type

/** Every platform that can feed the audit log, connected or not. */
export const AuditTrailSourcesResponse = Schema.Struct({
	sources: Schema.Array(AuditTrailSource),
	/** How far back `events` and `lastEventAt` look. */
	windowDays: Schema.Finite,
})
export type AuditTrailSourcesResponse = typeof AuditTrailSourcesResponse.Type

// A detection is an alert rule that counts audit events as they arrive. Its incidents and
// notifications carry the count, never an event.

/** Each detection reads the warehouse every minute; the cap bounds that per org. */
export const MAX_AUDIT_DETECTIONS_PER_ORG = 50

const DetectionName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120))
const DetectionWindowMinutes = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 5, maximum: 1440 }),
)
const DetectionThreshold = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: 100_000 }),
)
const DetectionDestinationIds = Schema.Array(AlertDestinationId).check(Schema.isMaxLength(20))

/** Fires when `threshold` or more matching events arrived in the last `windowMinutes`. */
export const AuditDetection = Schema.Struct({
	id: AlertRuleId,
	name: Schema.String,
	enabled: Schema.Boolean,
	filters: AuditDetectionFilters,
	windowMinutes: Schema.Number,
	threshold: Schema.Number,
	severity: AlertSeverity,
	destinationIds: Schema.Array(AlertDestinationId),
	/** Epoch ms. */
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type AuditDetection = typeof AuditDetection.Type

export const AuditDetectionCreateRequest = Schema.Struct({
	name: DetectionName,
	enabled: Schema.optionalKey(Schema.Boolean),
	/** Absent or empty counts every event. */
	filters: Schema.optionalKey(AuditDetectionFilters),
	windowMinutes: DetectionWindowMinutes,
	threshold: DetectionThreshold,
	severity: AlertSeverity,
	destinationIds: Schema.optionalKey(DetectionDestinationIds),
})
export type AuditDetectionCreateRequest = typeof AuditDetectionCreateRequest.Type

/** Only the fields sent change. `filters` replaces the stored filters whole. */
export const AuditDetectionUpdateRequest = Schema.Struct({
	name: Schema.optionalKey(DetectionName),
	enabled: Schema.optionalKey(Schema.Boolean),
	filters: Schema.optionalKey(AuditDetectionFilters),
	windowMinutes: Schema.optionalKey(DetectionWindowMinutes),
	threshold: Schema.optionalKey(DetectionThreshold),
	severity: Schema.optionalKey(AlertSeverity),
	destinationIds: Schema.optionalKey(DetectionDestinationIds),
})
export type AuditDetectionUpdateRequest = typeof AuditDetectionUpdateRequest.Type

/** Newest first. */
export const AuditDetectionListResponse = Schema.Struct({
	detections: Schema.Array(AuditDetection),
})
export type AuditDetectionListResponse = typeof AuditDetectionListResponse.Type

export const AuditDetectionDeleteResponse = Schema.Struct({ id: AlertRuleId })
export type AuditDetectionDeleteResponse = typeof AuditDetectionDeleteResponse.Type

export class AuditTrailPersistenceError extends HttpTaggedError<AuditTrailPersistenceError>()(
	"@maple/http/errors/AuditTrailPersistenceError",
	/** `cause` names the failure behind it (its tag), never its details. */
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "audit_trail_unavailable",
		title: "The audit log is temporarily unavailable",
		message: "The audit log is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class AuditTrailForbiddenError extends HttpTaggedError<AuditTrailForbiddenError>()(
	"@maple/http/errors/AuditTrailForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "audit_trail_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class AuditDetectionNotFoundError extends HttpTaggedError<AuditDetectionNotFoundError>()(
	"@maple/http/errors/AuditDetectionNotFoundError",
	{ detectionId: AlertRuleId, message: Schema.String },
	{
		status: 404,
		code: "audit_detection_not_found",
		title: "Detection not found",
		message: "No such detection.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

/** An unknown destination, a name another alert rule has, or the per-org cap. */
export class AuditDetectionInvalidError extends HttpTaggedError<AuditDetectionInvalidError>()(
	"@maple/http/errors/AuditDetectionInvalidError",
	{ message: Schema.String },
	{
		status: 400,
		code: "audit_detection_invalid",
		title: "Invalid detection",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class AuditTrailApiGroup extends HttpApiGroup.make("auditTrail")
	.add(
		HttpApiEndpoint.get("list", "/events", {
			query: AuditTrailListQuery,
			success: AuditTrailListResponse,
			error: [AuditTrailPersistenceError, AuditTrailForbiddenError],
		}),
	)
	.add(
		HttpApiEndpoint.get("sources", "/sources", {
			success: AuditTrailSourcesResponse,
			error: [AuditTrailPersistenceError, AuditTrailForbiddenError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listDetections", "/detections", {
			success: AuditDetectionListResponse,
			error: [AuditTrailPersistenceError, AuditTrailForbiddenError],
		}),
	)
	.add(
		HttpApiEndpoint.post("createDetection", "/detections", {
			payload: AuditDetectionCreateRequest,
			success: AuditDetection,
			error: [AuditTrailPersistenceError, AuditTrailForbiddenError, AuditDetectionInvalidError],
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateDetection", "/detections/:id", {
			params: { id: AlertRuleId },
			payload: AuditDetectionUpdateRequest,
			success: AuditDetection,
			error: [
				AuditTrailPersistenceError,
				AuditTrailForbiddenError,
				AuditDetectionNotFoundError,
				AuditDetectionInvalidError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteDetection", "/detections/:id", {
			params: { id: AlertRuleId },
			success: AuditDetectionDeleteResponse,
			error: [AuditTrailPersistenceError, AuditTrailForbiddenError, AuditDetectionNotFoundError],
		}),
	)
	.prefix("/internal/audit-trail")
	.middleware(SessionAuthorization) {}
