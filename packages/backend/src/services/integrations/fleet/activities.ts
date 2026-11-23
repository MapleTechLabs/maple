import type { AuditTrailCategory, AuditTrailEvent, AuditTrailOutcome } from "@maple/domain/audit-trail"
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"
import { timestampMs } from "@maple/backend/platform/time"

// A Fleet activity (`GET /api/v1/fleet/activities`) as an audit trail event: who signed in, who
// changed users and roles, policies, agent settings and enroll secrets, and what was done to devices.

export const FleetActivity = Schema.Struct({
	id: Schema.Number,
	created_at: Schema.String,
	type: Schema.String,
	actor_full_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	actor_id: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	actor_email: Schema.optionalKey(Schema.NullOr(Schema.String)),
	fleet_initiated: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	details: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})
export type FleetActivity = typeof FleetActivity.Type

export const FleetActivitiesPage = Schema.Struct({
	// Fleet leaves an empty list out of its JSON.
	activities: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetActivity))),
	meta: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ has_next_results: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) })),
	),
})

type Details = Readonly<Record<string, unknown>>
type Target = NonNullable<AuditTrailEvent["target"]>

/** Types whose category the type's words alone would get wrong. */
const CATEGORY_OF = {
	user_logged_in: "authentication",
	user_failed_login: "authentication",
	user_mfa_requested: "authentication",
	created_user: "membership",
	deleted_user: "membership",
	user_added_by_sso: "membership",
	changed_user_global_role: "permission",
	deleted_user_global_role: "permission",
	changed_user_team_role: "permission",
	deleted_user_team_role: "permission",
	// Fleet 5's names for the two above.
	changed_user_fleet_role: "permission",
	deleted_user_fleet_role: "permission",
	edited_enroll_secrets: "credential",
	read_host_disk_encryption_key: "data_access",
	live_query: "data_access",
	locked_host: "resource",
	unlocked_host: "resource",
	wiped_host: "resource",
	failed_wipe: "resource",
	deleted_host: "resource",
	transferred_hosts: "resource",
	ran_script: "resource",
	ran_script_batch: "resource",
} as const satisfies Record<string, AuditTrailCategory>

const hasOwnCategory = (type: string): type is keyof typeof CATEGORY_OF =>
	Rec.has<string, unknown>(CATEGORY_OF, type)

/** The rest by their words: settings and specs are configuration, anything done to devices is a resource. */
const categoryByWords = (type: string): AuditTrailCategory => {
	if (/(^|_)(role|roles)(_|$)/.test(type)) return "permission"
	if (/(^|_)(secret|secrets|token|api_key|certificate)(_|$)/.test(type)) return "credential"
	if (/(^|_)hosts?(_|$)|software|script|profile|wipe|lock|enrolled/.test(type)) return "resource"
	if (
		/^(applied_spec|edited|enabled|disabled|created|deleted|added|changed|reset|updated|modified)_/.test(
			type,
		)
	)
		return "configuration"
	return "other"
}

export const fleetActivityCategory = (type: string): AuditTrailCategory =>
	hasOwnCategory(type) ? CATEGORY_OF[type] : categoryByWords(type)

export const fleetActivityOutcome = (type: string): AuditTrailOutcome =>
	/(^|_)failed(_|$)|_rejected$|^rejected_/.test(type) ? "failure" : "success"

const textAt = (details: Details | undefined, key: string): string | undefined => {
	const found = details?.[key]
	return typeof found === "string" && found !== "" ? found : undefined
}

/** Fleet ids are numbers; the trail keeps them as text. */
const idAt = (details: Details | undefined, key: string): string | undefined => {
	const found = details?.[key]
	return typeof found === "number" && Number.isFinite(found) ? String(found) : textAt(details, key)
}

/**
 * The thing an activity names, first match wins: a device, a user, a policy, a fleet, a script, a
 * query. Fleet 4 names a fleet by `team_*` (4.82 to 4.96 send both), Fleet 5 by `fleet_*` alone.
 */
const TARGETS: ReadonlyArray<{
	readonly type: string
	readonly id: ReadonlyArray<string>
	readonly name: ReadonlyArray<string>
}> = [
	{ type: "host", id: ["host_id"], name: ["host_display_name", "host_name", "hostname"] },
	{ type: "user", id: ["user_id"], name: ["user_name", "user_email"] },
	{ type: "policy", id: ["policy_id"], name: ["policy_name"] },
	{ type: "fleet", id: ["fleet_id", "team_id"], name: ["fleet_name", "team_name"] },
	{ type: "script", id: ["script_execution_id"], name: ["script_name"] },
	{ type: "query", id: ["query_id"], name: ["query_name", "name"] },
	{ type: "label", id: ["label_id"], name: ["label_name"] },
]

const firstText = (details: Details | undefined, keys: ReadonlyArray<string>, read: typeof textAt) =>
	Option.getOrUndefined(Arr.findFirst(keys, (key) => Option.fromNullishOr(read(details, key))))

const targetOf = (details: Details | undefined): Target | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(
			Arr.map(TARGETS, (target) => ({
				type: target.type,
				id: firstText(details, target.id, idAt),
				name: firstText(details, target.name, textAt),
			})),
			(target) => target.id !== undefined || target.name !== undefined,
		),
	)

/** Fleet acting on its own: an automation, or no person behind it. */
const actorOf = (activity: FleetActivity, details: Details | undefined): AuditTrailEvent["actor"] => {
	// Fleet sends an empty address for activity no user did.
	const email =
		activity.actor_email !== undefined && activity.actor_email !== null && activity.actor_email !== ""
			? activity.actor_email
			: textAt(details, "email")
	if (activity.actor_id !== undefined && activity.actor_id !== null && activity.fleet_initiated !== true)
		return {
			type: "user",
			id: String(activity.actor_id),
			name: activity.actor_full_name ?? undefined,
			email,
		}
	// A failed login names the address tried, never an account that proved itself.
	if (activity.type === "user_failed_login") return { type: "unknown", email }
	// Automations, and what a device does itself (enrolling), have no person behind them.
	return { type: "system", name: "Fleet" }
}

/** Where an activity came from: the org's name for the server, and its host. */
export interface FleetActivitySource {
	readonly account: string
	readonly server: string
}

/**
 * One activity as the trail stores it, or None when its time does not parse. Activity ids count
 * per server, so the event id names the server: two servers never write the same row.
 */
export const fleetActivityToEvent = (
	activity: FleetActivity,
	source: FleetActivitySource,
): Option.Option<AuditTrailEvent> => {
	const occurredAtMs = timestampMs(activity.created_at)
	if (!Number.isFinite(occurredAtMs)) return Option.none()
	const details = activity.details ?? undefined
	const outcome = fleetActivityOutcome(activity.type)
	return Option.some({
		provider: "fleet",
		providerEventId: `${source.server}:${activity.id}`,
		account: source.account,
		occurredAtMs,
		actor: actorOf(activity, details),
		action: activity.type,
		category: fleetActivityCategory(activity.type),
		outcome,
		outcomeReason: outcome === "failure" ? Str.replaceAll("_", " ")(activity.type) : undefined,
		target: targetOf(details),
		originIp: textAt(details, "public_ip"),
		raw: { ...activity },
	})
}
