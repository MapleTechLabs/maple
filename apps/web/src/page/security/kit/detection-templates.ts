import type { AuditDetectionFilters } from "@maple/domain/audit-trail"
import type { AlertSeverity } from "@maple/domain/http"
import { Array as Arr, Option } from "effect"

// The ready-made detections the empty Detections page and the editor start from. Picking one
// fills the form; nothing is created until it is saved.

type DetectionTemplateId =
	| "membership"
	| "permission"
	| "credential"
	| "refused"
	| "sign_in"
	| "force_push_default_branch"
	| "force_push_non_author"

export type DetectionTemplate = Readonly<{
	id: DetectionTemplateId
	/** Also the name the form starts with. */
	title: string
	/** When it fires, in one line. */
	summary: string
	filters: AuditDetectionFilters
	threshold: number
	windowMinutes: number
	severity: AlertSeverity
}>

export const DETECTION_TEMPLATES: ReadonlyArray<DetectionTemplate> = [
	{
		id: "membership",
		title: "Member added or removed",
		summary: "Fires when anyone is invited, added or removed on any platform.",
		filters: { category: "membership" },
		threshold: 1,
		windowMinutes: 5,
		severity: "warning",
	},
	{
		id: "permission",
		title: "Permission or role changed",
		summary: "Fires when a role or permission change goes through.",
		filters: { category: "permission", outcome: "success" },
		threshold: 1,
		windowMinutes: 5,
		severity: "warning",
	},
	{
		id: "credential",
		title: "Credential created, rotated or revoked",
		summary: "Fires when an API key, token or secret changes.",
		filters: { category: "credential" },
		threshold: 1,
		windowMinutes: 5,
		severity: "warning",
	},
	{
		id: "refused",
		title: "Burst of refused requests",
		summary: "Fires on 10 or more denied requests within 10 minutes.",
		filters: { outcome: "denied" },
		threshold: 10,
		windowMinutes: 10,
		severity: "critical",
	},
	{
		id: "sign_in",
		title: "Repeated sign-in failures",
		summary: "Fires on 5 or more failed sign-ins within 10 minutes.",
		filters: { category: "authentication", outcome: "failure" },
		threshold: 5,
		windowMinutes: 10,
		severity: "critical",
	},
	{
		id: "force_push_default_branch",
		title: "Force push to a default branch",
		summary: "Fires when anyone rewrites the history of a GitHub repository's default branch.",
		filters: { provider: "github", action: "push.forced.default_branch" },
		threshold: 1,
		windowMinutes: 5,
		severity: "critical",
	},
	{
		id: "force_push_non_author",
		title: "Force push to someone else's pull request",
		summary: "Fires when someone rewrites a GitHub pull request branch they did not open.",
		filters: { provider: "github", action: "push.forced.non_author" },
		threshold: 1,
		windowMinutes: 5,
		severity: "warning",
	},
]

/** The template a URL names, if this build has it. */
export const templateOf = (id: string | undefined): Option.Option<DetectionTemplate> =>
	Arr.findFirst(DETECTION_TEMPLATES, (template) => template.id === id)
