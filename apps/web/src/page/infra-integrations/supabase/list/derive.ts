import type { SupabaseAdvisorLint } from "@maple/domain/http"
import { healthReason, projectHealth, type ProjectHealth } from "../health"
import type { SupabaseFleetInsights, SupabaseProjectRow, SupabaseStatus } from "../model"
import { Array as Arr } from "effect"

// The pure half of the overview: discovery, metrics and health joined per project.

/**
 * - `collecting`: metrics in this window.
 * - `waiting`: switched on, nothing scraped in this window yet.
 * - `off`: "Collect metrics" is off for this project.
 */
export type Collection = "collecting" | "waiting" | "off"

export interface ProjectView {
	readonly ref: string
	readonly displayName: string
	readonly region: string
	readonly health: ProjectHealth
	readonly collection: Collection
	readonly metricsEnabled: boolean
	readonly logsEnabled: boolean
	readonly metrics: SupabaseProjectRow | null
}

/** Every discovered project, plus any that still has metrics but left discovery. */
export const projectViews = (
	status: SupabaseStatus,
	rows: ReadonlyArray<SupabaseProjectRow>,
): ReadonlyArray<ProjectView> => {
	const byRef = new Map(Arr.map(rows, (row) => [row.projectRef, row]))
	const known = new Set<string>(Arr.map(status.projects, (project) => project.ref))
	const discovered = Arr.map(status.projects, (project): ProjectView => {
		const metrics = byRef.get(project.ref) ?? null
		return {
			ref: project.ref,
			displayName: project.name || project.ref,
			region: project.region,
			health: projectHealth(project.status, metrics, false),
			collection: metrics !== null ? "collecting" : project.metricsEnabled ? "waiting" : "off",
			metricsEnabled: project.metricsEnabled,
			logsEnabled: project.logsEnabled,
			metrics,
		}
	})
	const orphaned = Arr.map(
		Arr.filter(rows, (row) => !known.has(row.projectRef)),
		(row): ProjectView => ({
			ref: row.projectRef,
			displayName: row.projectRef,
			region: "",
			health: projectHealth(null, row, false),
			collection: "collecting",
			metricsEnabled: true,
			logsEnabled: row.requests > 0 || row.issueCount > 0,
			metrics: row,
		}),
	)
	return [...discovered, ...orphaned]
}

/** The four tiles above the table. */
export const fleetSummary = (projects: ReadonlyArray<ProjectView>) => {
	const rows = Arr.flatMap(projects, (project) => (project.metrics === null ? [] : [project.metrics]))
	const sum = (pick: (row: SupabaseProjectRow) => number) =>
		Arr.reduce(rows, 0, (total, row) => total + pick(row))
	const requests = sum((row) => row.requests)
	const errors5xx = sum((row) => row.errors5xx)
	const unhealthy = Arr.flatMap(projects, (project) => {
		const reason = healthReason(project.displayName, project.health)
		return reason === null ? [] : [reason]
	})
	return {
		total: projects.length,
		healthy: Arr.filter(projects, (project) => project.health._tag === "Healthy").length,
		/** Projects with no metrics row to judge, neither healthy nor unhealthy. */
		unknown: Arr.filter(projects, (project) => project.health._tag === "Unknown").length,
		/** Why the first unhealthy project is not healthy, `null` when all are. */
		firstReason: unhealthy[0] ?? null,
		unhealthyCount: unhealthy.length,
		requests,
		requestsPerMinute: sum((row) => row.requestsPerMinute),
		errorRate5xx: requests > 0 ? errors5xx / requests : 0,
		issues: sum((row) => row.issueCount),
		issueProjects: Arr.filter(rows, (row) => row.issueCount > 0).length,
		dbSize: sum((row) => row.dbSize),
		databases: Arr.filter(rows, (row) => row.dbSize > 0).length,
		hasLogs: Arr.some(projects, (project) => project.logsEnabled),
	}
}

export interface AdvisorFinding {
	readonly lint: SupabaseAdvisorLint
	readonly projectRef: string
	readonly projectName: string
}

const LEVEL_RANK = { ERROR: 0, WARN: 1, INFO: 2 } satisfies Record<SupabaseAdvisorLint["level"], number>

/** ERROR and WARN lints of every read project, errors first, each named by its project. */
export const advisorFindings = (
	fleet: SupabaseFleetInsights,
	names: ReadonlyMap<string, string>,
): ReadonlyArray<AdvisorFinding> =>
	Arr.flatMap(fleet.insights, (insights) =>
		Arr.map([...insights.advisors.error, ...insights.advisors.warn], (lint): AdvisorFinding => ({
			lint,
			projectRef: insights.projectRef,
			projectName: names.get(insights.projectRef) ?? insights.projectRef,
		})),
	).toSorted((a, b) => LEVEL_RANK[a.lint.level] - LEVEL_RANK[b.lint.level])

/** Whether any read project's advisors have been checked at least once. */
export const advisorsChecked = (fleet: SupabaseFleetInsights): boolean =>
	Arr.some(fleet.insights, (insights) => insights.advisorsCheckedAt !== null)
