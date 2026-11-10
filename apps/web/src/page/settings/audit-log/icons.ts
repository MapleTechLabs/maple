import type { AuditResources, AuditResourceType } from "@maple/domain/audit-actions"
import type { AuditActorType, AuditLogSource, AuditOutcome } from "@maple/domain/http"
import type { IconName } from "@maple/views/ui/icon"
import { Array as Arr, Record as Rec, String as Str } from "effect"

// The audit log's glyphs: one per actor type, surface, outcome and kind of action, so a filter and
// the rows it lists carry the same picture.

export const ACTOR_ICONS = {
	user: "UserIcon",
	api_key: "KeyIcon",
	agent: "FaceRobotIcon",
	system: "GearIcon",
} as const satisfies { readonly [Actor in AuditActorType]: IconName }

export const SOURCE_ICONS = {
	dashboard: "MonitorIcon",
	api: "BracketsCurlyIcon",
	mcp: "PlugIcon",
	chat_platform: "ChatBubbleIcon",
	system: "GearIcon",
} as const satisfies { readonly [Source in AuditLogSource]: IconName }

export const OUTCOME_ICONS = {
	allowed: "CircleCheckIcon",
	denied: "CircleXmarkIcon",
} as const satisfies { readonly [Outcome in AuditOutcome]: IconName }

type AuditVerb = (typeof AuditResources)[AuditResourceType]["verbs"][number]

/** The verbs with a picture of their own; a verb left out reads as a plain event. */
const VERB_ICONS = {
	created: "PlusIcon",
	added: "PlusIcon",
	registered: "PlusIcon",
	submitted: "PlusIcon",
	minted: "PlusIcon",
	claimed: "PlusIcon",
	install_started: "PlusIcon",
	connect_started: "PlusIcon",
	identity_link_started: "LinkIcon",
	updated: "PencilIcon",
	settings_updated: "PencilIcon",
	zones_updated: "PencilIcon",
	role_changed: "ShieldIcon",
	status_changed: "PencilIcon",
	catalog_curated: "PencilIcon",
	components_reordered: "PencilIcon",
	config_applied: "PencilIcon",
	schema_applied: "PencilIcon",
	organization_selected: "PencilIcon",
	metrics_token_set: "KeyIcon",
	region_chosen: "GlobeIcon",
	triaged: "PencilIcon",
	deleted: "TrashIcon",
	removed: "TrashIcon",
	removal_confirmed: "TrashIcon",
	uninstalled: "TrashIcon",
	revoked: "LockIcon",
	break_glass_revoked: "LockIcon",
	disconnected: "LockIcon",
	identity_unlinked: "LockIcon",
	cancelled: "SquareIcon",
	ended: "SquareIcon",
	rolled: "ArrowRotateClockwiseIcon",
	rotated: "ArrowRotateClockwiseIcon",
	break_glass_rotated: "ArrowRotateClockwiseIcon",
	restarted: "ArrowRotateClockwiseIcon",
	version_restored: "HistoryIcon",
	catalog_refreshed: "ArrowRotateClockwiseIcon",
	read: "EyeIcon",
	called: "SquareTerminalIcon",
	sql_executed: "DatabaseIcon",
	request: "BracketsCurlyIcon",
	tested: "MediaPlayIcon",
	paused: "MediaPauseIcon",
	resumed: "MediaPlayIcon",
	published: "PaperPlaneIcon",
	update_posted: "PaperPlaneIcon",
	invite_sent: "PaperPlaneIcon",
	resolved: "CircleCheckIcon",
	regression: "CircleWarningIcon",
	comment: "ChatBubbleIcon",
	agent_note: "ChatBubbleIcon",
	ai_triage: "SparkleIcon",
	fix_proposed: "SparkleIcon",
	snooze: "BellSlashIcon",
	unsnooze: "BellIcon",
	assignment: "UserIcon",
	claim: "UserIcon",
	release: "UserIcon",
	pr_linked: "PullRequestIcon",
	pr_unlinked: "PullRequestIcon",
	pr_merged: "PullRequestIcon",
	merge: "BranchForkIcon",
	unmerge: "BranchForkIcon",
} as const satisfies { readonly [Verb in AuditVerb]?: IconName }

const hasVerbIcon = (verb: string): verb is keyof typeof VERB_ICONS =>
	Rec.has<string, IconName>(VERB_ICONS, verb)

/** The glyph for a `<resource>.<verb>` action, by its verb. */
export const auditActionIcon = (action: string): IconName => {
	const verb = Arr.lastNonEmpty(Str.split(".")(action))
	return hasVerbIcon(verb) ? VERB_ICONS[verb] : "BoltIcon"
}
