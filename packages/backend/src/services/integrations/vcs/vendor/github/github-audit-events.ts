// BOUNDARY-FILE: this module reads unparsed GitHub webhook payloads and narrows them field by field.
import type { AuditTrailActorType, AuditTrailCategory, AuditTrailEvent } from "@maple/domain/audit-trail"
import type { GithubAuditWebhookEvent } from "@maple/domain/github-audit"
import { Array as Arr, Option, Predicate, Record as Rec, Schema, String as Str } from "effect"

// A GitHub webhook as an audit trail event: who changed the organization's people, access,
// repositories, protections and code, grouped into the categories in `@maple/domain/github-audit`.
// Of the busy code events only the auditable moments are kept: a force push, a merge, an approval.

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
	/**
	 * The action to record, from the payload's own `action` (absent on some events); undefined
	 * leaves this delivery out. Without it, the payload's action is kept, or `changed`.
	 */
	readonly action?: (payload: Json, action: string | undefined) => string | undefined
	readonly category: (action: string) => AuditTrailCategory
	readonly target: (payload: Json, action: string) => Target | undefined
}

/** `refs/heads/main` as a branch named `main`, `refs/tags/v1` as a tag named `v1`. */
const refTarget = (payload: Json): Target | undefined => {
	const ref = textAt(payload, "ref")
	if (ref === undefined) return repositoryTarget(payload)
	const type = Str.startsWith("refs/tags/")(ref) ? "tag" : "branch"
	const name = Str.replace(/^refs\/(heads|tags)\//u, "")(ref)
	return { type, name: withRepository(payload, name) }
}

/** `create` and `delete` name the ref short (`main`) beside its `ref_type`. */
const shortRefTarget = (payload: Json): Target | undefined => {
	const type = textAt(payload, "ref_type") ?? "branch"
	return { type, name: withRepository(payload, textAt(payload, "ref")) }
}

const pullRequestTarget = (payload: Json): Target | undefined => {
	const pr = objectAt(payload, "pull_request")
	if (pr === undefined) return repositoryTarget(payload)
	const number = idAt(pr, "number")
	const repository = textAt(objectAt(payload, "repository"), "full_name")
	return {
		type: "pull_request",
		id: number,
		name:
			repository === undefined || number === undefined
				? textAt(pr, "title")
				: `${repository}#${number}`,
	}
}

/** A scanning or Dependabot alert, named by its repository, what it found, and its number. */
const alertTarget =
	(type: string, describe: (alert: Json) => string | undefined) =>
	(payload: Json): Target | undefined => {
		const alert = objectAt(payload, "alert")
		if (alert === undefined) return repositoryTarget(payload)
		const number = idAt(alert, "number")
		const what = describe(alert)
		return {
			type,
			id: number,
			name: withRepository(
				payload,
				what === undefined ? `#${number ?? "?"}` : `${what} #${number ?? "?"}`,
			),
		}
	}

const deploymentTarget = (payload: Json): Target | undefined => {
	const deployment = objectAt(payload, "deployment")
	return {
		type: "environment",
		id: idAt(deployment, "id"),
		name: withRepository(payload, textAt(deployment, "environment")),
	}
}

/** An environment review names its environment on the job it held, not on a deployment. */
const deploymentReviewTarget = (payload: Json): Target | undefined => {
	const runs = payload["workflow_job_runs"]
	const firstRun = Arr.isArray(runs) ? Arr.findFirst(runs, Predicate.isObject) : Option.none()
	const environment =
		Option.match(firstRun, { onNone: () => undefined, onSome: (run) => textAt(run, "environment") }) ??
		textAt(objectAt(payload, "workflow_job_run"), "environment") ??
		textAt(payload, "environment")
	return { type: "environment", name: withRepository(payload, environment) }
}

/** A deployment's outcome; the states on the way there are not audit events. */
const DEPLOYMENT_OUTCOMES: ReadonlySet<string> = new Set(["success", "failure", "error"])

/** The releases worth an audit row: what people see change, not drafts being edited. */
const RELEASE_ACTIONS: ReadonlySet<string> = new Set(["published", "unpublished", "edited", "deleted"])

/**
 * The webhooks the trail keeps, one per event in the category catalog (a missing or extra one fails
 * to compile). `installation*` arrive with no subscription; the permissions each category needs are
 * on the catalog and in `docs/github-app-setup.md`.
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
	push: {
		// Only a push that rewrote the ref's history; an ordinary push is code, not an audit event.
		action: (payload) => (payload["forced"] === true ? "forced" : undefined),
		category: () => "resource",
		target: refTarget,
	},
	delete: {
		action: (payload) => textAt(payload, "ref_type") ?? "branch",
		category: () => "resource",
		target: shortRefTarget,
	},
	create: {
		action: (payload) => textAt(payload, "ref_type") ?? "branch",
		category: () => "resource",
		target: shortRefTarget,
	},
	pull_request: {
		// A merge is the moment code reaches a branch; opening, syncing and labels are not audit events.
		action: (payload, action) =>
			action === "closed" && objectAt(payload, "pull_request")?.["merged"] === true
				? "merged"
				: undefined,
		category: () => "resource",
		target: pullRequestTarget,
	},
	pull_request_review: {
		action: (payload, action) => {
			if (action === "dismissed") return "dismissed"
			return action === "submitted" && textAt(objectAt(payload, "review"), "state") === "approved"
				? "approved"
				: undefined
		},
		category: () => "permission",
		target: pullRequestTarget,
	},
	release: {
		// A draft's edits are invisible to everyone else until it is published. An unpublished
		// release arrives as a draft too, and that one is kept.
		action: (payload, action) => {
			if (action === undefined || !RELEASE_ACTIONS.has(action)) return undefined
			return action === "edited" && objectAt(payload, "release")?.["draft"] === true
				? undefined
				: action
		},
		category: () => "resource",
		target: (payload) => {
			const release = objectAt(payload, "release")
			return release === undefined
				? repositoryTarget(payload)
				: {
						type: "release",
						id: idAt(release, "id"),
						name: withRepository(payload, textAt(release, "tag_name") ?? textAt(release, "name")),
					}
		},
	},
	fork: {
		// A fork copies the code somewhere else: who could read it may have changed.
		action: () => "created",
		category: () => "data_access",
		target: (payload) => {
			const source = textAt(objectAt(payload, "repository"), "full_name")
			const forkee = objectAt(payload, "forkee")
			return {
				type: "repository",
				id: idAt(forkee, "id"),
				name:
					source === undefined
						? textAt(forkee, "full_name")
						: `${source} to ${textAt(forkee, "full_name") ?? "?"}`,
			}
		},
	},
	deployment: {
		category: () => "resource",
		target: deploymentTarget,
	},
	deployment_status: {
		// The outcome is the action: `deployment_status.success`, `.failure`, `.error`.
		action: (payload) => {
			const state = textAt(objectAt(payload, "deployment_status"), "state")
			return state !== undefined && DEPLOYMENT_OUTCOMES.has(state) ? state : undefined
		},
		category: () => "resource",
		target: deploymentTarget,
	},
	deployment_review: {
		// Who let a deployment through or stopped it; the request itself is not a decision.
		action: (_payload, action) => (action === "approved" || action === "rejected" ? action : undefined),
		category: () => "permission",
		target: deploymentReviewTarget,
	},
	secret_scanning_alert: {
		category: () => "credential",
		target: alertTarget(
			"secret_scanning_alert",
			(alert) => textAt(alert, "secret_type_display_name") ?? textAt(alert, "secret_type"),
		),
	},
	code_scanning_alert: {
		// `appeared_in_branch` repeats an alert already reported on another branch.
		action: (_payload, action) => (action === "appeared_in_branch" ? undefined : action),
		category: () => "other",
		target: alertTarget("code_scanning_alert", (alert) => {
			const rule = objectAt(alert, "rule")
			return textAt(rule, "description") ?? textAt(rule, "id")
		}),
	},
	dependabot_alert: {
		category: () => "other",
		target: alertTarget("dependabot_alert", (alert) => {
			const name = textAt(objectAt(objectAt(alert, "dependency"), "package"), "name")
			const advisory = textAt(objectAt(alert, "security_advisory"), "ghsa_id")
			return name === undefined ? advisory : advisory === undefined ? name : `${name} ${advisory}`
		}),
	},
	repository_advisory: {
		category: () => "other",
		target: (payload) => {
			const advisory = objectAt(payload, "repository_advisory")
			return advisory === undefined
				? repositoryTarget(payload)
				: {
						type: "repository_advisory",
						id: textAt(advisory, "ghsa_id"),
						name: withRepository(
							payload,
							textAt(advisory, "summary") ?? textAt(advisory, "ghsa_id"),
						),
					}
		},
	},
} satisfies { readonly [E in GithubAuditWebhookEvent]: AuditedWebhook }

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
	"commits",
	"head_commit",
	"pull_request",
	"forkee",
	"workflow_run",
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
	const sent = textAt(payload, "action")
	// `security_and_analysis` names no action: the change itself is the event.
	const action = webhook.action === undefined ? (sent ?? "changed") : webhook.action(payload, sent)
	if (action === undefined) return Option.none()
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
