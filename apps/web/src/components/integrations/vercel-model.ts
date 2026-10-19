import type {
	VercelDrainStatus,
	VercelIntegrationStatus,
	VercelProjectScope,
	VercelSettingsRequest,
} from "@maple/domain/http"

/** What the drains forward: the editable part of a connection. */
export interface VercelDraft {
	readonly projectScope: VercelProjectScope
	readonly projectIds: ReadonlyArray<string>
	readonly samplingRate: number
	readonly logsEnabled: boolean
	readonly tracesEnabled: boolean
}

export const DEFAULT_VERCEL_DRAFT: VercelDraft = {
	projectScope: "all",
	projectIds: [],
	samplingRate: 1,
	logsEnabled: true,
	tracesEnabled: true,
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
})

/** A draft Maple can apply: something to forward, and at least one project when picking. */
export const draftProblem = (draft: VercelDraft): string | null =>
	!draft.logsEnabled && !draft.tracesEnabled
		? "Forward logs, traces or both."
		: draft.projectScope === "some" && draft.projectIds.length === 0
			? "Pick at least one project."
			: null

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && a.every((id) => b.includes(id))

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
	if (draft.logsEnabled !== saved.logsEnabled) patch.logsEnabled = draft.logsEnabled
	if (draft.tracesEnabled !== saved.tracesEnabled) patch.tracesEnabled = draft.tracesEnabled
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
	if (saved.logsEnabled && !draft.logsEnabled) stops.push("Logs: the Maple logs drain is deleted")
	if (saved.tracesEnabled && !draft.tracesEnabled) stops.push("Traces: the Maple traces drain is deleted")
	if (draft.projectScope === "some") {
		const dropped =
			saved.projectScope === "all"
				? [...projectNames.keys()].filter((id) => !draft.projectIds.includes(id))
				: saved.projectIds.filter((id) => !draft.projectIds.includes(id))
		if (dropped.length > 0) {
			const names = dropped.map((id) => projectNames.get(id) ?? id)
			stops.push(
				names.length <= 3
					? `Projects no longer forwarded: ${names.join(", ")}`
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
	readonly detail: string | null
	/** What fixes it from the card. */
	readonly fix: "token" | "reapply" | null
}

/** What went wrong with a drain Vercel reports, or null when it is fine or not checked yet. */
function drainProblem(status: VercelDrainStatus["status"]): string | null {
	switch (status) {
		case "missing":
			return "was deleted on Vercel"
		case "errored":
			return "is failing on Vercel"
		case "disabled":
			return "is disabled on Vercel"
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
				detail: "Maple stopped checking the drains and deployments. Drains keep delivering until the token's access ends.",
				fix: "token",
			},
		]
	}
	const issues: Array<VercelIssue> = []
	const drains = [
		["Logs", status.logsEnabled, status.drains.logs],
		["Traces", status.tracesEnabled, status.drains.traces],
	] as const
	for (const [name, enabled, drain] of drains) {
		if (!enabled) continue
		const problem = drain === null ? "is missing on Vercel" : drainProblem(drain.status)
		if (problem === null) continue
		issues.push({
			key: name,
			tone: "warn",
			title: `The ${name.toLowerCase()} drain ${problem}`,
			detail: drain?.lastError ?? null,
			fix: "reapply",
		})
	}
	return issues
}

export function vercelHealth(status: VercelIntegrationStatus): VercelHealth {
	if (vercelIssues(status).length > 0) return "attention"
	return status.lastSuccessAt === null ? "pending" : "healthy"
}

/** "Logs and traces" / "Logs" / "Traces". */
export const signalsLabel = (draft: Pick<VercelDraft, "logsEnabled" | "tracesEnabled">): string =>
	draft.logsEnabled && draft.tracesEnabled ? "Logs and traces" : draft.logsEnabled ? "Logs" : "Traces"

export const scopeLabel = (status: VercelIntegrationStatus): string =>
	status.projectScope === "all"
		? "All projects"
		: `${status.projectIds.length} of ${status.projects.length} projects`

/** A Vercel deployment state (`READY`, `ERROR`, `BUILDING`, …) as a status tone. */
export function deploymentTone(state: string): "ok" | "crit" | "info" | "neutral" {
	switch (state.toUpperCase()) {
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
	state.length === 0 ? "Unknown" : state.charAt(0).toUpperCase() + state.slice(1).toLowerCase()

/** Share as a percentage, or null without a denominator. */
export const percentOf = (part: number, whole: number): number | null =>
	whole > 0 ? (part / whole) * 100 : null
