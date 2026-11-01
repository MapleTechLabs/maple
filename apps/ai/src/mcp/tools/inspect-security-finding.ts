import { Clock, DateTime, Effect, Schema } from "effect"
import { InspectSecurityFindingOutput } from "@maple/domain/mcp-outputs"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { truncate } from "../lib/format"
import { doc } from "../lib/tool-doc"
import {
	catchAllServices,
	categoryLabelOf,
	codeSeverityOf,
	dependencyFixOf,
	displayAdvisory,
	exposedSeverity,
	exposureIdOf,
	fixedByRun,
	readCode,
	readDependencies,
	readExposure,
	postureText,
	readRuntimes,
	repositoryServicesOf,
	runtimeLabelOf,
} from "../lib/security"
import type { McpToolRegistrar } from "./types"

const TOOL = "inspect_security_finding"
/** Runtime advisories are matched against what services ran over the last week. */
const RUNTIME_WINDOW_MS = 7 * 24 * 3_600_000

type Output = typeof InspectSecurityFindingOutput.Type
type Match = Output["matches"][number]

const isoOf = (ms: number) => new Date(ms).toISOString()
const DEPENDENCY_ID = /^[0-9a-f]{32}$/u
const ADVISORY_ID = /^(CVE|GHSA|GO|RUSTSEC|PYSEC|OSV|BIT)-/iu

export function registerInspectSecurityFindingTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Inspect Security Finding",
		description:
			"One security finding in full. Takes an `id` from list_security_findings: a code audit fingerprint " +
			"(the vulnerability's trace from entry point to sink, evidence, how it is exploited, the fix), a dependency " +
			"finding id (package, affected versions, fix version, which production services run it), or a runtime key " +
			"like `nodejs@20.10.0`, or an answered probe as `service:/path` (every probe that service got, and what a 2xx " +
			"means). Also takes an advisory id (CVE-…, GHSA-…) to answer 'are we affected by this CVE?' " +
			"across dependencies and runtimes, with what was checked and found clean (version exposure, not exploitation).",
		parameters: Schema.Struct({
			id: P.text(
				"A code fingerprint, dependency finding id, runtime key (product@version), answered probe (service:/path) or advisory id (CVE-…, GHSA-…)",
			),
			repository: P.optionalText(
				"Only this repository (owner/name), when a fingerprint exists in several",
			),
		}),
		output: InspectSecurityFindingOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting a security finding"],
		handler: Effect.fn("McpTool.inspectSecurityFinding")(function* ({ id, repository }) {
			const tenant = yield* CurrentMcpTenant
			const query = id.trim()
			const needle = query.toLowerCase()
			const isDependencyId = DEPENDENCY_ID.test(query)
			const now = yield* Clock.currentTimeMillis
			const window = {
				startTime: formatWarehouseDateTime(now - RUNTIME_WINDOW_MS),
				endTime: formatWarehouseDateTime(now),
			}
			// `service:/path` names an answered probe; nothing else reads scanner traffic.
			const isExposureId = /^[^\s:]+:\//u.test(query)
			const [code, dependencies, runtimes, exposure] = yield* Effect.all(
				[
					isDependencyId || isExposureId ? Effect.succeed(undefined) : readCode(tenant),
					isExposureId ? Effect.succeed(undefined) : readDependencies(tenant),
					isDependencyId || isExposureId ? Effect.succeed(undefined) : readRuntimes(tenant, window),
					isExposureId ? readExposure(tenant, window) : Effect.succeed(undefined),
				],
				{ concurrency: 4 },
			)
			const notSearched: Array<string> = []
			const matches: Array<Match> = []

			if (code !== undefined && code._tag !== "read") {
				if (code._tag !== "not_connected") notSearched.push(`code: ${code.message}`)
			} else if (code !== undefined) {
				const repositoryServices = repositoryServicesOf(dependencies)
				const hits = code.targets.flatMap(({ target, findings, latestRun }) =>
					findings
						.filter((row) => row.fingerprint.toLowerCase() === needle)
						.filter(
							(_) =>
								repository === undefined ||
								target.repository.toLowerCase() === repository.toLowerCase(),
						)
						.map((row) => ({ target, row, latestRun })),
				)
				matches.push(
					...hits.map(({ target, row, latestRun }): Match => {
						const record = row.record
						const confirmed = record.verdict === "confirmed" ? record : undefined
						return {
							area: "code",
							fingerprint: row.fingerprint,
							repository: target.repository,
							branch: target.branch,
							title: record.title,
							verdict: row.verdict,
							severity: codeSeverityOf(row),
							severityEstimated: row.verdict === "needs_validation",
							status: row.status,
							statusReason: row.statusReason,
							statusChangedAt: row.statusChangedAt === null ? null : isoOf(row.statusChangedAt),
							description: record.description,
							rootCause:
								record.verdict === "confirmed"
									? record.root_cause
									: record.claimed_root_cause,
							trace: record.trace.map((step) => ({
								kind: step.kind,
								file: step.file,
								line: step.line,
								description: step.description,
							})),
							evidence: record.evidence.map((e) => ({
								file: e.file,
								line: e.line,
								description: e.description,
							})),
							exploit:
								confirmed === undefined
									? null
									: {
											attackerPerspective: confirmed.execution.attacker_perspective,
											instructions: confirmed.execution.instructions,
											payloads: confirmed.execution.payloads,
											observedResult: confirmed.execution.observed_result,
										},
							conditions: confirmed?.conditions.map((c) => `${c.kind}: ${c.description}`) ?? [],
							remediation:
								confirmed === undefined
									? null
									: {
											strategy: confirmed.remediation.strategy,
											codeChanges: (confirmed.remediation.code_changes ?? []).map(
												(change) => ({
													file: change.file_name,
													fixedCode: change.fixed_code,
												}),
											),
										},
							blockers: record.verdict === "needs_validation" ? record.blockers : [],
							validationPlan:
								record.verdict === "needs_validation"
									? [
											record.validation_plan.local,
											record.validation_plan.deployment,
										].filter((step): step is string => step !== undefined)
									: [],
							rejectedBecause: record.verdict === "rejected" ? record.reason : null,
							firstSeenRef: row.firstSeenRef,
							lastSeenRef: row.lastSeenRef,
							firstSeenAt: isoOf(row.createdAt),
							lastSeenAt: isoOf(row.updatedAt),
							services: repositoryServices.get(target.repository.toLowerCase()) ?? [],
							fixedBy: row.fixedRunId === null ? null : fixedByRun(row.fixedRunId, latestRun),
						}
					}),
				)
			}

			if (dependencies !== undefined && dependencies._tag !== "read") {
				if (dependencies._tag !== "not_connected")
					notSearched.push(`dependencies: ${dependencies.message}`)
			} else if (dependencies !== undefined) {
				const hits = dependencies.findings.filter(
					(finding) =>
						finding.id === needle ||
						finding.advisoryId.toLowerCase() === needle ||
						finding.aliases.some((alias) => alias.toLowerCase() === needle),
				)
				matches.push(
					...hits
						.filter(
							(f) =>
								repository === undefined ||
								f.repositoryFullName.toLowerCase() === repository.toLowerCase(),
						)
						.map((f): Match => ({
							area: "dependencies",
							id: f.id,
							repository: f.repositoryFullName,
							lockfilePath: f.lockfilePath,
							ecosystem: f.ecosystem,
							packageName: f.packageName,
							versions: f.versions,
							fixedIn: f.fixedIn,
							relation: f.relation,
							advisoryId: f.advisoryId,
							aliases: f.aliases,
							severity: f.severity,
							summary: f.summary,
							status: f.status,
							statusReason: f.statusReason,
							services:
								f.relation === "dev"
									? []
									: f.production.map((s) => ({
											service: s.serviceName,
											environment: s.environment,
											commitSha: s.commitSha,
											spans: s.spanCount,
										})),
							fix: dependencyFixOf(f),
							firstSeenSha: f.firstSeenSha,
							lastSeenSha: f.lastSeenSha,
							firstSeenAt: isoOf(f.createdAt),
							lastSeenAt: isoOf(f.updatedAt),
						})),
				)
			}

			if (runtimes !== undefined && runtimes._tag !== "read")
				notSearched.push(`runtimes: ${runtimes.message}`)
			else if (runtimes !== undefined) {
				// One row per advisory and runtime version, with every service on that version. A version
				// key with no advisory still answers with its posture: the list names it for that alone.
				const byAdvisory = new Map<string, Match & { area: "runtimes" }>()
				runtimes.entries.forEach((entry) => {
					const keyMatches = entry.advisoryKey?.toLowerCase() === needle
					const advisories = (entry.advisories ?? []).filter(
						(advisory) => keyMatches || advisory.id.toLowerCase() === needle,
					)
					const service = { service: entry.row.service, environment: entry.row.environment }
					const base = {
						area: "runtimes" as const,
						runtime: runtimeLabelOf(entry),
						version: entry.row.runtimeVersion,
						posture: entry.posture.status,
						postureNote: postureText(entry.posture),
					}
					const rows =
						keyMatches && advisories.length === 0
							? [
									{
										key: `posture ${entry.advisoryKey}`,
										...base,
										advisoryId: null,
										url: null,
										summary: null,
										severity:
											entry.posture.status === "end_of_life"
												? ("medium" as const)
												: ("low" as const),
										fixedIn: "latest" in entry.posture ? entry.posture.latest : null,
									},
								]
							: advisories.map((advisory) => ({
									key: `${advisory.id} ${entry.advisoryKey}`,
									...base,
									advisoryId: advisory.id,
									url: advisory.url,
									summary: advisory.summary,
									severity: advisory.severity,
									fixedIn: advisory.fixedIn,
								}))
					rows.forEach(({ key, ...row }) => {
						const existing = byAdvisory.get(key)
						byAdvisory.set(
							key,
							existing === undefined
								? { ...row, services: [service] }
								: { ...existing, services: [...existing.services, service] },
						)
					})
				})
				matches.push(...byAdvisory.values())
			}

			if (exposure !== undefined && exposure._tag !== "read")
				notSearched.push(`exposure: ${exposure.message}`)
			else if (exposure !== undefined) {
				const catchAll = new Set(catchAllServices(exposure.signatures).map((entry) => entry.service))
				matches.push(
					...exposure.exposed
						.filter((row) => exposureIdOf(row).toLowerCase() === needle)
						.map((row): Match => ({
							area: "exposure",
							id: exposureIdOf(row),
							service: row.service,
							host: row.host,
							path: row.path,
							category: categoryLabelOf(row.signature),
							severity: catchAll.has(row.service) ? "low" : exposedSeverity(row.signature),
							httpStatus: row.httpStatus,
							requests: row.requests,
							lastSeen: DateTime.formatIso(row.lastSeen),
							sampleTraceId: row.sampleTraceId,
							catchAll: catchAll.has(row.service),
							probes: exposure.signatures
								.filter((probe) => probe.service === row.service && probe.signature !== "")
								.map((probe) => ({
									signature: probe.signature,
									category: categoryLabelOf(probe.signature),
									requests: probe.requests,
									answered: probe.answered,
								})),
						})),
				)
			}

			// An advisory id is a question about everything Maple watches: say what was checked and came up clean.
			const coverage: Array<string> = []
			if (ADVISORY_ID.test(query)) {
				const depHits = matches.flatMap((m) => (m.area === "dependencies" ? [m] : []))
				const runtimeHits = matches.flatMap((m) => (m.area === "runtimes" ? [m] : []))
				// Exposure is what production runs: a service on an affected commit or runtime, whatever the
				// finding's triage. An open finding no service runs is still in the code; a fixed one is not.
				const affected = [
					...new Set(
						matches.flatMap((m) =>
							m.area === "dependencies" || m.area === "runtimes"
								? m.services.map((ref) =>
										ref.environment === ""
											? ref.service
											: `${ref.service} (${ref.environment})`,
									)
								: [],
						),
					),
				]
				const openDeps = depHits.filter((m) => m.status === "open")
				const closedDeps = depHits.filter((m) => m.status !== "open")
				const unscanned =
					dependencies?._tag === "read"
						? dependencies.repositories
								.filter((repo) => repo.latestScan === null)
								.map((repo) => repo.fullName)
						: []
				const unknown =
					unscanned.length === 0 ? "" : `; unknown for ${unscanned.join(", ")} (never scanned)`
				const closed =
					closedDeps.length === 0
						? ""
						: `; ${closedDeps.map((m) => `${m.packageName} in ${m.repository} is ${m.status}`).join(", ")}`
				coverage.push(
					affected.length > 0
						? `Verdict: affected: ${affected.join(", ")}${closed}${unknown}.`
						: openDeps.length > 0
							? `Verdict: affected in code (${openDeps.map((m) => m.repository).join(", ")}), but no production service is known to run it${closed}${unknown}.`
							: closedDeps.length > 0
								? `Verdict: not affected now${closed}${unknown}.`
								: `Verdict: not found in anything Maple checked${unknown}.`,
				)
				if (dependencies?._tag === "read" && dependencies.capped)
					coverage.push(
						"Only the most urgent dependency findings were searched (the read is capped); a lower-ranked match may be missing.",
					)
				// A package advisory says nothing about runtimes and the reverse: report only the side it can be on.
				if (dependencies?._tag === "read" && (depHits.length > 0 || runtimeHits.length === 0)) {
					const scanned = dependencies.repositories.filter((repo) => repo.latestScan !== null)
					coverage.push(
						`Dependencies: checked the latest lockfile scan of ${scanned.map((repo) => repo.fullName).join(", ") || "no repository"}.`,
					)
				}
				if (runtimes?._tag === "read" && (runtimeHits.length > 0 || depHits.length === 0)) {
					const hit = new Set(runtimeHits.flatMap((m) => m.services.map((ref) => ref.service)))
					const clean = runtimes.entries.filter(
						(entry) => entry.advisories !== undefined && !hit.has(entry.row.service),
					)
					const unchecked = runtimes.entries.filter((entry) => entry.advisories === undefined)
					const label = (entry: (typeof runtimes.entries)[number]) =>
						`${entry.row.service} (${runtimeLabelOf(entry)})`
					coverage.push(
						`Runtimes: ${clean.length === 0 ? "no other service was checked" : `not affected: ${clean.map(label).join(", ")}`}${unchecked.length === 0 ? "" : `; not checkable: ${unchecked.map(label).join(", ")}`}.`,
					)
				}
				coverage.push(
					"This is version exposure, not exploitation: list_security_findings area=exposure shows what scanners probed and what services answered.",
				)
			}

			return { query, matches, notSearched, coverage } satisfies Output
		}),
		render: (output) => {
			if (output.matches.length === 0) {
				return {
					title: "Security finding",
					empty: {
						message: `No security finding matches "${output.query}".`,
						hints: [
							"Pass an id from list_security_findings: a code fingerprint, a 32-character dependency finding id, a runtime key (nodejs@20.10.0), an answered probe (service:/path), or an advisory id (CVE-…, GHSA-…).",
							"An advisory id only matches packages and runtime versions Maple has seen in use: no match means none of your scanned lockfiles or running services is affected.",
							...output.notSearched.map((reason) => `Not searched: ${reason}`),
						],
					},
					blocks:
						output.coverage.length === 0
							? []
							: [doc.heading("What was checked"), doc.list(output.coverage)],
					next: [doc.next("list_security_findings", {}, "every area's findings")],
				}
			}
			const blocks = output.matches.flatMap((m) => {
				switch (m.area) {
					case "code":
						return [
							doc.heading(`${m.title} (${m.repository}@${m.branch})`),
							doc.fields([
								["Fingerprint", m.fingerprint],
								["Verdict", m.verdict],
								[
									"Severity",
									m.severityEstimated
										? `${m.severity} (estimated, not confirmed)`
										: m.severity,
								],
								[
									"Status",
									m.statusReason === null
										? m.status
										: `${m.status}${m.statusChangedAt === null ? "" : ` on ${m.statusChangedAt.slice(0, 10)}`}: ${m.statusReason}`,
								],
								["First seen", `${m.firstSeenAt} at ${m.firstSeenRef}`],
								["Last seen", `${m.lastSeenAt} at ${m.lastSeenRef}`],
								[
									"Fixed",
									m.fixedBy === null
										? undefined
										: m.fixedBy.ref === null
											? `audit run ${m.fixedBy.runId} no longer found it`
											: `the audit of ${m.fixedBy.ref} (${m.fixedBy.at}) no longer found it; deploy that commit or later to ship the fix`,
								],
								[
									"Runs in",
									m.services.length === 0
										? "no production service is known to run this repository"
										: `${m.services.map((s) => (s.environment === "" ? s.service : `${s.service} (${s.environment})`)).join(", ")}: they run a commit of ${m.repository}`,
								],
							]),
							doc.text(m.description),
							doc.fields([["Root cause", m.rootCause]]),
							...(m.trace.length === 0
								? []
								: [
										doc.text("Trace, entry point to sink:"),
										doc.table(
											["Step", "Location", "What happens"],
											m.trace.map((step) => [
												step.kind,
												`${step.file}:${step.line}`,
												truncate(step.description, 200),
											]),
										),
									]),
							...(m.evidence.length === 0
								? []
								: [
										doc.text("Evidence:"),
										doc.list(
											m.evidence.map((e) => `${e.file}:${e.line}: ${e.description}`),
										),
									]),
							...(m.exploit === null
								? []
								: [
										doc.text(`Exploit (${m.exploit.attackerPerspective}):`),
										doc.list(m.exploit.instructions),
										...(m.exploit.payloads.length === 0
											? []
											: [doc.code("text", m.exploit.payloads.join("\n"))]),
										doc.fields([["Observed", m.exploit.observedResult]]),
									]),
							...(m.conditions.length === 0
								? []
								: [doc.text("Conditions:"), doc.list(m.conditions)]),
							...(m.remediation === null
								? []
								: [
										doc.fields([["Fix", m.remediation.strategy]]),
										...m.remediation.codeChanges.flatMap((change) => [
											doc.text(change.file),
											doc.code("", change.fixedCode),
										]),
									]),
							...(m.blockers.length === 0
								? []
								: [doc.text("Not confirmed because:"), doc.list(m.blockers)]),
							...(m.validationPlan.length === 0
								? []
								: [doc.text("How to confirm it:"), doc.list(m.validationPlan)]),
							...(m.rejectedBecause === null
								? []
								: [doc.fields([["Rejected because", m.rejectedBecause]])]),
						]
					case "dependencies":
						return [
							doc.heading(`${m.packageName} in ${m.repository} (${displayAdvisory(m)})`),
							doc.fields([
								["Finding id", m.id],
								["Severity", m.severity],
								["Summary", m.summary ?? undefined],
								["Lockfile", `${m.lockfilePath} (${m.ecosystem})`],
								["Installed", m.versions.join(", ")],
								["Fixed in", m.fixedIn ?? "no fixed version published"],
								["Dependency", m.relation],
								["Fix", m.fix],
								["Aliases", m.aliases.join(", ") || undefined],
								[
									"Status",
									m.statusReason === null ? m.status : `${m.status}: ${m.statusReason}`,
								],
								["First seen", `${m.firstSeenAt} at ${m.firstSeenSha.slice(0, 12)}`],
								["Last seen", `${m.lastSeenAt} at ${m.lastSeenSha.slice(0, 12)}`],
							]),
							m.services.length === 0
								? doc.text(
										m.relation === "dev"
											? "A dev dependency: in the lockfile, not in what services run."
											: "No production service is known to run a commit with this package.",
									)
								: doc.table(
										[
											"Service",
											"Environment",
											"Runs commit (lockfile has the package)",
											"Spans (24h)",
										],
										m.services.map((s) => [
											s.service,
											s.environment,
											s.commitSha.slice(0, 12),
											String(s.spans),
										]),
									),
						]
					case "exposure":
						return [
							doc.heading(`${m.service} answered ${m.path} with ${m.httpStatus}`),
							doc.fields([
								[
									"Severity",
									m.catchAll
										? `${m.severity} (the service answers every path)`
										: m.severity,
								],
								["Probe", `${m.category}: ${m.host}${m.path}`],
								[
									"Answered",
									`${m.requests} request${m.requests === 1 ? "" : "s"} got ${m.httpStatus}, last at ${m.lastSeen}`,
								],
								["Sample request", m.sampleTraceId],
							]),
							doc.text(
								m.catchAll
									? `${m.service} answers most probe paths with a 2xx, so this is likely its index or soft-404 page, not the file. Check one response, then make unknown paths return 404.`
									: `Maple saw the status code on the request span, not the response body. A ${m.httpStatus} here means the path exists: fetch it yourself to confirm what it serves, rotate anything it exposes, and block the path.`,
							),
							doc.text(`Every probe path scanners sent ${m.service} in the window:`),
							doc.table(
								["Probe path", "Category", "Requests", "Answered 2xx"],
								m.probes.map((p) => [
									p.signature,
									p.category,
									String(p.requests),
									String(p.answered),
								]),
							),
						]
					case "runtimes":
						return [
							doc.heading(
								m.advisoryId === null
									? `${m.runtime}: ${m.postureNote}`
									: `${m.advisoryId} in ${m.runtime}`,
							),
							doc.fields([
								["Severity", m.severity],
								["Summary", m.summary ?? undefined],
								["Posture", m.postureNote],
								[
									m.advisoryId === null ? "Upgrade to" : "Fixed in",
									m.fixedIn ??
										(m.advisoryId === null
											? "a supported release"
											: "no fix for this line"),
								],
								["Advisory", m.url ?? undefined],
								[
									"Services on this version",
									m.services
										.map((s) =>
											s.environment === ""
												? s.service
												: `${s.service} (${s.environment})`,
										)
										.join(", "),
								],
							]),
						]
				}
			})
			const probe = output.matches.find((m) => m.area === "exposure")
			return {
				title: `Security finding: ${output.query}`,
				blocks:
					output.coverage.length === 0
						? blocks
						: [
								doc.text(output.coverage[0] ?? ""),
								...blocks,
								doc.heading("What was checked"),
								doc.list(output.coverage.slice(1)),
							],
				...(probe === undefined
					? undefined
					: {
							next: [
								doc.next(
									"inspect_trace",
									{ trace_id: probe.sampleTraceId },
									"the probe request that got the answer",
								),
							],
						}),
				...(output.notSearched.length === 0
					? undefined
					: { notices: output.notSearched.map((r) => `Not searched: ${r}`) }),
			}
		},
	})
}
