import type { SupabaseIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import { fold } from "./derive"
import type { SupabaseProjectRow } from "../infra-integrations/supabase/model"
import type { FlowSpec, LiveHealth } from "./flow"
import type { Model } from "./model"

// Supabase's place in the connect flow: authorize an organization, pick projects and signals, go live.

type Project = SupabaseIntegrationStatus["projects"][number]

export const supabaseStatusOf = (model: Model): SupabaseIntegrationStatus | null =>
	fold(
		model.statuses.supabase,
		(data): SupabaseIntegrationStatus | null => data,
		() => null,
	)

/** The status while connected and the grant is still accepted, else null. */
export const reachableSupabase = (
	status: SupabaseIntegrationStatus | null,
): SupabaseIntegrationStatus | null =>
	status !== null && status.connected && !status.revoked ? status : null

export const supabaseOrgName = (status: SupabaseIntegrationStatus): string =>
	status.organization?.name ?? "Supabase"

/** A project collects something: metrics, polled logs or a drain. */
export const isCollecting = (project: Project): boolean =>
	project.metricsEnabled || project.logsEnabled || project.logDrainEnabled

/** Whether the switched-on signals have all reported, from the status and the last hour's metrics rows. */
export const supabaseLive = (model: Model, status: SupabaseIntegrationStatus | null): LiveHealth => {
	if (status === null || !status.connected) return "pending"
	const collecting = status.projects.filter(isCollecting)
	const broken = collecting.some(
		(project) =>
			(project.logDrainEnabled && project.logDrainError !== null) ||
			(project.logsEnabled && project.logsError !== null),
	)
	if (status.revoked || status.lastDiscoveryError !== null || broken) return "attention"
	const rows = AsyncData.getOrElse(
		model.supabaseCard.metrics.data,
		(): ReadonlyArray<SupabaseProjectRow> | null => null,
	)
	const metricsIn =
		rows !== null &&
		collecting
			.filter((project) => project.metricsEnabled)
			.every((project) => rows.some((row) => row.projectRef === project.ref && row.lastSeen !== ""))
	const logsIn = collecting.every((project) => !project.logsEnabled || project.logsLastPolledAt !== null)
	return collecting.length > 0 && metricsIn && logsIn ? "healthy" : "pending"
}

export const supabaseFlow = (model: Model): FlowSpec => {
	const status = supabaseStatusOf(model)
	const reachable = reachableSupabase(status)
	const connected = reachable === null ? null : supabaseOrgName(reachable)
	const collecting = reachable?.projects.filter(isCollecting).length ?? 0
	const chosen = collecting > 0 ? countLabel(collecting, "project") : null
	const live = supabaseLive(model, status)
	return {
		stages: ["connect", "choose", "live"],
		connected,
		chosen,
		live,
		hint: {
			connect:
				model.connect.active?.provider === "supabase"
					? "Waiting for Supabase."
					: reachable !== null
						? `${supabaseOrgName(reachable)} · ${countLabel(reachable.projects.length, "project")}`
						: status?.revoked === true
							? "Reconnect to continue."
							: "Authorize to continue.",
			choose:
				model.supabaseCard.pending.length > 0
					? "Saving the switch."
					: chosen === null
						? "Turn on at least one project to continue."
						: `${chosen} collecting.`,
			live:
				live === "healthy"
					? "Live. Metrics arrive every minute."
					: "Saved. Safe to leave while the first data arrives.",
		},
	}
}
