import type { RailwayIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { fold } from "./derive"
import type { FlowSpec } from "./flow"
import type { Model } from "./model"
import { unsyncedEnvironments } from "./railway"

// Railway's place in the connect flow: a token, then Go live. Railway has no project filter yet.

/** The token's reach once it works: its workspace, else how much it sees. */
export const railwayReach = (status: RailwayIntegrationStatus): string =>
	status.workspaceNames !== null && status.workspaceNames !== ""
		? `Workspace ${status.workspaceNames}`
		: countLabel(status.environments.length, "environment")

export const railwayFlow = (model: Model): FlowSpec => {
	const status = fold(
		model.statuses.railway,
		(data): RailwayIntegrationStatus | null => data,
		() => null,
	)
	const connected = status !== null && status.connected && !status.authFailed ? railwayReach(status) : null
	const failing = status?.environments.filter((environment) => environment.lastError !== null).length ?? 0
	const live =
		status === null || !status.connected
			? "pending"
			: status.authFailed || failing > 0
				? "attention"
				: unsyncedEnvironments(status) > 0 || status.lastSyncedAt === null
					? "pending"
					: "healthy"
	return {
		stages: ["connect", "live"],
		connected,
		chosen: null,
		live,
		hint: {
			connect: model.railwayCard.connect.isSubmitting
				? "Waiting for the check to finish."
				: connected === null
					? "Paste a token to continue."
					: "Token checked. Next, go live.",
			choose: "",
			live:
				live === "healthy"
					? "Live. Maple syncs every 5 minutes."
					: live === "attention"
						? "Saved, but Railway is failing. Fix the token or the environment below."
						: "Saved. Safe to leave while the backfill runs.",
		},
	}
}
