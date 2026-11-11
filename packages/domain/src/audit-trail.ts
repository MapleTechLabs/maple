import { Schema } from "effect"

/** Platforms whose audit events the trail holds. One literal per built adapter; `maple` is Maple's own audit log. */
export const AuditTrailProvider = Schema.Literals(["maple"])
export type AuditTrailProvider = typeof AuditTrailProvider.Type

/**
 * What an event is about, the same across platforms so one rule covers all of them.
 * `configuration` is how the platform behaves (settings, rules, monitors, integrations);
 * `resource` is something people make and own in it (a repository, a dashboard, a deployment).
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
 * One audit event as a provider adapter hands it over. `provider`, `account` and
 * `providerEventId` make the stored row's key: a redelivery collapses only when it also
 * carries the same `occurredAtMs`. `raw` is the platform's payload, kept for the detail view.
 */
export interface AuditTrailEvent {
	readonly provider: AuditTrailProvider
	readonly providerEventId: string
	/** The platform account, organization, team or project the event belongs to. */
	readonly account?: string
	readonly occurredAtMs: number
	readonly actor: {
		readonly type: AuditTrailActorType
		readonly id?: string
		readonly name?: string
		readonly email?: string
	}
	/** The platform's own action name, unchanged (`org.add_member`, `alert_rule.deleted`). */
	readonly action: string
	readonly category: AuditTrailCategory
	readonly outcome: AuditTrailOutcome
	readonly target?: {
		readonly type?: string
		readonly id?: string
		readonly name?: string
	}
	readonly originIp?: string
	readonly originCountry?: string
	readonly userAgent?: string
	readonly raw?: Record<string, unknown>
}
