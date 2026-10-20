// Pure models behind /infra/vercel: the projects list joins the connection's inventory (names,
// frameworks, deployments) with what the drains delivered in the window.

import type {
	VercelAiGatewayBucket,
	VercelDeploymentSummary,
	VercelInfraProject,
	VercelInfraRequestBucket,
	VercelProjectStatus,
} from "@maple/domain/http"
import { quoteWhereValue } from "@maple/domain/where-clause"
import { toEpochMs } from "@maple/ui/lib/time-format"

import { percentOf } from "@/components/integrations/vercel-model"
import { encodeLogAttributeFilter } from "@/lib/logs/log-attribute-filters"

export interface VercelProjectRow {
	readonly projectId: string
	readonly name: string
	readonly framework: string | null
	readonly production: VercelDeploymentSummary | null
	readonly requests: number
	readonly requests5xx: number
	/** 5xx share of requests, 0–100; null without requests. */
	readonly errorPercent: number | null
	/** Cache hits over cache lookups, 0–100; null when nothing was looked up. */
	readonly cacheHitPercent: number | null
	/** Null when the project sends no deployment traces. */
	readonly p95DurationMs: number | null
	readonly errorLogs: number
	/** ISO-8601; null when nothing arrived in the window. */
	readonly lastSeen: string | null
}

const toRow = (
	projectId: string,
	name: string,
	status: VercelProjectStatus | undefined,
	row: VercelInfraProject | undefined,
): VercelProjectRow => ({
	projectId,
	name,
	framework: status?.framework ?? null,
	production: status?.productionDeployment ?? null,
	requests: row?.requests ?? 0,
	requests5xx: row?.requests5xx ?? 0,
	errorPercent: row === undefined ? null : percentOf(row.requests5xx, row.requests),
	cacheHitPercent: row === undefined ? null : percentOf(row.cacheHits, row.cacheLookups),
	p95DurationMs: row?.p95DurationMs ?? null,
	errorLogs: row?.errorLogs ?? 0,
	lastSeen: row?.lastSeen ?? null,
})

/**
 * Every forwarded project, with or without data in the window, plus any project that delivered
 * data the inventory does not list (not synced yet, or deleted on Vercel). Busiest first.
 */
export function vercelProjectRows(
	projects: ReadonlyArray<VercelProjectStatus>,
	rows: ReadonlyArray<VercelInfraProject>,
): ReadonlyArray<VercelProjectRow> {
	const rowById = new Map(rows.map((row) => [row.projectId, row]))
	const listed = projects
		.filter((project) => project.forwarded || rowById.has(project.id))
		.map((project) => toRow(project.id, project.name, project, rowById.get(project.id)))
	const known = new Set(projects.map((project) => project.id))
	const unlisted = rows
		.filter((row) => !known.has(row.projectId))
		.map((row) => toRow(row.projectId, row.projectName || row.projectId, undefined, row))
	return [...listed, ...unlisted].toSorted(
		(a, b) => b.requests - a.requests || a.name.localeCompare(b.name),
	)
}

/** One project's row for its own page: zeros when nothing arrived, its id when nothing names it. */
export function vercelProjectRow(
	projectId: string,
	projects: ReadonlyArray<VercelProjectStatus>,
	rows: ReadonlyArray<VercelInfraProject>,
): VercelProjectRow {
	const status = projects.find((project) => project.id === projectId)
	const row = rows.find((candidate) => candidate.projectId === projectId)
	return toRow(projectId, status?.name ?? (row?.projectName || projectId), status, row)
}

export interface VercelFleetTotals {
	readonly requests: number
	readonly requests5xx: number
	readonly errorPercent: number | null
	readonly cacheHitPercent: number | null
	readonly errorLogs: number
}

export function vercelFleetTotals(rows: ReadonlyArray<VercelInfraProject>): VercelFleetTotals {
	let requests = 0
	let requests5xx = 0
	let cacheHits = 0
	let cacheLookups = 0
	let errorLogs = 0
	for (const row of rows) {
		requests += row.requests
		requests5xx += row.requests5xx
		cacheHits += row.cacheHits
		cacheLookups += row.cacheLookups
		errorLogs += row.errorLogs
	}
	return {
		requests,
		requests5xx,
		errorPercent: percentOf(requests5xx, requests),
		cacheHitPercent: percentOf(cacheHits, cacheLookups),
		errorLogs,
	}
}

