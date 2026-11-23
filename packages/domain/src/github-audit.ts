import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"

// What the GitHub audit log can collect, as categories an org turns on or off under the GitHub
// integration's Audit log switch. Each category owns the GitHub webhook events that feed it.

export interface GithubAuditCategorySpec<Id extends string = string, Event extends string = string> {
	readonly id: Id
	readonly title: string
	readonly summary: string
	readonly defaultEnabled: boolean
	/** GitHub webhook event names (`x-github-event`) whose audit events land in this category. */
	readonly events: ReadonlyArray<Event>
	/** A GitHub App permission an installation must accept before these events arrive. */
	readonly needsPermission?: string
}

// Both literals stay narrow, so the backend's per-event mapper table must match the catalog exactly.
const category = <const Id extends string, const Event extends string>(
	spec: GithubAuditCategorySpec<Id, Event>,
) => spec

export const GITHUB_AUDIT_CATEGORIES = [
	category({
		id: "members",
		title: "Members and teams",
		summary: "People invited, added or removed, role and team changes, and blocked users.",
		defaultEnabled: true,
		events: ["organization", "member", "membership", "team", "org_block"],
	}),
	category({
		id: "repositories",
		title: "Repositories and app access",
		summary:
			"Repositories created, deleted, renamed, archived or made public, and Maple's own access to them.",
		defaultEnabled: true,
		events: ["repository", "installation", "installation_repositories"],
	}),
	category({
		id: "protections",
		title: "Branch protections and rulesets",
		summary: "Branch protection rules and rulesets created, edited, turned off or deleted.",
		defaultEnabled: true,
		events: ["branch_protection_rule", "branch_protection_configuration", "repository_ruleset"],
		needsPermission: "Administration: read",
	}),
	category({
		id: "credentials",
		title: "Deploy keys and access tokens",
		summary: "Deploy keys added or removed, and fine-grained token requests to the organization.",
		defaultEnabled: true,
		events: ["deploy_key", "personal_access_token_request"],
		needsPermission:
			"Deployments: read for deploy keys, and the organization's Personal access token requests: read for token requests",
	}),
	category({
		id: "securitySettings",
		title: "Code security settings",
		summary: "Secret scanning, push protection, Dependabot and code scanning turned on or off.",
		defaultEnabled: true,
		events: ["security_and_analysis"],
		needsPermission: "Administration: read",
	}),
	category({
		id: "forcePushes",
		title: "Force pushes",
		summary: "A push that rewrote a branch's or tag's history, with the commits before and after.",
		defaultEnabled: true,
		events: ["push"],
	}),
	category({
		id: "refDeletions",
		title: "Branch and tag deletions",
		summary: "Branches and tags deleted, and by whom.",
		defaultEnabled: true,
		events: ["delete"],
	}),
	category({
		id: "refCreations",
		title: "Branch and tag creations",
		summary: "Branches and tags created. Busy repositories create many.",
		defaultEnabled: false,
		events: ["create"],
	}),
	category({
		id: "pullRequests",
		title: "Pull request merges and approvals",
		summary: "Pull requests merged, and reviews that approved them or were dismissed.",
		defaultEnabled: false,
		events: ["pull_request", "pull_request_review"],
	}),
	category({
		id: "releases",
		title: "Releases",
		summary: "Releases published, edited or deleted.",
		defaultEnabled: false,
		events: ["release"],
	}),
	category({
		id: "forks",
		title: "Forks",
		summary: "Repositories forked, including private ones forked inside the organization.",
		defaultEnabled: false,
		events: ["fork"],
	}),
	category({
		id: "deployments",
		title: "Deployments",
		summary: "Deployments created, their outcome, and who approved or rejected a protected environment.",
		defaultEnabled: false,
		events: ["deployment", "deployment_status", "deployment_review"],
		needsPermission: "Deployments: read",
	}),
	category({
		id: "securityAlerts",
		title: "Security alerts",
		summary:
			"Secret scanning, code scanning and Dependabot alerts opened, dismissed or fixed, and repository security advisories.",
		defaultEnabled: false,
		events: ["secret_scanning_alert", "code_scanning_alert", "dependabot_alert", "repository_advisory"],
		needsPermission:
			"Secret scanning alerts, Code scanning alerts, Dependabot alerts and Repository security advisories: read",
	}),
] as const

export type GithubAuditCategoryId = (typeof GITHUB_AUDIT_CATEGORIES)[number]["id"]

/** Every GitHub webhook event name the audit log keeps. */
export type GithubAuditWebhookEvent = (typeof GITHUB_AUDIT_CATEGORIES)[number]["events"][number]

export const GithubAuditCategoryId = Schema.Literals(Arr.map(GITHUB_AUDIT_CATEGORIES, (spec) => spec.id))

/**
 * The categories an org changed from their default, as stored and as a PATCH sends them. Stored
 * rows are read as any string key, so a category a later build retires does not fail the row.
 */
export const GithubAuditCategoryOverrides = Schema.Record(Schema.String, Schema.Boolean)
export type GithubAuditCategoryOverrides = typeof GithubAuditCategoryOverrides.Type

/** A partial change to the categories: only known ids, each optional. */
export const GithubAuditCategoryChanges = Schema.Record(
	GithubAuditCategoryId,
	Schema.optionalKey(Schema.Boolean),
)
export type GithubAuditCategoryChanges = typeof GithubAuditCategoryChanges.Type

/** Every category with whether the org collects it. */
export const GithubAuditCategoryStates = Schema.Record(GithubAuditCategoryId, Schema.Boolean)
export type GithubAuditCategoryStates = typeof GithubAuditCategoryStates.Type

const BY_EVENT: Readonly<Record<string, GithubAuditCategoryId>> = Rec.fromEntries(
	Arr.flatMap(GITHUB_AUDIT_CATEGORIES, (spec) =>
		Arr.map(spec.events, (event): readonly [string, GithubAuditCategoryId] => [event, spec.id]),
	),
)

/** The category of a GitHub webhook event name; none for an event the audit log does not keep. */
export const githubAuditCategoryOfEvent = (event: string): Option.Option<GithubAuditCategoryId> =>
	Rec.get(BY_EVENT, event)

/** The category of a stored audit action (`push.forced`): its event name is the part before the dot. */
export const githubAuditCategoryOfAction = (action: string): Option.Option<GithubAuditCategoryId> =>
	Arr.head(Str.split(".")(action)).pipe(Option.flatMap(githubAuditCategoryOfEvent))

/** Whether the org collects a category: its own choice, or the category's default. */
export const githubAuditCategoryEnabled = (
	overrides: GithubAuditCategoryOverrides,
	id: GithubAuditCategoryId,
): boolean =>
	Option.getOrElse(Rec.get(overrides, id), () =>
		Arr.some(GITHUB_AUDIT_CATEGORIES, (spec) => spec.id === id && spec.defaultEnabled),
	)

const toStates = Schema.decodeUnknownSync(GithubAuditCategoryStates)

/** Every category with whether the org collects it. */
export const githubAuditCategoryStates = (
	overrides: GithubAuditCategoryOverrides,
): GithubAuditCategoryStates =>
	toStates(
		Rec.fromEntries(
			Arr.map(
				GITHUB_AUDIT_CATEGORIES,
				(spec) => [spec.id, githubAuditCategoryEnabled(overrides, spec.id)] as const,
			),
		),
	)
