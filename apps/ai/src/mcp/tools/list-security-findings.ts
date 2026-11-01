import { Clock, DateTime, Effect, Schema } from "effect"
import {
	ListSecurityFindingsOutput,
	SECURITY_AREAS,
	type SecurityArea,
	type SecurityFindingRow,
} from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { truncate } from "../lib/format"
import { doc, type NextCall } from "../lib/tool-doc"
import {
	type AreaResult,
	codeArea,
	countBySeverity,
	dependencyArea,
	exposureArea,
	exposureCategories,
	type FindingFilters,
	matchesFilters,
	postureText,
	rankFindings,
	readCode,
	readDependencies,
	readExposure,
	readRuntimes,
	repositoryServicesOf,
	runtimeArea,
	runtimeLabelOf,
	SEVERITY_FLOORS,
	STATUS_FILTERS,
} from "../lib/security"
import type { McpToolRegistrar } from "./types"

const TOOL = "list_security_findings"
const WINDOW = P.timeWindow({ defaultHours: 24 * 7, maxHours: 24 * 30 })

type Output = typeof ListSecurityFindingsOutput.Type

const AREA_LABEL = {
	code: "Code audit",
	dependencies: "Dependencies",
	exposure: "Exposure",
	runtimes: "Runtimes",
} satisfies Record<SecurityArea, string>

/** The call's filters as next-call arguments, so a follow-up keeps what the user asked for. */
const filterArgs = (filters: Output["filters"]) => ({
	status: filters.status === "open" ? undefined : filters.status,
	severity: filters.severity,
	service: filters.service,
	repository: filters.repository,
})

const isFiltered = (filters: Output["filters"]): boolean =>
	filters.status !== "open" ||
	filters.severity !== undefined ||
	filters.service !== undefined ||
	filters.repository !== undefined

/** What a service or repository filter leaves out by construction, so an empty area is not read as clean. */
const filterNotes = (results: ReadonlyArray<AreaResult>, filters: FindingFilters): ReadonlyArray<string> => {
	const count = (area: SecurityArea) => results.find((result) => result.area === area)?.rows.length ?? 0
	const code = results.find((result) => result.area === "code")?.rows ?? []
	const unmapped = code.filter((row) => row.services.length === 0).length
	const service =
		filters.service === undefined || unmapped === 0
			? []
			: [
					`${unmapped} code audit finding${unmapped === 1 ? " is" : "s are"} in a repository no production service is known to run (no service reports a commit of it), so the service filter leaves ${unmapped === 1 ? "it" : "them"} out.`,
				]
	const telemetry = count("exposure") + count("runtimes")
	const repository =
		filters.repository === undefined || telemetry === 0
			? []
			: [
					`Exposure and runtime findings are per service, not per repository: the repository filter leaves out all ${telemetry}. Filter by service for those.`,
				]
	return [...service, ...repository]
}

