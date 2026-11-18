// BOUNDARY-FILE: this module reads unparsed GitHub webhook payloads and narrows them field by field.
import type { AuditTrailActorType, AuditTrailCategory, AuditTrailEvent } from "@maple/domain/audit-trail"
import { Array as Arr, Option, Predicate, Record as Rec, Schema } from "effect"

// A GitHub webhook as an audit trail event: who changed the organization's people, access,
// repositories and their protections. Events about code and CI are not audit events and stay out.

type Json = Readonly<Record<string, unknown>>

const objectAt = (value: Json | undefined, key: string): Json | undefined => {
	const found = value?.[key]
	return Predicate.isObject(found) && !Arr.isArray(found) ? found : undefined
}
const textAt = (value: Json | undefined, key: string): string | undefined => {
	const found = value?.[key]
	return typeof found === "string" && found !== "" ? found : undefined
}
/** GitHub ids are numbers; the trail keeps them as text. */
const idAt = (value: Json | undefined, key: string): string | undefined => {
	const found = value?.[key]
	if (typeof found === "number" && Number.isFinite(found)) return String(found)
	return textAt(value, key)
}

type Target = NonNullable<AuditTrailEvent["target"]>

const userTarget = (user: Json | undefined): Target | undefined =>
	user === undefined ? undefined : { type: "user", id: idAt(user, "id"), name: textAt(user, "login") }

const repositoryTarget = (payload: Json): Target | undefined => {
	const repository = objectAt(payload, "repository")
	return repository === undefined
		? undefined
		: { type: "repository", id: idAt(repository, "id"), name: textAt(repository, "full_name") }
}

const named = (type: string, value: Json | undefined, nameKey: string): Target | undefined =>
	value === undefined ? undefined : { type, id: idAt(value, "id"), name: textAt(value, nameKey) }

const withRepository = (payload: Json, name: string | undefined) => {
	const repository = textAt(objectAt(payload, "repository"), "full_name")
	return repository === undefined || name === undefined ? name : `${repository}: ${name}`
}

/** The repositories an installation gained or lost: the one, or how many. */
const installationRepositoriesTarget = (payload: Json, action: string): Target => {
	const listed = payload[action === "added" ? "repositories_added" : "repositories_removed"]
	const repositories = Arr.isArray(listed) ? Arr.filter(listed, Predicate.isObject) : []
	const only = repositories.length === 1 ? repositories[0] : undefined
	return only === undefined
		? { type: "repository", name: `${repositories.length} repositories` }
		: { type: "repository", id: idAt(only, "id"), name: textAt(only, "full_name") }
}

/** How one kept webhook reads: what it is about, and what it changed. */
interface AuditedWebhook {
	readonly category: (action: string) => AuditTrailCategory
	readonly target: (payload: Json, action: string) => Target | undefined
}

/**
 * The webhooks the trail keeps. `installation*` arrive with no subscription; `organization`,
 * `member`, `membership` and `team` ride the Members permission the connect flow already needs;
 * `repository` rides Metadata; the protections, rulesets and code security settings need
 * Administration: read, and deploy keys need Deployments: read.
 */
const AUDITED_WEBHOOKS = {
	installation: {
		category: () => "permission",
		target: (payload) => {
			const installation = objectAt(payload, "installation")
			return { type: "app", id: idAt(installation, "app_id"), name: textAt(installation, "app_slug") }
		},
	},
	installation_repositories: {
		category: () => "permission",
		target: installationRepositoriesTarget,
	},
	organization: {
		category: (action) => (action === "renamed" || action === "deleted" ? "configuration" : "membership"),
		target: (payload, action) => {
			if (action === "member_invited") {
				const invitation = objectAt(payload, "invitation")
				return {
					type: "user",
					id: idAt(objectAt(payload, "user"), "id"),
					name: textAt(invitation, "login") ?? textAt(invitation, "email"),
				}
			}
			const membership = objectAt(payload, "membership")
			return membership === undefined
				? named("organization", objectAt(payload, "organization"), "login")
				: userTarget(objectAt(membership, "user"))
		},
	},
	member: {
		// A collaborator's role on a repository changed: what they may do there.
		category: (action) => (action === "edited" ? "permission" : "membership"),
		target: (payload) => {
			const member = userTarget(objectAt(payload, "member"))
			return member === undefined
				? undefined
				: { ...member, name: withRepository(payload, member.name) }
		},
	},
	membership: {
		category: () => "membership",
		target: (payload) => {
			const member = userTarget(objectAt(payload, "member"))
			const team = textAt(objectAt(payload, "team"), "slug")
			return member === undefined
				? undefined
				: { ...member, name: team === undefined ? member.name : `${member.name ?? "?"} in ${team}` }
		},
	},
	team: {
		category: (action) =>
			action === "added_to_repository" || action === "removed_from_repository"
				? "permission"
				: "membership",
		target: (payload) => named("team", objectAt(payload, "team"), "slug"),
	},
	repository: {
		// Visibility decides who can read the code: how the organization is set up, not a resource edit.
		category: (action) =>
			action === "publicized" || action === "privatized" ? "configuration" : "resource",
		target: repositoryTarget,
	},
	branch_protection_rule: {
		category: () => "configuration",
		target: (payload) => {
			const rule = objectAt(payload, "rule")
			return rule === undefined
				? repositoryTarget(payload)
				: {
						type: "branch_protection_rule",
						id: idAt(rule, "id"),
						name: withRepository(payload, textAt(rule, "name")),
					}
		},
	},
	branch_protection_configuration: {
		category: () => "configuration",
		target: repositoryTarget,
	},
	repository_ruleset: {
		category: () => "configuration",
		target: (payload) => {
			const ruleset = objectAt(payload, "repository_ruleset")
			return ruleset === undefined
				? undefined
				: {
						type: "ruleset",
						id: idAt(ruleset, "id"),
						name: withRepository(payload, textAt(ruleset, "name")),
					}
		},
	},
	deploy_key: {
		category: () => "credential",
		target: (payload) => {
			const key = objectAt(payload, "key")
			return key === undefined
				? undefined
				: {
						type: "deploy_key",
						id: idAt(key, "id"),
						name: withRepository(payload, textAt(key, "title")),
					}
		},
	},
	security_and_analysis: {
		category: () => "configuration",
		target: repositoryTarget,
	},
	org_block: {
		category: () => "permission",
		target: (payload) => userTarget(objectAt(payload, "blocked_user")),
	},
	personal_access_token_request: {
		category: () => "credential",
		target: (payload) => {
			const request = objectAt(payload, "personal_access_token_request")
			return request === undefined
				? undefined
				: {
						type: "personal_access_token_request",
						id: idAt(request, "id"),
						name: textAt(objectAt(request, "owner"), "login"),
					}
		},
	},
} satisfies Record<string, AuditedWebhook>