/**
 * The window's whole bucket grid, `toStartOfInterval`'s multiples of the bucket since the epoch.
 * The warehouse skips buckets with no records; for a drain that is a real zero, and a chart drawn
 * through only the buckets that exist bridges the silence. Buckets come back as `toISOString()`.
 * An empty series stays empty so a chart still says there is no data.
 */
export function fillBuckets<T extends { readonly bucket: string }>(
	rows: ReadonlyArray<T>,
	window: { readonly startTime: string; readonly endTime: string; readonly bucketSeconds: number },
	zero: (bucket: string) => T,
): ReadonlyArray<T> {
	if (rows.length === 0) return rows
	const stepMs = window.bucketSeconds * 1000
	const byMs = new Map(rows.map((row) => [toEpochMs(row.bucket), row]))
	const endMs = toEpochMs(window.endTime)
	const filled: T[] = []
	for (let ms = Math.floor(toEpochMs(window.startTime) / stepMs) * stepMs; ms < endMs; ms += stepMs) {
		const bucket = new Date(ms).toISOString()
		const row = byMs.get(ms)
		filled.push(row === undefined ? zero(bucket) : { ...row, bucket })
		byMs.delete(ms)
	}
	// A reading off the grid is still a reading.
	for (const [ms, row] of byMs) filled.push({ ...row, bucket: new Date(ms).toISOString() })
	return filled.toSorted((a, b) => a.bucket.localeCompare(b.bucket))
}

export const zeroRequestBucket = (bucket: string): VercelInfraRequestBucket => ({
	bucket,
	requests: 0,
	requests2xx: 0,
	requests3xx: 0,
	requests4xx: 0,
	requests5xx: 0,
	cacheHits: 0,
	errorLogs: 0,
})

export const zeroAiGatewayBucket = (bucket: string): VercelAiGatewayBucket => ({
	bucket,
	requests: 0,
	costUsd: 0,
	inputTokens: 0,
	outputTokens: 0,
	errors: 0,
})

/**
 * Long-form rows for the stacked status-class chart. A request without a status (a crashed
 * function, a revalidation) is `unknown`, so the stack still totals to every request.
 */
export function requestClassRows(
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
): ReadonlyArray<{ bucket: string; attributeValue: string; value: number }> {
	return buckets.flatMap((row) => {
		const classes = [
			["2xx", row.requests2xx],
			["3xx", row.requests3xx],
			["4xx", row.requests4xx],
			["5xx", row.requests5xx],
		] as const
		const classified = classes.reduce((sum, [, value]) => sum + value, 0)
		const unknown = row.requests - classified
		return [...classes, ...(unknown > 0 ? ([["unknown", unknown]] as const) : [])].map(
			([attributeValue, value]) => ({ bucket: row.bucket, attributeValue, value }),
		)
	})
}

const OUTSIDE_PROJECT_LABEL = "Outside a project"

/** An AI Gateway project id as the inventory names it. Requests made outside a project have none. */
export const aiGatewayProjectLabel = (projectId: string, names: ReadonlyMap<string, string>): string =>
	projectId === "" ? OUTSIDE_PROJECT_LABEL : (names.get(projectId) ?? projectId)

/** The logs explorer filter for one project: the log drain stamps `vercel.project.id` on the resource. */
export const vercelProjectLogAttrs = (projectId: string): ReadonlyArray<string> => [
	encodeLogAttributeFilter({
		source: "resource",
		key: "vercel.project.id",
		value: projectId,
		negated: false,
	}),
]

/** The traces explorer filter for one project: Vercel sets `vercel.projectId` on deployment traces. */
export const vercelProjectTracesWhere = (projectId: string): string =>
	`resource.vercel.projectId = ${quoteWhereValue(projectId)}`
