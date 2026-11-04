/**
 * The Security Center's four sources, read for the MCP tools and flattened onto one finding row so an
 * agent can rank code audit findings, vulnerable dependencies, served scanner probes and runtimes on
 * vulnerable or end-of-life versions against each other.
 */
import { DateTime, Effect, Option, Order, Array as Arr, String as Str } from "effect"
import type { SecurityAuditFindingRow, SecurityAuditRunRow, SecurityAuditTargetRow } from "@maple/db/tables"
import type { DependencyFindingView, DependencyScanRepository } from "@maple/domain/http"
import type { DependencyFindingId } from "@maple/domain/dependency-scan"
import type {
	SecurityArea,
	SecurityAuditRunSummary,
	SecurityFindingRow,
	SecurityRepositoryCoverage,
	SecuritySeverity,
} from "@maple/domain/mcp-outputs"
import { aiCreditsUsd } from "@maple/domain/billing"
import {
	advisoryKey,
	advisoryTargetOf,
	type RuntimeAdvisory,
	summarizeAdvisories,
} from "@maple/domain/runtime-advisories"
import {
	RUNTIME_PRODUCTS,
	type RuntimePosture,
	type RuntimeProduct,
	runtimePosture,
	runtimeProductOf,
} from "@maple/domain/runtime-posture"
import { PROBE_CATEGORIES, probeCategoryOf } from "@maple/domain/security-telemetry"
import { CH } from "@maple/query-engine"
import { truncate } from "./format"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { isAdmin } from "@maple/backend/services/auth/auth"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import {
	type SecurityAuditOrgStore,
	type SecurityAuditRunFindingCounts,
	SecurityAuditStore,
} from "@maple/backend/services/security-audit/SecurityAuditStore"
import {
	DependencyScanReader,
	FINDINGS_LIMIT,
} from "@maple/backend/services/dependency-scan/DependencyScanService"
import { RuntimeReleaseCatalog } from "@maple/backend/services/security/RuntimeReleaseCatalog"
import { RuntimeAdvisoryCatalog } from "@maple/backend/services/security/RuntimeAdvisoryCatalog"

export interface SecurityWindow {
	readonly startTime: string
	readonly endTime: string
}

/** Why an area has nothing to read, or could not be read. */
export type AreaGate =
	| { readonly _tag: "not_enabled"; readonly message: string }
	| { readonly _tag: "not_connected"; readonly message: string }
	| { readonly _tag: "forbidden"; readonly message: string }
	| { readonly _tag: "unavailable"; readonly message: string }

const isoOf = (ms: number): string => new Date(ms).toISOString()
const isoUtc = (value: DateTime.Utc): string => DateTime.formatIso(value)

export const SEVERITY_RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
	informational: 4,
	unknown: 5,
} satisfies Record<SecuritySeverity, number>

// ---------------------------------------------------------------------------------------------
// Code audit

export interface CodeTarget {
	readonly target: SecurityAuditTargetRow
	readonly latestRun: SecurityAuditRunRow | undefined
	readonly findings: ReadonlyArray<SecurityAuditFindingRow>
}

export type CodeRead = { readonly _tag: "read"; readonly targets: ReadonlyArray<CodeTarget> } | AreaGate

/** A lead is ranked by its estimate; one stored before the engine estimated reads as unknown. */
export const codeSeverityOf = (
	row: Pick<SecurityAuditFindingRow, "verdict" | "overallSeverity" | "estimatedSeverity">,
): SecuritySeverity =>
	row.verdict === "confirmed"
		? (row.overallSeverity ?? "unknown")
		: row.verdict === "needs_validation"
			? (row.estimatedSeverity ?? "unknown")
			: "informational"

/** Every target with its findings and latest run. Findings are admin-only, as in the dashboard. */
export const readCode = (tenant: TenantContext) =>
	Effect.gen(function* () {
		const flags = yield* (yield* OrganizationFeatureFlagsService).flags(tenant.orgId)
		if (!flags.securityAudit) {
			return {
				_tag: "not_enabled",
				message: "The code security audit is not enabled for this organization.",
			} satisfies CodeRead
		}
		if (!isAdmin(tenant.roles)) {
			return {
				_tag: "forbidden",
				message: "Only org admins can read code audit findings.",
			} satisfies CodeRead
		}
		const store = (yield* SecurityAuditStore).forOrg(tenant.orgId)
		const targets = yield* store.listTargets
		if (targets.length === 0) {
			return {
				_tag: "not_connected",
				message: "No repository is set up for the code audit (Security → Add target).",
			} satisfies CodeRead
		}
		const read = yield* Effect.forEach(
			targets,
			(target) =>
				Effect.all({
					findings: store.listFindings(target.id),
					runs: store.listRuns({ targetId: target.id, limit: 1 }),
				}).pipe(
					Effect.map(({ findings, runs }): CodeTarget => ({
						target,
						latestRun: runs[0],
						findings,
					})),
				),
			{ concurrency: 4 },
		)
		return { _tag: "read", targets: read } satisfies CodeRead
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("Security Center read failed", error).pipe(
				Effect.as<CodeRead>({
					_tag: "unavailable",
					message: `Could not read the code audit: ${error.message}`,
				}),
			),
		),
	)

/** The org's audit store once the audit is enabled; `admin` says whether findings may be read. */
export type AuditAccess =
	| { readonly _tag: "read"; readonly store: SecurityAuditOrgStore; readonly admin: boolean }
	| Extract<AreaGate, { readonly _tag: "not_enabled" }>

