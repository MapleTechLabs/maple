import type {
	VercelDrainStatus,
	VercelIntegrationStatus,
	VercelProjectScope,
	VercelSettingsRequest,
} from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr, String as Str } from "effect"

/** What the drains forward: the editable part of a connection. */
export interface VercelDraft {
	readonly projectScope: VercelProjectScope
	readonly projectIds: ReadonlyArray<string>
	readonly samplingRate: number
	readonly logsEnabled: boolean
	readonly tracesEnabled: boolean
	readonly aiGatewayEnabled: boolean
	readonly speedInsightsEnabled: boolean
	readonly webAnalyticsEnabled: boolean
	readonly auditLogEnabled: boolean
}

/** The drains Maple can install: the switch, the drain's status key, its name in a sentence and on Vercel. */
export const VERCEL_DRAINS = [
	{ flag: "logsEnabled", key: "logs", name: "logs", drain: "Maple logs" },
	{ flag: "tracesEnabled", key: "traces", name: "traces", drain: "Maple traces" },
	{ flag: "aiGatewayEnabled", key: "aiGateway", name: "AI Gateway", drain: "Maple AI Gateway" },
	{
		flag: "speedInsightsEnabled",
		key: "speedInsights",
		name: "Speed Insights",
		drain: "Maple Speed Insights",
	},
	{ flag: "webAnalyticsEnabled", key: "webAnalytics", name: "Web Analytics", drain: "Maple Web Analytics" },
	{ flag: "auditLogEnabled", key: "auditLog", name: "audit log", drain: "Maple audit log" },
] as const

export type VercelDrainFlag = (typeof VERCEL_DRAINS)[number]["flag"]

/** Logs, traces and AI Gateway by default; the others cost extra or need a plan the team may lack. */
export const DEFAULT_VERCEL_DRAFT: VercelDraft = {
	projectScope: "all",
	projectIds: [],
	samplingRate: 1,
	logsEnabled: true,
	tracesEnabled: true,
	aiGatewayEnabled: true,
	speedInsightsEnabled: false,
	webAnalyticsEnabled: false,
	auditLogEnabled: false,
}

/** The sampling choices offered; Vercel accepts any rate in 0.01–1. */
export const VERCEL_SAMPLING_RATES = [1, 0.5, 0.25, 0.1, 0.05, 0.01] as const

export const samplingLabel = (rate: number): string =>
	rate >= 1 ? "Everything" : `${Math.round(rate * 100)}% of events`

export const draftOf = (status: VercelIntegrationStatus): VercelDraft => ({
	projectScope: status.projectScope,
	projectIds: status.projectIds,
	samplingRate: status.samplingRate,
	logsEnabled: status.logsEnabled,
	tracesEnabled: status.tracesEnabled,
	aiGatewayEnabled: status.aiGatewayEnabled,
	speedInsightsEnabled: status.speedInsightsEnabled,
	webAnalyticsEnabled: status.webAnalyticsEnabled,
	auditLogEnabled: status.auditLogEnabled,
})

/** A draft Maple can apply: something to forward, and at least one project when picking. */
export const draftProblem = (draft: VercelDraft): string | null =>
	!Arr.some(VERCEL_DRAINS, ({ flag }) => draft[flag])
		? "Turn on at least one drain."
		: draft.projectScope === "some" && draft.projectIds.length === 0
			? "Pick at least one project."
			: null

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && Arr.every(a, (id) => b.includes(id))

/** A settings change: only the fields the admin touched. */
export type VercelSettingsPatch = { -readonly [K in keyof VercelSettingsRequest]?: VercelSettingsRequest[K] }

/** Only the fields that changed, so the PATCH says what the admin touched. */
export function settingsPatch(saved: VercelDraft, draft: VercelDraft): VercelSettingsPatch {
	const patch: VercelSettingsPatch = {}
	if (draft.projectScope !== saved.projectScope) patch.projectScope = draft.projectScope
	if (
		draft.projectScope === "some" &&
		(saved.projectScope !== "some" || !sameIds(draft.projectIds, saved.projectIds))
	) {
		patch.projectIds = draft.projectIds
	}
	if (draft.samplingRate !== saved.samplingRate) patch.samplingRate = draft.samplingRate
	for (const { flag } of VERCEL_DRAINS) {
		if (draft[flag] !== saved[flag]) patch[flag] = draft[flag]
	}
	return patch
}

/**
 * What saving the draft stops, as short lines for the confirmation. Empty when nothing stops:
 * adding projects, raising sampling or switching a signal on needs no confirmation.
 */
export function stoppedByDraft(
	saved: VercelDraft,
	draft: VercelDraft,
	projectNames: ReadonlyMap<string, string>,
): ReadonlyArray<string> {
	const stops: Array<string> = []
	for (const { flag, name, drain } of VERCEL_DRAINS) {
		if (saved[flag] && !draft[flag]) stops.push(`${Str.capitalize(name)}: the ${drain} drain is deleted`)
	}
	if (draft.projectScope === "some") {
		const dropped =
			saved.projectScope === "all"
				? Arr.filter([...projectNames.keys()], (id) => !draft.projectIds.includes(id))
				: Arr.filter(saved.projectIds, (id) => !draft.projectIds.includes(id))
		if (dropped.length > 0) {
			const names = Arr.map(dropped, (id) => projectNames.get(id) ?? id)
			stops.push(
				names.length <= 3
					? `Projects no longer forwarded: ${Arr.join(names, ", ")}`
					: `${names.length} projects no longer forwarded`,
			)
		}
	}
	if (draft.samplingRate < saved.samplingRate) {
		stops.push(`Sampling drops to ${Math.round(draft.samplingRate * 100)}% of events`)
	}
	return stops
}

