import type { DependencyScanMatchRow, DependencyScanRow } from "@maple/db/tables"
import type { DependencyRelation } from "@maple/domain/dependency-scan"
import type { GitCommitSha, VcsRepositoryId } from "@maple/domain/http"
import type { AdvisorySeverity } from "@maple/domain/package-advisories"

// Which findings the code running in production carries, and how the findings rank by it. Pure:
// the service reads the running commits, their scans and matches, and hands them in.

/** One service serving traffic from a commit of a connected repository. */
export interface RunningService {
	readonly repositoryId: VcsRepositoryId
	readonly commitSha: GitCommitSha
	readonly serviceName: string
	readonly environment: string
	readonly spanCount: number
}

export interface FindingKeyFields {
	readonly repositoryId: VcsRepositoryId
	readonly lockfilePath: string
	readonly ecosystem: string
	readonly packageName: string
	readonly advisoryId: string
}

export const findingKey = (finding: FindingKeyFields): string =>
	[
		finding.repositoryId,
		finding.lockfilePath,
		finding.ecosystem,
		finding.packageName,
		finding.advisoryId,
	].join("\u0000")

const commitKey = (repositoryId: string, commitSha: string) => `${repositoryId}@${commitSha}`

/** The latest scan per (repository, commit), from scans listed newest first. */
export const latestScanPerCommit = (
	scans: ReadonlyArray<DependencyScanRow>,
): ReadonlyMap<string, DependencyScanRow> =>
	scans.reduce((latest, scan) => {
		const key = commitKey(scan.repositoryId, scan.commitSha)
		if (!latest.has(key)) latest.set(key, scan)
		return latest
	}, new Map<string, DependencyScanRow>())

/** The latest completed scan per (repository, commit): what the matches come from. */
export const latestCompletedPerCommit = (
	scans: ReadonlyArray<DependencyScanRow>,
): ReadonlyMap<string, DependencyScanRow> =>
	latestScanPerCommit(scans.filter((scan) => scan.status === "completed"))

/** A failed or stuck scan is retried once it is this old, so one bad read does not stick. */
export const RESCAN_AFTER_MS = 60 * 60 * 1000

/** Whether a running commit should be scanned: never scanned, or its last scan failed or stalled. */
export const needsScan = (
	latest: ReadonlyMap<string, DependencyScanRow>,
	running: Pick<RunningService, "repositoryId" | "commitSha">,
	nowMs: number,
): boolean => {
	const scan = scanAt(latest, running)
	if (scan === undefined) return true
	return scan.status !== "completed" && nowMs - scan.startedAt > RESCAN_AFTER_MS
}

export const scanAt = (
	latest: ReadonlyMap<string, DependencyScanRow>,
	running: Pick<RunningService, "repositoryId" | "commitSha">,
): DependencyScanRow | undefined => latest.get(commitKey(running.repositoryId, running.commitSha))

/**
 * The running services per finding key: a service counts when the latest completed scan of the
 * commit it runs (`completed`, from `latestCompletedPerCommit`) matched the finding. Busiest first.
 */
export function productionByFinding(
	running: ReadonlyArray<RunningService>,
	completed: ReadonlyMap<string, DependencyScanRow>,
	matches: ReadonlyArray<DependencyScanMatchRow>,
): ReadonlyMap<string, ReadonlyArray<RunningService>> {
	const scanById = new Map([...completed.values()].map((scan) => [scan.id, scan]))
	const servicesByCommit = running.reduce((byCommit, service) => {
		const key = commitKey(service.repositoryId, service.commitSha)
		byCommit.set(key, [...(byCommit.get(key) ?? []), service])
		return byCommit
	}, new Map<string, ReadonlyArray<RunningService>>())
	const byFinding = matches.reduce((acc, match) => {
		const scan = scanById.get(match.scanId)
		if (scan === undefined) return acc
		const key = findingKey({ ...match, repositoryId: scan.repositoryId })
		const services = servicesByCommit.get(commitKey(scan.repositoryId, scan.commitSha)) ?? []
		const known = acc.get(key) ?? []
		const added = services.filter(
			(service) =>
				!known.some(
					(other) =>
						other.serviceName === service.serviceName &&
						other.environment === service.environment &&
						other.commitSha === service.commitSha,
				),
		)
		acc.set(key, [...known, ...added])
		return acc
	}, new Map<string, ReadonlyArray<RunningService>>())
	return new Map(
		[...byFinding].map(([key, services]) => [
			key,
			[...services].sort((a, b) => b.spanCount - a.spanCount),
		]),
	)
}

const SEVERITY_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1, unknown: 1 } satisfies Record<
	AdvisorySeverity,
	number
>

/** A dev-only dependency rarely ships; a direct one is the team's own choice to upgrade. */
const RELATION_WEIGHT = { direct: 1.5, transitive: 1, unknown: 1, dev: 0.25 } satisfies Record<
	DependencyRelation,
	number
>

/**
 * How urgent a finding is: its severity, how the code depends on the package, and the traffic of
 * the services running it. A finding in production outranks the same one that is not deployed.
 */
export const riskScore = (
	finding: { readonly severity: AdvisorySeverity; readonly relation: DependencyRelation },
	productionSpans: number,
): number =>
	SEVERITY_WEIGHT[finding.severity] *
	RELATION_WEIGHT[finding.relation] *
	(productionSpans > 0 ? 2 + Math.log10(1 + productionSpans) : 1)