export const auditAccess = (tenant: TenantContext) =>
	Effect.gen(function* () {
		const flags = yield* (yield* OrganizationFeatureFlagsService).flags(tenant.orgId)
		if (!flags.securityAudit) {
			return {
				_tag: "not_enabled",
				message: "The code security audit is not enabled for this organization.",
			} satisfies AuditAccess
		}
		return {
			_tag: "read",
			store: (yield* SecurityAuditStore).forOrg(tenant.orgId),
			admin: isAdmin(tenant.roles),
		} satisfies AuditAccess
	})

/** A run as the tools show it; `counts` is absent for a caller who may not read findings. */
export const runSummaryOf = (
	run: SecurityAuditRunRow,
	target: Pick<SecurityAuditTargetRow, "repository" | "branch"> | undefined,
	counts: SecurityAuditRunFindingCounts | undefined,
): SecurityAuditRunSummary => ({
	runId: run.id,
	repository: target?.repository ?? "(deleted target)",
	branch: target?.branch ?? "",
	kind: run.kind,
	status: run.status,
	sourceRef: run.sourceRef,
	startedAt: isoOf(run.startedAt),
	finishedAt: run.finishedAt === null ? null : isoOf(run.finishedAt),
	durationMinutes: run.finishedAt === null ? null : Math.round((run.finishedAt - run.startedAt) / 60_000),
	stopReason: run.incompleteReason ?? run.error,
	agentInvocations: run.invocationsSpent,
	budget: run.budget,
	costUsd:
		run.costUsd === null ? null : Math.round((aiCreditsUsd(run.costUsd) + run.sandboxUsd) * 100) / 100,
	findings:
		counts === undefined
			? null
			: {
					critical: counts.critical,
					high: counts.high,
					medium: counts.medium,
					low: counts.low,
					informational: counts.informational,
					leads: counts.unverified + counts.needsValidation,
					rejected: counts.rejected,
				},
})

const firstLocation = (row: SecurityAuditFindingRow): string => {
	const sink = Option.getOrElse(
		Arr.findFirst(row.record.trace, (step) => step.kind === "sink"),
		() => row.record.trace[0],
	)
	const at = sink ?? row.record.evidence[0]
	return at === undefined ? "" : `${at.file}:${at.line}`
}

const VERDICT_DETAIL = {
	confirmed: "confirmed",
	needs_validation: "lead, not yet confirmed (severity estimated)",
	rejected: "rejected: disproved by the verifier",
} as const

/** The run that stopped finding it: its commit and date when it is the target's latest run. */
export const fixedByRun = (fixedRunId: string, latestRun: SecurityAuditRunRow | undefined) =>
	latestRun !== undefined && latestRun.id === fixedRunId
		? {
				runId: fixedRunId,
				ref: latestRun.sourceRef,
				at: isoOf(latestRun.finishedAt ?? latestRun.startedAt),
			}
		: { runId: fixedRunId, ref: null, at: null }

const fixedByText = (fixedRunId: string, latestRun: SecurityAuditRunRow | undefined): string => {
	const run = fixedByRun(fixedRunId, latestRun)
	return run.ref === null
		? `no longer found by audit run ${run.runId}`
		: `no longer found by the audit of ${Str.slice(0, 12)(run.ref)} on ${run.at === null ? undefined : Str.slice(0, 10)(run.at)}`
}

/** Services running a commit of each repository (by lowercase `owner/name`), from the dependency scanner's join. */
export type RepositoryServices = ReadonlyMap<string, SecurityFindingRow["services"]>

export const repositoryServicesOf = (read: DependencyRead | undefined): RepositoryServices =>
	new Map(
		read?._tag === "read"
			? Arr.map(read.repositories, (repo) => [
					Str.toLowerCase(repo.fullName),
					Arr.dedupeWith(
						servicesOf(Arr.flatMap(repo.runningCommits, (commit) => commit.services)),
						(ref, other) =>
							other.service === ref.service && other.environment === ref.environment,
					),
				])
			: [],
	)

export const codeRows = (
	targets: ReadonlyArray<CodeTarget>,
	repositoryServices: RepositoryServices,
): ReadonlyArray<SecurityFindingRow> =>
	Arr.flatMap(targets, ({ target, findings, latestRun }) =>
		Arr.map(findings, (row): SecurityFindingRow => ({
			area: "code",
			id: row.fingerprint,
			severity: codeSeverityOf(row),
			title: row.record.title,
			location: Arr.join(
				Arr.filter(
					[`${target.repository}@${target.branch}`, firstLocation(row)],
					(part) => part !== "",
				),
				" ",
			),
			status: row.status,
			detail: Arr.join(
				Arr.filter(
					[
						VERDICT_DETAIL[row.verdict],
						row.statusReason === null ? undefined : `${row.status} because: ${row.statusReason}`,
						row.fixedRunId === null ? undefined : fixedByText(row.fixedRunId, latestRun),
					],
					(part) => part !== undefined,
				),
				"; ",
			),
			// The services built from this repository: they run its code, if not necessarily this file.
			services: repositoryServices.get(Str.toLowerCase(target.repository)) ?? [],
			lastSeen: isoOf(row.updatedAt),
		})),
	)

// ---------------------------------------------------------------------------------------------
// Dependencies

