import { Schema } from "effect"

/** Platforms whose audit events the trail holds. One literal per built adapter; `maple` is Maple's own audit log. */
export const AuditTrailProvider = Schema.Literals(["maple", "vercel", "gcp", "aws", "github", "fleet"])
export type AuditTrailProvider = typeof AuditTrailProvider.Type

/**
 * What an event is about, the same across platforms so one rule covers all of them.
 * `configuration` is how the platform behaves; `resource` is something people make and own in it.
 * `permission` is what someone may do: a grant changed, or a request refused for lacking one.
 */
export const AuditTrailCategory = Schema.Literals([
	"authentication",
	"membership",
	"permission",
	"credential",
	"configuration",
	"resource",
	"data_access",
	"billing",
	"other",
])
export type AuditTrailCategory = typeof AuditTrailCategory.Type

/** `service`: a token, key, app, service account or agent. `system`: the platform acting on its own. */
export const AuditTrailActorType = Schema.Literals(["user", "service", "system", "unknown"])
export type AuditTrailActorType = typeof AuditTrailActorType.Type

/** `failure`: attempted and it did not work. `denied`: refused for lack of access. */
export const AuditTrailOutcome = Schema.Literals(["success", "failure", "denied", "unknown"])
export type AuditTrailOutcome = typeof AuditTrailOutcome.Type

/**
 * What an audit log detection counts. `action` matches the action and its sub-actions
 * (`push.forced` counts `push.forced.default_branch`). No actor or origin filter on
 * purpose: rule rows sync to every member's browser, so nothing in a rule may name a person.
 */
export const AuditDetectionFilters = Schema.Struct({
	provider: Schema.optionalKey(AuditTrailProvider),
	category: Schema.optionalKey(AuditTrailCategory),
	outcome: Schema.optionalKey(AuditTrailOutcome),
	action: Schema.optionalKey(
		Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
	),
})
export type AuditDetectionFilters = typeof AuditDetectionFilters.Type

/**
 * One audit event as a provider adapter hands it over, and as it travels through a queue.
 * `provider`, `account` and `providerEventId` make the stored row's key: a redelivery collapses
 * only when it also carries the same `occurredAtMs`. `raw` is the platform's payload, kept for the
 * detail view. `optional`, not `optionalKey`: adapters leave a field they could not read as `undefined`.
 */
export const AuditTrailEventSchema = Schema.Struct({
	provider: AuditTrailProvider,
	providerEventId: Schema.String,
	/** The platform account, organization, team or project the event belongs to. */
	account: Schema.optional(Schema.String),
	occurredAtMs: Schema.Number,
	actor: Schema.Struct({
		type: AuditTrailActorType,
		id: Schema.optional(Schema.String),
		name: Schema.optional(Schema.String),
		email: Schema.optional(Schema.String),
	}),
	/** The platform's own action name, unchanged (`org.add_member`, `alert_rule.deleted`). */
	action: Schema.String,
	category: AuditTrailCategory,
	outcome: AuditTrailOutcome,
	/** Why it failed or was refused, in the platform's words. */
	outcomeReason: Schema.optional(Schema.String),
	target: Schema.optional(
		Schema.Struct({
			type: Schema.optional(Schema.String),
			id: Schema.optional(Schema.String),
			name: Schema.optional(Schema.String),
		}),
	),
	originIp: Schema.optional(Schema.String),
	originCountry: Schema.optional(Schema.String),
	userAgent: Schema.optional(Schema.String),
	raw: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type AuditTrailEvent = typeof AuditTrailEventSchema.Type
