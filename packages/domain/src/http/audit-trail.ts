import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"

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

export class AuditTrailPersistenceError extends Schema.TaggedError<AuditTrailPersistenceError>()(
	"@maple/http/audit-trail/AuditTrailPersistenceError",
	/** `cause` names the failure behind it (its tag), never its details. */
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{ httpApiStatus: 503 },
) {}

export class AuditTrailForbiddenError extends Schema.TaggedError<AuditTrailForbiddenError>()(
	"@maple/http/audit-trail/AuditTrailForbiddenError",
	{ message: Schema.String },
	{ httpApiStatus: 403 },
) {}

export class AuditTrailApiGroup extends HttpApiGroup.make("auditTrail")
	.add(
		HttpApiEndpoint.get("list", "/events", {
			query: AuditTrailListQuery,
			success: AuditTrailListResponse,
			error: [AuditTrailPersistenceError, AuditTrailForbiddenError],
		}),
	)
	.prefix("/internal/audit-trail")
	.middleware(SessionAuthorization) {}