export type DependencyRead =
	| {
			readonly _tag: "read"
			readonly repositories: ReadonlyArray<DependencyScanRepository>
			readonly findings: ReadonlyArray<DependencyFindingView>
			/** False when production telemetry could not be read, so `services` are unknown. */
			readonly productionKnown: boolean
			/** True when the reader's cap cut the findings: only the most urgent were read. */
			readonly capped: boolean
	  }
	| AreaGate

export interface DependencyReadOptions {
	/** Spend the reader's cap on this repository (owner/name) only. */
	readonly repository?: string | undefined
	/** Read this one finding by id instead of the ranked list, past its cap. */
	readonly findingId?: DependencyFindingId | undefined
}

export const readDependencies = (tenant: TenantContext, options: DependencyReadOptions = {}) =>
	Effect.gen(function* () {
		const reader = yield* DependencyScanReader
		const { repositories } = yield* reader.listRepositories(tenant)
		if (repositories.repositories.length === 0) {
			return {
				_tag: "not_connected",
				message:
					"No GitHub repository is connected, so no lockfile has been scanned (connect GitHub in Sources).",
			} satisfies DependencyRead
		}
		const findingId = options.findingId
		if (findingId !== undefined) {
			const found = yield* reader.getFinding(tenant, findingId)
			return {
				_tag: "read",
				repositories: repositories.repositories,
				findings: Option.toArray(Option.map(found, (hit) => hit.finding)),
				productionKnown: Option.match(found, {
					onNone: () => true,
					onSome: (hit) => hit.productionKnown,
				}),
				capped: false,
			} satisfies DependencyRead
		}
		const wanted = options.repository === undefined ? undefined : Str.toLowerCase(options.repository)
		const repository = Option.getOrUndefined(
			Arr.findFirst(repositories.repositories, (repo) => Str.toLowerCase(repo.fullName) === wanted),
		)
		// An unknown repository has no findings; reading the org's would spend the cap on others.
		const findings =
			wanted !== undefined && repository === undefined
				? { findings: [], production: { available: true } }
				: yield* reader.listFindings(tenant, { repositoryId: repository?.id })
		return {
			_tag: "read",
			repositories: repositories.repositories,
			findings: findings.findings,
			productionKnown: findings.production.available,
			capped: findings.findings.length >= FINDINGS_LIMIT,
		} satisfies DependencyRead
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("Security Center read failed", error).pipe(
				Effect.as<DependencyRead>({
					_tag: "unavailable",
					message: `Could not read dependency findings: ${error.message}`,
				}),
			),
		),
	)

const servicesOf = (
	services: ReadonlyArray<{ readonly serviceName: string; readonly environment: string }>,
): SecurityFindingRow["services"] =>
	Arr.map(services, (service) => ({ service: service.serviceName, environment: service.environment }))

export const dependencyRows = (
	findings: ReadonlyArray<DependencyFindingView>,
): ReadonlyArray<SecurityFindingRow> =>
	Arr.map(findings, (finding) => ({
		area: "dependencies",
		id: finding.id,
		severity: finding.severity,
		title: `${finding.packageName} ${Arr.join(finding.versions, ", ")}: ${finding.summary ?? displayAdvisory(finding)}`,
		location: `${finding.repositoryFullName} ${finding.lockfilePath}`,
		status: finding.status,
		detail: Arr.join(
			Arr.filter(
				[
					`${displayAdvisory(finding)}. ${dependencyFixOf(finding)}`,
					finding.statusReason === null
						? undefined
						: `${finding.status} because: ${finding.statusReason}`,
				],
				(part) => part !== undefined,
			),
			" ",
		),
		// A dev dependency is in the deployed commit's lockfile but not in what the service runs.
		services: finding.relation === "dev" ? [] : servicesOf(finding.production),
		lastSeen: isoOf(finding.updatedAt),
	}))

/** What to change, by how the lockfile's root depends on the package. */
export const dependencyFixOf = (
	finding: Pick<DependencyFindingView, "packageName" | "fixedIn" | "relation">,
): string => {
	if (finding.fixedIn === null)
		return `No fixed version of ${finding.packageName} is published: remove or replace it.`
	const target = `${finding.packageName} ${finding.fixedIn} or later`
	switch (finding.relation) {
		case "direct":
			return `Direct dependency: upgrade to ${target}.`
		case "dev":
			return `Dev dependency, not shipped: upgrade to ${target} when convenient.`
		case "transitive":
			return `Transitive: upgrade the package that pulls it in (\`npm ls ${finding.packageName}\` or \`bun pm why ${finding.packageName}\` names it), or pin ${target} with an override.`
		case "unknown":
			return `Upgrade to ${target}.`
	}
}

/** The CVE when the advisory has one: what people search for. */
export const displayAdvisory = (finding: Pick<DependencyFindingView, "advisoryId" | "aliases">): string => {
	return Option.match(
		Arr.findFirst(finding.aliases, (alias) => Str.startsWith("CVE-")(alias)),
		{ onNone: () => finding.advisoryId, onSome: (cve) => `${cve} (${finding.advisoryId})` },
	)
}

// ---------------------------------------------------------------------------------------------
// Exposure

type SignatureRow = CH.ScannerSignaturesOutput
type ExposedRow = CH.ScannerExposedOutput
type SourceRow = CH.ScannerSourcesOutput

export interface ExposureRead {
	readonly _tag: "read"
	readonly signatures: ReadonlyArray<SignatureRow>
	readonly exposed: ReadonlyArray<ExposedRow>
	readonly sources: ReadonlyArray<SourceRow>
}

