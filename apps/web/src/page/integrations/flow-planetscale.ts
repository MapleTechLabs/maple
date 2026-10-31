import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import {
	derivePlanetScaleSetup,
	type InventoryCounts,
} from "../../components/integrations/planetscale-setup-steps"
import { isExcluded } from "../../components/infra/planetscale/branch-selection"
import { fold } from "./derive"
import type { FlowSpec } from "./flow"
import type { Model } from "./model"
import { parsePatternList } from "./planetscale"

// PlanetScale's place in the connect flow: authorize (and optionally a metrics token), pick the
// organization and branches, then Go live.

export const planetscaleStatusOf = (model: Model): V2PlanetScaleIntegration | null =>
	fold(
		model.statuses.planetscale,
		(data): V2PlanetScaleIntegration | null => data,
		() => null,
	)

/** The inventory's databases and branches, once it has loaded. */
export const inventoryCountsOf = (model: Model): InventoryCounts | null => {
	const inventory = model.statuses.planetscaleDatabases.data
	return AsyncData.isSuccess(inventory) || AsyncData.isRefreshing(inventory)
		? {
				databases: inventory.data.databases.length,
				branches: inventory.data.databases.reduce((sum, db) => sum + db.branches.length, 0),
			}
		: null
}

/** The grant can't be used: revoked, or missing read_databases. */
export const isAccessBlocked = (status: V2PlanetScaleIntegration): boolean =>
	status.revoked_at !== null || status.detected_permissions?.readDatabases === false

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((value, index) => value === b[index])

/** The picker differs from the saved binding, so Continue waits for Save. */
export const hasUnsavedChoice = (model: Model, status: V2PlanetScaleIntegration): boolean => {
	const card = model.planetscaleCard
	return (
		card.selectedOrg !== status.organization ||
		!sameList(
			parsePatternList(card.includeBranches.value),
			status.scrape_target?.include_branches ?? [],
		) ||
		!sameList(parsePatternList(card.excludeBranches.value), status.scrape_target?.exclude_branches ?? [])
	)
}

/** Branches the saved globs keep, over the inventory's branch names. */
export const matchedBranches = (
	model: Model,
	status: V2PlanetScaleIntegration,
): Readonly<{ kept: number; total: number }> | null => {
	const inventory = model.statuses.planetscaleDatabases.data
	if (!AsyncData.isSuccess(inventory) && !AsyncData.isRefreshing(inventory)) return null
	const names = inventory.data.databases.flatMap((db) => db.branches.map((branch) => branch.name))
	const include = status.scrape_target?.include_branches ?? []
	const exclude = status.scrape_target?.exclude_branches ?? []
	return {
		kept: names.filter((name) => !isExcluded(name, include, exclude)).length,
		total: names.length,
	}
}

/** Choose data's answer: the bound organization and how much of it Maple collects. */
export const planetscaleChoice = (model: Model, status: V2PlanetScaleIntegration): string => {
	const counts = inventoryCountsOf(model)
	const matched = matchedBranches(model, status)
	return counts === null || matched === null
		? (status.organization ?? "Organization picked")
		: `${countLabel(counts.databases, "database")}, ${countLabel(matched.kept, "branch", "branches")}`
}

export const planetscaleFlow = (model: Model): FlowSpec => {
	const status = planetscaleStatusOf(model)
	const card = model.planetscaleCard
	const blocked = status !== null && isAccessBlocked(status)
	const connected =
		status === null || blocked
			? null
			: status.connected
				? (status.organization ?? "Authorized")
				: status.pending_org_selection
					? "Authorized"
					: null
	const unsaved = status !== null && hasUnsavedChoice(model, status)
	const chosen =
		status !== null && status.connected && !blocked && !unsaved ? planetscaleChoice(model, status) : null
	const live =
		status === null || !status.connected ? "pending" : derivePlanetScaleSetup(status, model.nowMs).live
	return {
		stages: ["connect", "choose", "live"],
		connected,
		chosen,
		live,
		hint: {
			connect: model.connect.isStarting
				? "Waiting for you to approve in PlanetScale."
				: blocked
					? "Fix the authorization to continue."
					: connected === null
						? "Authorize PlanetScale to continue."
						: "Authorized. Next, choose data.",
			choose: card.isSelecting
				? "Saving the selection."
				: chosen !== null
					? "Saved. Next, go live."
					: card.selectedOrg === null
						? "Pick an organization to continue."
						: "Save the selection to continue.",
			live:
				live === "healthy"
					? "Live. Maple collects branch metrics on its own."
					: "Saved. Safe to leave while collection starts.",
		},
	}
}