/** The kept webhook by GitHub's event name; none for one the trail leaves out. */
const auditedWebhook = (event: string): Option.Option<AuditedWebhook> =>
	Rec.get<string, AuditedWebhook>(AUDITED_WEBHOOKS, event)

const actorOf = (sender: Json | undefined): AuditTrailEvent["actor"] => {
	const kind = textAt(sender, "type")
	const type: AuditTrailActorType = kind === "User" ? "user" : kind === "Bot" ? "service" : "unknown"
	return { type, id: idAt(sender, "id"), name: textAt(sender, "login") }
}

/** The organization or personal account the event belongs to. */
const accountOf = (payload: Json): string | undefined =>
	textAt(objectAt(payload, "organization"), "login") ??
	textAt(objectAt(objectAt(payload, "installation"), "account"), "login") ??
	textAt(objectAt(objectAt(payload, "repository"), "owner"), "login")

const UUID_V1 = /^([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-[0-9a-f]{4}-[0-9a-f]{12}$/iu
/** 100 ns intervals between the UUID epoch (1582-10-15) and the Unix epoch. */
const UUID_EPOCH_OFFSET = 122_192_928_000_000_000n
/**
 * How far a delivery id's time may sit from receipt before it is not trusted. Wider than the three
 * days GitHub keeps deliveries for redelivery, so every redelivery keeps the original time.
 */
const DELIVERY_TIME_TOLERANCE_MS = 7 * 86_400_000

/** When GitHub sent the delivery, from a v1 delivery id; `receivedAtMs` when the id has no usable time. */
export const deliveryTimeMs = (deliveryId: string, receivedAtMs: number): number => {
	const match = UUID_V1.exec(deliveryId)
	if (match === null) return receivedAtMs
	const [, low = "", mid = "", high = ""] = match
	const ticks = BigInt(`0x${high}${mid}${low}`)
	const ms = Number((ticks - UUID_EPOCH_OFFSET) / 10_000n)
	return Math.abs(ms - receivedAtMs) <= DELIVERY_TIME_TOLERANCE_MS ? ms : receivedAtMs
}

/** The most of a payload the trail keeps; a larger one loses the objects the event's fields came from. */
const RAW_LIMIT_BYTES = 32 * 1024
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const sizeOf = (value: Json) => new TextEncoder().encode(encodeJson(value)).length
const BULKY = [
	"repository",
	"organization",
	"sender",
	"enterprise",
	"repositories_added",
	"repositories_removed",
]

const rawOf = (payload: Json): Json | undefined => {
	// The installation block is Maple's own app and its permissions, the same on every delivery.
	const kept = Rec.remove(payload, "installation")
	if (sizeOf(kept) <= RAW_LIMIT_BYTES) return kept
	const trimmed = Arr.reduce(BULKY, kept, (acc, key) => Rec.remove(acc, key))
	return sizeOf(trimmed) <= RAW_LIMIT_BYTES ? trimmed : undefined
}

/**
 * A verified webhook as the audit trail stores it. None for events the trail does not keep, and for
 * a delivery without an id: the id is the event's key, so a redelivery of the same delivery collapses.
 * GitHub's payloads carry no event time. A time-based (v1) delivery id carries when GitHub sent it,
 * which a redelivery keeps, so the row still collapses; any other id falls back to `receivedAtMs`.
 */
export const githubAuditEvent = (input: {
	readonly event: string | undefined
	readonly deliveryId: string | undefined
	readonly payload: unknown
	readonly receivedAtMs: number
}): Option.Option<AuditTrailEvent> => {
	const webhook = input.event === undefined ? undefined : Option.getOrUndefined(auditedWebhook(input.event))
	if (webhook === undefined || input.deliveryId === undefined) return Option.none()
	if (!Predicate.isObject(input.payload) || Arr.isArray(input.payload)) return Option.none()
	const payload: Json = input.payload
	// `security_and_analysis` names no action: the change itself is the event.
	const action = textAt(payload, "action") ?? "changed"
	return Option.some({
		provider: "github",
		providerEventId: input.deliveryId,
		account: accountOf(payload),
		occurredAtMs: deliveryTimeMs(input.deliveryId, input.receivedAtMs),
		actor: actorOf(objectAt(payload, "sender")),
		action: `${input.event}.${action}`,
		category: webhook.category(action),
		outcome: "success",
		target: webhook.target(payload, action),
		raw: rawOf(payload),
	})
}