/** Rows the queries return at most: past these, counts are floors. */
export const EXPOSED_LIMIT = 50
export const SOURCES_LIMIT = 20

export const readExposure = (tenant: TenantContext, window: SecurityWindow) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const params = { orgId: tenant.orgId, startTime: window.startTime, endTime: window.endTime }
		const [signatures, exposed, sources] = yield* Effect.all(
			[
				warehouse.compiledQuery(tenant, CH.compile(CH.scannerSignaturesQuery(), params), {
					profile: "aggregation",
					context: "mcpScannerSignatures",
				}),
				warehouse.compiledQuery(
					tenant,
					CH.compile(CH.scannerExposedQuery({ limit: EXPOSED_LIMIT }), params),
					{ profile: "aggregation", context: "mcpScannerExposed" },
				),
				warehouse.compiledQuery(
					tenant,
					CH.compile(CH.scannerSourcesQuery({ limit: SOURCES_LIMIT }), params),
					{ profile: "aggregation", context: "mcpScannerSources" },
				),
			],
			{ concurrency: 3 },
		)
		return { _tag: "read", signatures, exposed, sources } satisfies ExposureRead
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("Security Center read failed", error).pipe(
				Effect.as<AreaGate>({
					_tag: "unavailable",
					message: `Could not read scanner traffic: ${error.message}`,
				}),
			),
		),
	)

const isCriticalSignature = (signature: string): boolean => {
	const category = probeCategoryOf(signature)
	return Arr.some(PROBE_CATEGORIES, (info) => info.id === category && info.critical)
}

/** A service answering this share of distinct critical probes, and at least this many, serves every path. */
const CATCH_ALL_SHARE = 0.8
const CATCH_ALL_MIN_ANSWERED = 3

export interface CatchAllService {
	readonly service: string
	readonly answered: number
	readonly probed: number
}

/**
 * Services that answer most critical probe paths with a success: a single-page app or soft-404 route
 * serves its index page for `/.env` too, so their answers are a warning, not an exposure.
 */
export const catchAllServices = (signatures: ReadonlyArray<SignatureRow>): ReadonlyArray<CatchAllService> => {
	const probes = Arr.filter(signatures, (row) => isCriticalSignature(row.signature))
	return Arr.flatMap([...new Set(Arr.map(probes, (row) => row.service))], (service) => {
		const own = Arr.filter(probes, (row) => row.service === service)
		const probed = new Set(Arr.map(own, (row) => row.signature)).size
		const answered = new Set(
			Arr.map(
				Arr.filter(own, (row) => row.answered > 0),
				(row) => row.signature,
			),
		).size
		return answered >= CATCH_ALL_MIN_ANSWERED && answered / probed >= CATCH_ALL_SHARE
			? [{ service, answered, probed }]
			: []
	})
}

export const categoryLabelOf = (signature: string): string => {
	const id = probeCategoryOf(signature)
	return Option.match(
		Arr.findFirst(PROBE_CATEGORIES, (category) => category.id === id),
		{ onNone: () => "Unclassified", onSome: (category) => category.label },
	)
}

/** What `inspect_security_finding` takes for an answered probe: the service and the path it served. */
export const exposureIdOf = (row: Pick<ExposedRow, "service" | "path">): string =>
	`${row.service}:${row.path}`

/** A served secrets or source-control probe hands out credentials or code: critical. Other served probes: high. */
export const exposedSeverity = (signature: string): SecuritySeverity => {
	const category = probeCategoryOf(signature)
	return category === "secrets" || category === "source_control" ? "critical" : "high"
}

export const exposureRows = (read: ExposureRead): ReadonlyArray<SecurityFindingRow> => {
	const catchAll = new Set(Arr.map(catchAllServices(read.signatures), (entry) => entry.service))
	return Arr.map(
		Arr.filter(read.exposed, (row) => !catchAll.has(row.service)),
		(row) => ({
			area: "exposure",
			id: exposureIdOf(row),
			severity: exposedSeverity(row.signature),
			title: `${categoryLabelOf(row.signature)} probe answered: ${row.path}`,
			location: `${row.service} ${row.host}${row.path}`,
			status: `answered ${row.httpStatus}`,
			detail: `${row.requests} probe request${row.requests === 1 ? "" : "s"} got a ${row.httpStatus}; check the path serves nothing sensitive. Sample trace ${row.sampleTraceId}`,
			services: [{ service: row.service, environment: "" }],
			lastSeen: isoUtc(row.lastSeen),
		}),
	)
}

export interface ExposureCategory {
	readonly label: string
	readonly requests: number
	/** Null for named scanners on ordinary paths: a 200 on a normal page is not an exposure. */
	readonly answered: number | null
	readonly services: number
	readonly topPaths: ReadonlyArray<string>
}

