import type { DashboardDocument } from "@maple/domain/http"
import type { V2DashboardUpdateParams } from "@maple/domain/http/v2"

const differs = (before: unknown, after: unknown): boolean => JSON.stringify(before) !== JSON.stringify(after)

/**
 * Preserve edit intent across clients: a rename must not send the tab's older widget list.
 * Arrays remain replacements when actually edited; this does not merge concurrent widget edits.
 */
export const dashboardUpdateRequest = (
	before: DashboardDocument,
	after: DashboardDocument,
): V2DashboardUpdateParams => {
	const patch: { -readonly [K in keyof V2DashboardUpdateParams]: V2DashboardUpdateParams[K] } = {}
	if (before.name !== after.name) patch.name = after.name
	if ((before.description ?? null) !== (after.description ?? null))
		patch.description = after.description ?? null
	if (differs(before.tags ?? [], after.tags ?? [])) patch.tags = after.tags ?? []
	if (differs(before.timeRange, after.timeRange)) patch.timeRange = after.timeRange
	if (differs(before.widgets, after.widgets)) patch.widgets = after.widgets
	if (differs(before.sections ?? [], after.sections ?? [])) patch.sections = after.sections ?? []
	if (differs(before.variables ?? [], after.variables ?? [])) patch.variables = after.variables ?? []
	if ((before.refreshIntervalSeconds ?? null) !== (after.refreshIntervalSeconds ?? null))
		patch.refreshIntervalSeconds = after.refreshIntervalSeconds ?? null
	return patch
}