export function registerListSecurityFindingsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Security Findings",
		description:
			"Security findings across Maple's Security Center, worst first: the AI code audit's vulnerabilities in " +
			"connected repositories (`code`), known-vulnerable packages in their lockfiles (`dependencies`), scanner probes for secrets, .git, debug endpoints and exploits " +
			"that services answered with a 2xx, plus who is scanning (`exposure`), and services on runtime versions with " +
			"known CVEs, past end of life or behind on patches (`runtimes`). With no `area`, an overview of all four: " +
			"per-area state and counts plus the worst findings. With an `area`, every matching finding of that area and " +
			"its detail tables (probe categories and scanning sources; every service's runtime). `Runs in` names the " +
			"production services running a commit of the finding's repository, so `service` narrows code and " +
			"dependency findings too. Severity is the code " +
			"audit's rating (estimated for unconfirmed leads), the advisory's, critical for a served secrets or .git " +
			"probe and high for other served probes; a runtime takes its worst CVE, else medium past end of life, low " +
			"when behind. Answers 'what are our security issues', 'are we vulnerable', 'is anyone scanning us', 'which " +
			"services run an EOL Node'. `inspect_security_finding` reads one finding or answers 'are we affected by CVE-…'.",
		parameters: Schema.Struct({
			area: P.optionalOneOf(
				SECURITY_AREAS,
				"Only this area, with every finding and its detail. Omit for the overview",
			),
			severity: P.optionalOneOf(SEVERITY_FLOORS, "Only findings at this severity or worse"),
			status: P.optionalOneOf(
				STATUS_FILTERS,
				"Triage state of code and dependency findings (default open). Telemetry findings are always current",
			),
			repository: P.optionalText("Only code and dependency findings of this repository (owner/name)"),
			service: P.service("Only findings that reach this service (exact `service.name`)"),
			limit: P.limit({ default: 30, max: 200, noun: "findings" }),
			offset: P.offset({ max: 2000 }),
			...WINDOW.fields,
		}),
		output: ListSecurityFindingsOutput,
		hints: { readOnly: true },
		phrases: ["Checking security findings", "Reading the Security Center"],
		handler: Effect.fn("McpTool.listSecurityFindings")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const window = { startTime: st, endTime: et }
			// A repository filter has nothing to keep in the per-service telemetry areas, so the overview skips them.
			const telemetry = (area: SecurityArea) => area === "exposure" || area === "runtimes"
			const wanted = (area: SecurityArea) =>
				params.area === undefined
					? params.repository === undefined || !telemetry(area)
					: params.area === area
			const skip = Effect.succeed(undefined)
			// Code findings borrow the dependency scanner's repository-to-service join, so they read it too.
			const [codeRead, dependencyRead, exposure, runtimes] = yield* Effect.all(
				[
					wanted("code") ? readCode(tenant) : skip,
					wanted("dependencies") || wanted("code") ? readDependencies(tenant) : skip,
					wanted("exposure") ? readExposure(tenant, window) : skip,
					wanted("runtimes") ? readRuntimes(tenant, window) : skip,
				],
				{ concurrency: 4 },
			)
			const filters: FindingFilters = {
				severity: params.severity,
				status: params.status ?? "open",
				repository: params.repository,
				service: params.service,
			}
			const results = [
				codeRead === undefined ? undefined : codeArea(codeRead, repositoryServicesOf(dependencyRead)),
				dependencyRead === undefined || !wanted("dependencies")
					? undefined
					: dependencyArea(dependencyRead),
				exposure === undefined ? undefined : exposureArea(exposure),
				runtimes === undefined ? undefined : runtimeArea(runtimes),
			].filter((result) => result !== undefined)
			const matched = results.map((result) => result.rows.filter((row) => matchesFilters(row, filters)))
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.security.area": params.area ?? "all",
				"result.rowCount": matched.flat().length,
			})
			return {
				generatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
				window,
				...(params.area === undefined ? undefined : { areaFilter: params.area }),
				filters: {
					status: filters.status,
					...(filters.severity === undefined ? undefined : { severity: filters.severity }),
					...(filters.service === undefined ? undefined : { service: filters.service }),
					...(filters.repository === undefined ? undefined : { repository: filters.repository }),
				},
				areas: results.map((result, i) => ({
					area: result.area,
					// Read areas say whether anything matched the call; the rest say why nothing was read.
					state:
						result.state === "findings" || result.state === "clear"
							? (matched[i]?.length ?? 0) > 0
								? "findings"
								: "clear"
							: result.state,
					summary: result.summary,
					// Per severity, what the call's filters kept (open findings by default).
					counts: countBySeverity(matched[i] ?? []),
					matched: matched[i]?.length ?? 0,
				})),
				findings: rankFindings(matched.flat()).slice(params.offset, params.offset + params.limit),
				offset: params.offset,
				notes: [...filterNotes(results, filters), ...results.flatMap((result) => result.notes)],
				...(params.area === "exposure" && exposure?._tag === "read"
					? {
							exposure: {
								categories: exposureCategories(exposure, params.service),
								sources: exposure.sources.map((row) => ({
									address: row.clientAddress,
									requests: row.requests,
									signatures: row.signatures,
									scanner: row.scanner,
									userAgent: row.userAgent,
									lastSeen: DateTime.formatIso(row.lastSeen),
								})),
							},
						}
					: undefined),
				...(params.area === "runtimes" && runtimes?._tag === "read"
					? {
							runtimes: runtimes.entries.map((entry) => ({
								service: entry.row.service,
								environment: entry.row.environment,
								runtime: runtimeLabelOf(entry),
								posture: entry.posture.status,
								note: postureText(entry.posture),
								advisories: entry.advisories?.length ?? null,
								sdk:
									[entry.row.sdkName, entry.row.sdkVersion]
										.filter((part) => part !== "")
										.join(" ") || entry.row.sdkLanguage,
							})),
						}
					: undefined),
			} satisfies Output
		}),
		render: (output) => {
			const matched = output.areas.reduce((n, area) => n + area.matched, 0)
			const nextCalls: Array<NextCall> = []
			const worst = output.findings[0]
			if (worst !== undefined)
				nextCalls.push(
					doc.next("inspect_security_finding", { id: worst.id }, "the worst finding in full"),
				)
			if (output.areaFilter === undefined)
				nextCalls.push(
					...output.areas
						.filter((area) => area.matched > 0)
						.map((area) =>
							doc.next(
								TOOL,
								{ ...filterArgs(output.filters), area: area.area },
								`every ${area.area} finding`,
							),
						),
				)
			if (output.areaFilter === "exposure") {
				const exposed = output.findings.find((row) => row.area === "exposure")
				if (exposed !== undefined && exposed !== worst)
					nextCalls.push(
						doc.next(
							"inspect_security_finding",
							{ id: exposed.id },
							"what that service answered, probe by probe",
						),
					)
			}

			return {
				title:
					output.areaFilter === undefined
						? "Security findings"
						: `Security findings: ${output.areaFilter}`,
				scope: [
					[
						"Status",
						output.areas.some((area) => area.area === "code" || area.area === "dependencies")
							? output.filters.status === "all"
								? "any (code and dependency findings)"
								: `${output.filters.status} (code and dependency findings)`
							: undefined,
					],
					[
						"Severity",
						output.filters.severity === undefined
							? undefined
							: `${output.filters.severity} or worse`,
					],
					["Service", output.filters.service],
					["Repository", output.filters.repository],
					[
						"Telemetry window (exposure, runtimes)",
						output.areas.some((area) => area.area === "exposure" || area.area === "runtimes")
							? `${output.window.startTime} to ${output.window.endTime}`
							: undefined,
					],
				],
				blocks: [
					doc.table(
						[
							"Area",
							"State",
							"Critical",
							"High",
							"Medium",
							"Low",
							// The counts follow the filters; the summary always describes the whole area.
							isFiltered(output.filters) ? "Area summary (unfiltered)" : "Summary",
						],
						output.areas.map((area) => [
							AREA_LABEL[area.area],
							area.state,
							String(area.counts.critical),
							String(area.counts.high),
							String(area.counts.medium),
							String(area.counts.low),
							area.summary,
						]),
					),
					...(output.findings.length === 0
						? [
								doc.text(
									matched === 0
										? "No finding matches the filters."
										: `offset ${output.offset} is past the last of the ${matched} matching findings; lower it.`,
								),
							]
						: [
								doc.heading("Findings, worst first"),
								doc.table(
									[
										"Severity",
										"Area",
										"Finding",
										"Where",
										"Status",
										"Detail",
										"Runs in",
										"ID",
									],
									output.findings.map((row) => [
										row.severity,
										row.area,
										truncate(row.title, 140),
										truncate(row.location, 100),
										row.status,
										truncate(row.detail, 240),
										row.services.length === 0
											? row.area === "code"
												? "unknown"
												: ""
											: row.services
													.map((s) =>
														s.environment === ""
															? s.service
															: `${s.service} (${s.environment})`,
													)
													.join(", "),
										row.id,
									]),
								),
							]),
					...(output.exposure === undefined
						? []
						: [
								doc.heading(
									output.filters.service === undefined
										? "Probe traffic by category"
										: `Probe traffic by category: ${output.filters.service}`,
								),
								doc.table(
									["Category", "Requests", "Answered 2xx", "Services", "Top paths"],
									output.exposure.categories.map((c) => [
										c.label,
										String(c.requests),
										c.answered === null ? "n/a (ordinary pages)" : String(c.answered),
										String(c.services),
										c.topPaths.join(" "),
									]),
								),
								doc.heading("Busiest scanning sources (all services)"),
								doc.table(
									[
										"Address",
										"Requests",
										"Probe paths",
										"Scanner",
										"User agent",
										"Last seen",
									],
									output.exposure.sources.map((s) => [
										s.address,
										String(s.requests),
										String(s.signatures),
										s.scanner,
										truncate(s.userAgent, 80),
										s.lastSeen,
									]),
								),
							]),
					...(output.runtimes === undefined
						? []
						: [
								doc.heading("Every service's runtime"),
								doc.table(
									["Service", "Environment", "Runtime", "Posture", "Known CVEs", "SDK"],
									output.runtimes.map((r) => [
										r.service,
										r.environment,
										r.runtime,
										r.note,
										r.advisories === null ? "not checked" : String(r.advisories),
										r.sdk,
									]),
								),
							]),
					...(output.notes.length === 0 ? [] : [doc.heading("Notes"), doc.list(output.notes)]),
				],
				...(output.offset + output.findings.length < matched
					? {
							truncation: {
								shown: output.findings.length,
								total: matched,
								noun: `findings from #${output.offset + 1}`,
								next: doc.next(
									TOOL,
									{
										...filterArgs(output.filters),
										area: output.areaFilter,
										// The same window, so the next page ranks the same findings.
										start_time: output.window.startTime,
										end_time: output.window.endTime,
										offset: output.offset + output.findings.length,
										limit: output.findings.length,
									},
									"the next findings",
								),
							},
						}
					: undefined),
				next: nextCalls.slice(0, 4),
			}
		},
	})
}