/** Probe traffic per category, catalog order, then named scanners on ordinary paths. */
export const exposureCategories = (read: ExposureRead, service?: string): ReadonlyArray<ExposureCategory> => {
	const catchAll = new Set(Arr.map(catchAllServices(read.signatures), (entry) => entry.service))
	const signatures =
		service === undefined
			? read.signatures
			: Arr.filter(read.signatures, (row) => row.service === service)
	const summarize = (label: string, rows: ReadonlyArray<SignatureRow>, probes = true): ExposureCategory => {
		const bySignature = Arr.reduce(rows, new Map<string, number>(), (acc, row) =>
			acc.set(row.signature, (acc.get(row.signature) ?? 0) + row.requests),
		)
		return {
			label,
			requests: Arr.reduce(rows, 0, (sum, row) => sum + row.requests),
			answered: probes
				? Arr.reduce(
						Arr.filter(rows, (row) => !catchAll.has(row.service)),
						0,
						(sum, row) => sum + row.answered,
					)
				: null,
			services: new Set(Arr.map(rows, (row) => row.service)).size,
			topPaths: Arr.filter(
				Arr.map([...bySignature].sort((a, b) => b[1] - a[1]).slice(0, 3), ([signature]) => signature),
				(signature) => signature !== "",
			),
		}
	}
	const categories = Arr.flatMap(PROBE_CATEGORIES, (category) => {
		const rows = Arr.filter(signatures, (row) => probeCategoryOf(row.signature) === category.id)
		return rows.length === 0 ? [] : [summarize(category.label, rows)]
	})
	const scanners = Arr.filter(signatures, (row) => row.signature === "")
	return scanners.length === 0
		? categories
		: [...categories, summarize("Named scanners on ordinary paths", scanners, false)]
}

// ---------------------------------------------------------------------------------------------
// Runtimes

type RuntimeRow = CH.RuntimeVersionsOutput

export interface RuntimeEntry {
	readonly row: RuntimeRow
	readonly posture: RuntimePosture
	/** Known advisories for the version; undefined when it could not be looked up. */
	readonly advisories: ReadonlyArray<RuntimeAdvisory> | undefined
	readonly advisoryKey: string | undefined
}

export interface RuntimesRead {
	readonly _tag: "read"
	readonly entries: ReadonlyArray<RuntimeEntry>
	/** Versions not checked for advisories this time (read budget spent on busier services). */
	readonly skipped: ReadonlyArray<string>
}

export const readRuntimes = (tenant: TenantContext, window: SecurityWindow) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const rows = yield* warehouse.compiledQuery(
			tenant,
			CH.compile(CH.runtimeVersionsQuery(), {
				orgId: tenant.orgId,
				startTime: window.startTime,
				endTime: window.endTime,
			}),
			{ profile: "aggregation", context: "mcpRuntimeVersions" },
		)
		const products = Arr.flatMap(rows, (row): ReadonlyArray<RuntimeProduct> => {
			const product = runtimeProductOf(row.runtimeName, row.sdkLanguage)
			return product === undefined || row.runtimeVersion === "" ? [] : [product]
		})
		// Busiest services first, so the read cap drops the quietest versions.
		const busiestFirst = Arr.sort(
			rows,
			Order.flip(Order.mapInput(Order.Number, (row: (typeof rows)[number]) => row.spans)),
		)
		const targets = Arr.flatMap(busiestFirst, (row) => {
			const target = advisoryTargetOf(row)
			return target === undefined ? [] : [target]
		})
		const [releases, advisories] = yield* Effect.all(
			[
				(yield* RuntimeReleaseCatalog).releases(products),
				(yield* RuntimeAdvisoryCatalog).advisories(targets),
			],
			{ concurrency: 2 },
		)
		const entries = Arr.map(rows, (row): RuntimeEntry => {
			const target = advisoryTargetOf(row)
			const key = target === undefined ? undefined : advisoryKey(target)
			return {
				row,
				posture: runtimePosture(row, (product) => releases[product]),
				advisories: key === undefined ? undefined : advisories.advisories[key],
				advisoryKey: key,
			}
		})
		return { _tag: "read", entries, skipped: advisories.skipped } satisfies RuntimesRead
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("Security Center read failed", error).pipe(
				Effect.as<AreaGate>({
					_tag: "unavailable",
					message: `Could not read runtimes: ${error.message}`,
				}),
			),
		),
	)

export const runtimeLabelOf = (entry: RuntimeEntry): string => {
	if (entry.posture.status === "emulated")
		return `${RUNTIME_PRODUCTS[entry.posture.product].label} (reports Node.js ${entry.row.runtimeVersion})`
	const product =
		"product" in entry.posture
			? entry.posture.product
			: runtimeProductOf(entry.row.runtimeName, entry.row.sdkLanguage)
	const name =
		product === undefined ? entry.row.runtimeName || "unknown runtime" : RUNTIME_PRODUCTS[product].label
	return entry.row.runtimeVersion === "" ? name : `${name} ${entry.row.runtimeVersion}`
}

/** What the posture says, in a few words. */
export const postureText = (posture: RuntimePosture): string => {
	switch (posture.status) {
		case "end_of_life":
			return `end of life${posture.eolFrom === null ? "" : ` since ${posture.eolFrom}`} (cycle ${posture.cycle})`
		case "behind":
			return `behind: latest ${posture.cycle}.x is ${posture.latest}`
		case "supported":
			return `supported${posture.eolFrom === null ? "" : ` until ${posture.eolFrom}`}`
		case "no_version":
			return "sends no runtime version"
		case "emulated":
			return `${RUNTIME_PRODUCTS[posture.product].label} reporting a Node.js compatibility version`
		case "unknown_cycle":
			return "version matches no published release"
		case "catalog_unavailable":
			return "release data unavailable"
		case "untracked":
			return "runtime not tracked"
	}
}