export type VercelHealth = "healthy" | "attention" | "pending"

export interface VercelIssue {
	readonly key: string
	readonly tone: "crit" | "warn"
	readonly title: string
	/** What it means and what fixes it. */
	readonly description: string
	/** Vercel's own reason, when it gave one. */
	readonly vercelError: string | null
	/** What fixes it from the card. */
	readonly fix: "token" | "reapply"
}

/** What went wrong with a drain and how re-applying helps, or null when it is fine or not checked yet. */
function drainProblem(
	drain: VercelDrainStatus | null,
): { readonly problem: string; readonly description: string } | null {
	if (drain === null || drain.status === "missing") {
		return {
			problem: drain === null ? "is missing on Vercel" : "was deleted on Vercel",
			description: "Re-applying the settings creates it again on Vercel.",
		}
	}
	switch (drain.status) {
		case "errored":
			// No id: Vercel would not create it.
			return drain.id === null
				? {
						problem: "was refused by Vercel",
						description:
							"Vercel would not create it, usually because the team's plan or the project lacks the product. Turn the product on in Vercel and re-apply the settings, or switch the drain off.",
					}
				: {
						problem: "is failing on Vercel",
						description:
							"Vercel can't deliver to Maple, usually because the ingest key changed. Re-applying the settings sends Maple's current ingest key to the drain.",
					}
		case "disabled":
			return {
				problem: "is disabled on Vercel",
				description:
					"Re-applying the settings sends Maple's current ingest key to the drain. If it stays disabled, turn it on in the team's drain settings.",
			}
		default:
			return null
	}
}

/** Problems worth an alert, worst first. */
export function vercelIssues(status: VercelIntegrationStatus): ReadonlyArray<VercelIssue> {
	if (status.authFailed) {
		return [
			{
				key: "token",
				tone: "crit",
				title: "Vercel rejected the saved token",
				description:
					"Maple can't check, fix or remove the drains, or read deployments, until a new token is pasted.",
				vercelError: null,
				fix: "token",
			},
		]
	}
	const issues: Array<VercelIssue> = []
	for (const { flag, key, name } of VERCEL_DRAINS) {
		if (!status[flag]) continue
		const drain = status.drains[key]
		const found = drainProblem(drain)
		if (found === null) continue
		issues.push({
			key: Str.capitalize(name),
			tone: "warn",
			title: `The ${name} drain ${found.problem}`,
			description: found.description,
			vercelError: drain?.lastError ?? null,
			fix: "reapply",
		})
	}
	return issues
}

export function vercelHealth(status: VercelIntegrationStatus): VercelHealth {
	if (vercelIssues(status).length > 0) return "attention"
	return status.lastSuccessAt === null ? "pending" : "healthy"
}

export type VercelTone = "ok" | "warn" | "crit" | "neutral"

/** The page header's chip: a rejected token first, then the drains that need attention, then the first sync. */
export function vercelHealthChip(status: VercelIntegrationStatus): { readonly label: string; readonly tone: VercelTone } {
	if (status.authFailed) return { label: "Token rejected", tone: "crit" }
	const issues = vercelIssues(status).length
	if (issues > 0)
		return {
			label: `Connected · ${countLabel(issues, "drain")} ${issues === 1 ? "needs" : "need"} attention`,
			tone: "warn",
		}
	return status.lastSuccessAt === null
		? { label: "First sync pending", tone: "neutral" }
		: { label: "Connected", tone: "ok" }
}

/** One drain's state as the signal table shows it: off, live, or what Vercel reports wrong with it. */
export function drainState(
	enabled: boolean,
	drain: VercelDrainStatus | null,
): { readonly label: string; readonly tone: VercelTone } {
	if (!enabled) return { label: "off", tone: "neutral" }
	if (drain === null) return { label: "missing on Vercel", tone: "crit" }
	switch (drain.status) {
		case "enabled":
			return { label: "live", tone: "ok" }
		case "disabled":
			return { label: "disabled on Vercel", tone: "warn" }
		case "errored":
			return { label: drain.lastError === null ? "errored" : `errored: ${drain.lastError}`, tone: "crit" }
		case "missing":
			return { label: "missing on Vercel", tone: "crit" }
		case "unknown":
			return { label: "not checked yet", tone: "neutral" }
	}
}

/** "Logs, traces and AI Gateway" / "Logs and traces" / "AI Gateway" / … */
export const signalsLabel = (draft: Pick<VercelDraft, VercelDrainFlag>): string => {
	const names = Arr.flatMap(VERCEL_DRAINS, ({ flag, name }) => (draft[flag] ? [name] : []))
	const last = names.pop() ?? ""
	return Str.capitalize(names.length === 0 ? last : `${Arr.join(names, ", ")} and ${last}`)
}

export const scopeLabel = (status: VercelIntegrationStatus): string =>
	status.projectScope === "all"
		? "All projects"
		: `${status.projectIds.length} of ${status.projects.length} projects`

/** A Vercel deployment state (`READY`, `ERROR`, `BUILDING`, …) as a status tone. */
export function deploymentTone(state: string): "ok" | "crit" | "info" | "neutral" {
	switch (Str.toUpperCase(state)) {
		case "READY":
			return "ok"
		case "ERROR":
			return "crit"
		case "BUILDING":
		case "INITIALIZING":
		case "QUEUED":
			return "info"
		default:
			return "neutral"
	}
}

/** "Ready", "Building", … from Vercel's upper-case state. */
export const deploymentStateLabel = (state: string): string =>
	state.length === 0 ? "Unknown" : Str.capitalize(Str.toLowerCase(state))

/** Share as a percentage, or null without a denominator. */
export const percentOf = (part: number, whole: number): number | null =>
	whole > 0 ? (part / whole) * 100 : null
