import { sortRowsByField, type Sort } from "../../../kit/table-sort"
import type { SupabaseProjectRow, SupabaseStatus } from "../model"
import type { SortKey } from "./model"

// The pure half of the project table: discovery and metrics joined per project.

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
	/** Supabase's lifecycle status, `null` for a project discovery no longer lists. */
	readonly status: string | null
	readonly collection: Collection
	readonly metrics: SupabaseProjectRow | null
	/** Sort values; -1 sorts a project without metrics below every measured one. */
	readonly peak: number
	readonly dbSize: number
	readonly connectionsMax: number
	readonly lastSeen: string
}

const NO_METRIC = -1

const metricsView = (metrics: SupabaseProjectRow | null) => ({
	peak: metrics === null ? NO_METRIC : Math.max(metrics.cpuMax, metrics.memoryMax, metrics.diskUsedMax),
	dbSize: metrics?.dbSize ?? NO_METRIC,
	connectionsMax: metrics?.connectionsMax ?? NO_METRIC,
	lastSeen: metrics?.lastSeen ?? "",
})

/** Every discovered project, plus any that still has metrics but left discovery. */
export const projectViews = (
	status: SupabaseStatus,
	rows: ReadonlyArray<SupabaseProjectRow>,
): ReadonlyArray<ProjectView> => {
	const byRef = new Map(rows.map((row) => [row.projectRef, row]))
	const known = new Set<string>(status.projects.map((project) => project.ref))
	const discovered = status.projects.map((project): ProjectView => {
		const metrics = byRef.get(project.ref) ?? null
		return {
			ref: project.ref,
			displayName: project.name || project.ref,
			region: project.region,
			status: project.status,
			collection: metrics !== null ? "collecting" : project.metricsEnabled ? "waiting" : "off",
			metrics,
			...metricsView(metrics),
		}
	})
	const orphaned = rows
		.filter((row) => !known.has(row.projectRef))
		.map((row): ProjectView => ({
			ref: row.projectRef,
			displayName: row.projectRef,
			region: "",
			status: null,
			collection: "collecting",
			metrics: row,
			...metricsView(row),
		}))
	return [...discovered, ...orphaned]
}

/** The search box: project name or ref contains the query. */
export const filterProjects = (
	projects: ReadonlyArray<ProjectView>,
	query: string,
): ReadonlyArray<ProjectView> => {
	const q = query.trim().toLowerCase()
	return q === ""
		? projects
		: projects.filter((project) => `${project.displayName} ${project.ref}`.toLowerCase().includes(q))
}

export const sortProjects = (
	projects: ReadonlyArray<ProjectView>,
	sort: Sort<SortKey>,
): ReadonlyArray<ProjectView> => sortRowsByField(projects, sort)

/** Headline numbers for the band above the table. */
export const fleetSummary = (projects: ReadonlyArray<ProjectView>) => ({
	total: projects.length,
	collecting: projects.filter((project) => project.collection === "collecting").length,
	waiting: projects.filter((project) => project.collection === "waiting").length,
	totalDbSize: projects.reduce((sum, project) => sum + (project.metrics?.dbSize ?? 0), 0),
	connections: projects.reduce((sum, project) => sum + (project.metrics?.connectionsAvg ?? 0), 0),
})