/** One row per (service, environment) on a version with advisories, past end of life, or behind. */
export const runtimeRows = (entries: ReadonlyArray<RuntimeEntry>): ReadonlyArray<SecurityFindingRow> =>
	Arr.flatMap(entries, (entry): ReadonlyArray<SecurityFindingRow> => {
		const advisories = entry.advisories ?? []
		const summary = summarizeAdvisories(advisories)
		const status = entry.posture.status
		if (advisories.length === 0 && status !== "end_of_life" && status !== "behind") return []
		const severity: SecuritySeverity =
			summary.worst !== null ? summary.worst : status === "end_of_life" ? "medium" : "low"
		const cves =
			advisories.length === 0
				? undefined
				: `${advisories.length} known vulnerabilit${advisories.length === 1 ? "y" : "ies"} (${summary.counts.critical} critical, ${summary.counts.high} high)`
		return [
			{
				area: "runtimes",
				id: entry.advisoryKey ?? `${entry.row.service} ${runtimeLabelOf(entry)}`,
				severity,
				title: `${runtimeLabelOf(entry)}: ${Arr.join(
					Arr.filter(
						[
							cves,
							status === "end_of_life" || status === "behind"
								? postureText(entry.posture)
								: undefined,
						],
						(part) => part !== undefined,
					),
					"; ",
				)}`,
				location: entry.row.service,
				status,
				detail:
					summary.upgradeTo !== null
						? `upgrade to ${summary.upgradeTo} or later`
						: "latest" in entry.posture && entry.posture.latest !== null
							? `upgrade to ${entry.posture.latest} or a supported cycle`
							: postureText(entry.posture),
				services: [{ service: entry.row.service, environment: entry.row.environment }],
				lastSeen: isoUtc(entry.row.lastSeen),
			},
		]
	})

// ---------------------------------------------------------------------------------------------
// Ranking and filters

export const SEVERITY_FLOORS = ["critical", "high", "medium", "low"] as const
export type SeverityFloor = (typeof SEVERITY_FLOORS)[number]

export const STATUS_FILTERS = ["open", "fixed", "dismissed", "accepted_risk", "all"] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

export interface FindingFilters {
	readonly severity?: SeverityFloor | undefined
	readonly status: StatusFilter
	readonly repository?: string | undefined
	readonly service?: string | undefined
}

/** Triage states belong to code and dependency findings; telemetry rows are always current. */
const hasTriage = (area: SecurityArea): boolean => area === "code" || area === "dependencies"

export const matchesFilters = (row: SecurityFindingRow, filters: FindingFilters): boolean => {
	if (filters.severity !== undefined && SEVERITY_RANK[row.severity] > SEVERITY_RANK[filters.severity])
		return false
	if (hasTriage(row.area) && filters.status !== "all" && row.status !== filters.status) return false
	if (filters.repository !== undefined) {
		// `owner/name@branch path` for code, `owner/name lockfile` for dependencies: match the whole name.
		const repo = Str.toLowerCase(filters.repository)
		const location = Str.toLowerCase(row.location)
		if (
			!hasTriage(row.area) ||
			!(Str.startsWith(`${repo}@`)(location) || Str.startsWith(`${repo} `)(location))
		)
			return false
	}
	if (filters.service !== undefined) {
		const service = filters.service
		if (!Arr.some(row.services, (ref) => ref.service === service)) return false
	}
	return true
}

const FINDING_RANK: Order.Order<SecurityFindingRow> = Order.combineAll([
	Order.mapInput(Order.Number, (row: SecurityFindingRow) => SEVERITY_RANK[row.severity]),
	Order.flip(Order.mapInput(Order.Number, (row: SecurityFindingRow) => row.services.length)),
	Order.make((a, b) => Str.localeCompare(a.lastSeen ?? "")(b.lastSeen ?? "")),
])

export const rankFindings = (rows: ReadonlyArray<SecurityFindingRow>): ReadonlyArray<SecurityFindingRow> =>
	Arr.sort(rows, FINDING_RANK)

export const countBySeverity = (rows: ReadonlyArray<SecurityFindingRow>) => ({
	critical: Arr.filter(rows, (row) => row.severity === "critical").length,
	high: Arr.filter(rows, (row) => row.severity === "high").length,
	medium: Arr.filter(rows, (row) => row.severity === "medium").length,
	low: Arr.filter(rows, (row) => row.severity === "low").length,
	other: Arr.filter(rows, (row) => row.severity === "informational" || row.severity === "unknown").length,
})

// ---------------------------------------------------------------------------------------------
// Areas: one summary line, the area's rows and the facts worth a note

export interface AreaResult {
	readonly area: SecurityArea
	readonly state: "findings" | "clear" | AreaGate["_tag"] | "no_data"
	readonly summary: string
	readonly rows: ReadonlyArray<SecurityFindingRow>
	readonly notes: ReadonlyArray<string>
}

const plural = (n: number, noun: string) =>
	n === 1 ? `1 ${noun}` : `${n} ${Str.endsWith("y")(noun) ? `${Str.slice(0, -1)(noun)}ies` : `${noun}s`}`

const gated = (area: SecurityArea, gate: AreaGate): AreaResult => ({
	area,
	state: gate._tag,
	summary: gate.message,
	rows: [],
	notes: [],
})

/** Open telemetry rows and open triaged findings decide the state. */
const stateOf = (rows: ReadonlyArray<SecurityFindingRow>): AreaResult["state"] =>
	Arr.some(rows, (row) => row.status === "open" || !hasTriage(row.area)) ? "findings" : "clear"

export const codeArea = (read: CodeRead, repositoryServices: RepositoryServices): AreaResult => {
	if (read._tag !== "read") return gated("code", read)
	// Rejected claims were disproved by the verifier; they stay readable through inspect only.
	const rows = Arr.filter(
		codeRows(read.targets, repositoryServices),
		(row) => !Str.startsWith("rejected")(row.detail),
	)
	const open = Arr.flatMap(read.targets, (t) => Arr.filter(t.findings, (f) => f.status === "open"))
	const confirmed = Arr.filter(open, (f) => f.verdict === "confirmed").length
	const leads = Arr.filter(open, (f) => f.verdict === "needs_validation").length
	const stale = Arr.flatMap(read.targets, ({ target, latestRun }) => {
		const name = `${target.repository}@${target.branch}`
		if (latestRun === undefined) return [`${name} has never been audited`]
		if (latestRun.status === "complete") return []
		const why = latestRun.incompleteReason ?? latestRun.error ?? latestRun.status
		return [
			`${name}'s latest run is ${latestRun.status} (${truncate(why, 120)}), so its findings may be partial`,
		]
	})
	return {
		area: "code",
		state: stateOf(rows),
		summary: Arr.join(
			[
				`${plural(read.targets.length, "repository")} audited: ${confirmed} confirmed ${confirmed === 1 ? "vulnerability" : "vulnerabilities"} and ${plural(leads, "unconfirmed lead")} open.`,
				...Arr.map(stale, (line) => `${line}.`),
			],
			" ",
		),
		rows,
		notes: [],
	}
}

export const dependencyArea = (read: DependencyRead): AreaResult => {
	if (read._tag !== "read") return gated("dependencies", read)
	const rows = dependencyRows(read.findings)
	const inProduction = Arr.filter(rows, (row) => row.status === "open" && row.services.length > 0).length
	const unscanned = Arr.map(
		Arr.filter(read.repositories, (repo) => repo.latestScan === null),
		(repo) => repo.fullName,
	)
	const capNote = read.capped
		? [
				`Only the ${FINDINGS_LIMIT} most urgent dependency findings were read; filter by repository for the rest.`,
			]
		: []
	const notes = Arr.flatMap(read.repositories, (repo) => {
		const scan = repo.latestScan
		if (scan === null) return []
		const failed =
			scan.status === "failed"
				? [
						`Latest dependency scan of ${repo.fullName} failed${scan.error === null ? "" : `: ${truncate(scan.error, 160)}`}.`,
					]
				: []
		const unread = Arr.filter(
			scan.lockfiles,
			(lock) => lock.status !== "parsed" && lock.status !== "skipped",
		)
		return unread.length === 0
			? failed
			: [
					...failed,
					`${repo.fullName}: ${Arr.join(
						Arr.map(unread, (lock) => `${lock.path} ${lock.status}`),
						", ",
					)}; its packages are not checked.`,
				]
	})
	return {
		area: "dependencies",
		state: stateOf(rows),
		summary: Arr.join(
			[
				`${read.repositories.length - unscanned.length} of ${plural(read.repositories.length, "repository")} scanned${unscanned.length === 0 ? "" : ` (never scanned: ${Arr.join(unscanned, ", ")})`};`,
				read.productionKnown
					? `${inProduction} open ${inProduction === 1 ? "finding is" : "findings are"} in a commit a production service runs.`
					: "production telemetry could not be joined, so no finding says which services run it.",
			],
			" ",
		),
		rows,
		notes: [...capNote, ...notes],
	}
}

export const exposureArea = (read: ExposureRead | AreaGate): AreaResult => {
	if (read._tag !== "read") return gated("exposure", read)
	if (read.signatures.length === 0 && read.sources.length === 0) {
		return {
			area: "exposure",
			state: "no_data",
			summary:
				"No scanner or probe traffic in the window. Exposure reads Server spans (url.path / http.route, client.address, user agent).",
			rows: [],
			notes: [],
		}
	}
	const probes = Arr.filter(read.signatures, (row) => row.signature !== "")
	const requests = Arr.reduce(probes, 0, (n, row) => n + row.requests)
	const rows = exposureRows(read)
	const sources = read.sources.length >= SOURCES_LIMIT ? `${SOURCES_LIMIT}+` : String(read.sources.length)
	return {
		area: "exposure",
		state: rows.length === 0 ? "clear" : "findings",
		summary: `${requests} probe requests against ${plural(new Set(Arr.map(probes, (row) => row.service)).size, "service")} from ${sources} sources; ${plural(rows.length, "probed path")} answered with a 2xx. Maple sees the status code, not the response body.`,
		rows,
		notes: [
			...Arr.map(
				catchAllServices(read.signatures),
				(entry) =>
					`${entry.service} answered ${entry.answered} of ${entry.probed} sensitive probe paths with a 2xx: it serves every path (a single-page app or soft-404 route), so its answers are not listed as exposures. Have it return 404 for unknown paths so real exposures show.`,
			),
			...(read.exposed.length >= EXPOSED_LIMIT
				? [
						`Only the ${EXPOSED_LIMIT} most recent answered probes were read; narrow the window for older ones.`,
					]
				: []),
		],
	}
}

/** Why a runtime was not judged, for the ones that are neither a finding nor fine. */
const unjudged = (entry: RuntimeEntry): string | undefined => {
	switch (entry.posture.status) {
		case "emulated":
			return `${entry.row.service} (${RUNTIME_PRODUCTS[entry.posture.product].label}: reports the Node.js version it emulates, not its own)`
		case "untracked":
			return `${entry.row.service} (${entry.row.runtimeName || "unknown runtime"}: no version to check)`
		case "no_version":
			return `${entry.row.service} (sends no process.runtime.version)`
		case "unknown_cycle":
		case "catalog_unavailable":
			return `${entry.row.service} (${postureText(entry.posture)})`
		default:
			return undefined
	}
}

export const runtimeArea = (read: RuntimesRead | AreaGate): AreaResult => {
	if (read._tag !== "read") return gated("runtimes", read)
	if (read.entries.length === 0) {
		return {
			area: "runtimes",
			state: "no_data",
			summary:
				"No service reported a runtime in the window (process.runtime.name / process.runtime.version).",
			rows: [],
			notes: [],
		}
	}
	const rows = runtimeRows(read.entries)
	const services = new Set(Arr.map(read.entries, (entry) => entry.row.service)).size
	const notJudged = Arr.flatMap(read.entries, (entry) => {
		const why = unjudged(entry)
		return why === undefined ? [] : [why]
	})
	return {
		area: "runtimes",
		state: rows.length === 0 ? "clear" : "findings",
		summary: Arr.join(
			[
				`${plural(services, "service")} report a runtime; ${rows.length} on a version with known CVEs, past end of life or behind its line's latest patch.`,
				...(notJudged.length === 0 ? [] : [`Not judged: ${Arr.join(notJudged, ", ")}.`]),
			],
			" ",
		),
		rows,
		notes:
			read.skipped.length === 0
				? []
				: [`Not checked for CVEs this time: ${Arr.join(read.skipped, ", ")}.`],
	}
}

// ---------------------------------------------------------------------------------------------
// Repositories: what audits and scans each one, and whether a filtered one was ever read

/** Every audited or connected repository with its latest audit run and dependency scan. */
export const repositoryCoverage = (
	code: CodeRead | undefined,
	dependencies: DependencyRead | undefined,
): ReadonlyArray<SecurityRepositoryCoverage> => {
	const targets = code?._tag === "read" ? code.targets : []
	const repos = dependencies?._tag === "read" ? dependencies.repositories : []
	const names = Arr.dedupe([
		...Arr.map(targets, ({ target }) => target.repository),
		...Arr.map(repos, (repo) => repo.fullName),
	])
	const sameName = (a: string, b: string) => Str.toLowerCase(a) === Str.toLowerCase(b)
	return Arr.flatMap(names, (name, i): ReadonlyArray<SecurityRepositoryCoverage> => {
		// Keep the first spelling of each name.
		if (
			!Option.contains(
				Arr.findFirstIndex(names, (other) => sameName(other, name)),
				i,
			)
		)
			return []
		// One target per branch: show the branch that ran last (a run beats none), else the first.
		const audited = Arr.reduce<CodeTarget, CodeTarget | undefined>(
			Arr.filter(targets, ({ target }) => sameName(target.repository, name)),
			undefined,
			(best, next) =>
				best === undefined ||
				(next.latestRun !== undefined &&
					(best.latestRun === undefined || next.latestRun.startedAt > best.latestRun.startedAt))
					? next
					: best,
		)
		const repo = Option.getOrUndefined(Arr.findFirst(repos, (r) => sameName(r.fullName, name)))
		const run = audited?.latestRun
		const scan = repo?.latestScan ?? null
		return [
			{
				repository: name,
				// No target at all is known, not unreadable.
				auditReadable: code?._tag === "read" || code?._tag === "not_connected",
				audit:
					audited === undefined
						? null
						: {
								branch: audited.target.branch,
								enabled: audited.target.enabled,
								lastRunId: run?.id ?? null,
								lastRunStatus: run?.status ?? null,
								lastRunAt: run === undefined ? null : isoOf(run.finishedAt ?? run.startedAt),
								lastRunStopReason:
									run === undefined ? null : (run.incompleteReason ?? run.error),
							},
				dependencyScan:
					repo === undefined
						? null
						: {
								status: scan?.status ?? null,
								at: scan === null ? null : isoOf(scan.finishedAt ?? scan.startedAt),
								commit: scan === null ? null : Str.slice(0, 12)(scan.commitSha),
							},
			},
		]
	})
}

/**
 * Why a repository filter read nothing in a code or dependency area: the repository was never
 * audited or scanned, or is not set up at all. Undefined when it was read, so its empty area is clear.
 */
export const unreadRepository = (
	area: "code" | "dependencies",
	repository: string,
	coverage: ReadonlyArray<SecurityRepositoryCoverage>,
): { readonly state: "not_scanned" | "not_connected"; readonly note: string } | undefined => {
	const row = Arr.findFirst(coverage, (r) => Str.toLowerCase(r.repository) === Str.toLowerCase(repository))
	if (area === "code") {
		if (Option.isNone(row) || row.value.audit === null)
			return {
				state: "not_connected",
				note: `${repository} is not set up for the code audit, so no code finding is not the same as clear.`,
			}
		return row.value.audit.lastRunId === null
			? {
					state: "not_scanned",
					note: `${repository} has never been audited, so no code finding is not the same as clear.`,
				}
			: undefined
	}
	if (Option.isNone(row) || row.value.dependencyScan === null)
		return {
			state: "not_connected",
			note: `${repository} is not a connected GitHub repository, so its lockfiles are not scanned.`,
		}
	return row.value.dependencyScan.status === null
		? {
				state: "not_scanned",
				note: `${repository} has never had a dependency scan, so no dependency finding is not the same as clear.`,
			}
		: undefined
}
