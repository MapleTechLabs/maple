import { Effect, Schema } from "effect"
import { ListInfraOutput } from "@maple/domain/mcp-outputs"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall } from "../lib/tool-doc"
import { infraPresence, listInfraKind, WORKLOAD_KINDS, type InfraFilters } from "../lib/infra"
import { INFRA_KINDS, optionalInfraKind } from "../lib/infra-params"
import {
	ENTITY_KIND,
	KIND_METRICS,
	KIND_NOUN,
	hottest,
	kindTable,
	statusOf,
	summaryLine,
	windowText,
} from "../lib/infra-render"

const TOOL = "list_infra"
const WINDOW = P.timeWindow({ defaultHours: 1, maxHours: MCP_DISCOVERY_MAX_HOURS })

const SORTS = ["saturation", "cpu", "memory", "name", "last_seen"] as const
const STATUSES = ["hot", "at_limit", "no_limits"] as const
/** Rows per kind in the all-kinds overview: enough to spot the hot ones. */
const OVERVIEW_ROWS = 5

/** The filters each kind can apply; search and status apply to every kind. */
const KIND_FILTERS = {
	hosts: new Set<keyof InfraFilters>(["host"]),
	pods: new Set<keyof InfraFilters>([
		"namespace",
		"cluster",
		"node",
		"workload",
		"workloadKind",
		"environment",
	]),
	nodes: new Set<keyof InfraFilters>(["cluster", "node", "environment"]),
	workloads: new Set<keyof InfraFilters>([
		"namespace",
		"cluster",
		"workload",
		"workloadKind",
		"environment",
	]),
	containers: new Set<keyof InfraFilters>(["host", "workload", "environment"]),
} satisfies Record<(typeof INFRA_KINDS)[number], ReadonlySet<keyof InfraFilters>>
const SCOPING_FILTERS: ReadonlyArray<keyof InfraFilters> = [
	"host",
	"namespace",
	"cluster",
	"node",
	"workload",
	"workloadKind",
	"environment",
]

/** In an overview, a kind that cannot apply a given filter would list unrelated rows; leave it out. */
const supports =
	(filters: InfraFilters) =>
	(kind: (typeof INFRA_KINDS)[number]): boolean =>
		SCOPING_FILTERS.every((key) => filters[key] === undefined || KIND_FILTERS[kind].has(key))

export function registerListInfraTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Infrastructure",
		description:
			"Hosts, Kubernetes pods/nodes/workloads and Docker containers reporting resource metrics, closest to a limit first: CPU, memory and disk use, CPU/memory against limits, pod counts. " +
			"Without `kind` it returns an overview of every kind that reports, with fleet counts and the top 5 of each. " +
			"Filter with search, namespace, node, host, workload, and status (hot, at_limit, no_limits). " +
			"Use it to answer 'is anything running hot?', 'which pods have no limits?', 'what runs on this node?', then inspect_infra for one entity over time. " +
			"Status reflects the window peak, not the latest sample.",
		parameters: Schema.Struct({
			kind: optionalInfraKind("Which kind to list. Omit for an overview of every kind that reports"),
			search: P.optionalText("Case-insensitive substring of the entity name"),
			namespace: P.optionalText("Only this Kubernetes namespace (pods, workloads)"),
			cluster: P.optionalText("Only this Kubernetes cluster (pods, nodes, workloads)"),
			node: P.optionalText("Only pods on this Kubernetes node"),
			host: P.optionalText("Only containers on this host"),
			workload: P.optionalText(
				"Only pods owned by this workload (with workload_kind), or containers of this compose service",
			),
			workload_kind: P.optionalOneOf(
				WORKLOAD_KINDS,
				"Kubernetes workload kind (workloads, and pods with `workload`)",
			),
			environment: P.environment(
				"Only this deployment environment (pods, nodes, workloads, containers)",
			),
			status: P.optionalOneOf(
				STATUSES,
				"hot: peak at 60% or more of a limit (hosts: average CPU/memory or fullest disk); at_limit: 90% or more; no_limits: pods and workloads with no CPU or memory limit",
			),
			include_ended: P.optionalFlag(
				"Pods only: also list pods that stopped reporting during the window (rollouts, OOM kills)",
			),
			sort: P.optionalOneOf(SORTS, "Sort order (default saturation: closest to a limit first)"),
			limit: P.limit({ default: 20, max: 200, noun: "rows per kind" }),
			...WINDOW.fields,
		}),
		output: ListInfraOutput,
		hints: { readOnly: true },
		phrases: ["Listing infrastructure", "Checking hosts, pods and containers"],
		handler: Effect.fn("McpTool.listInfra")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			const sort = params.sort ?? "saturation"
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, kind: params.kind ?? "overview" })
			const window = { startTime: st, endTime: et }
			const filters = {
				search: params.search,
				namespace: params.namespace,
				cluster: params.cluster,
				node: params.node,
				host: params.host,
				workload: params.workload,
				workloadKind: params.workload_kind,
				environment: params.environment,
				status: params.status,
				includeEnded: params.include_ended,
			}

			const { reporting, sections } = yield* withTenantExecutor(
				Effect.gen(function* () {
					const reporting = yield* infraPresence(window)
					const kinds =
						params.kind === undefined ? reporting.filter(supports(filters)) : [params.kind]
					const limit =
						params.kind === undefined ? Math.min(params.limit, OVERVIEW_ROWS) : params.limit
					const sections = yield* Effect.forEach(
						kinds,
						(kind) => listInfraKind(kind, { window, filters, sort, limit }),
						{ concurrency: 3 },
					)
					return { reporting, sections }
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))
			yield* Effect.annotateCurrentSpan(
				"result.rowCount",
				sections.reduce((sum, section) => sum + section.rows.length, 0),
			)

			return {
				timeRange: { start: st, end: et },
				reporting,
				sections,
				...(params.kind === undefined ? undefined : { kind: params.kind }),
				...(params.search === undefined ? undefined : { search: params.search }),
				...(params.sort === undefined ? undefined : { sort: params.sort }),
				...(params.status === undefined ? undefined : { status: params.status }),
			}
		}),
		render: (output) => {
			const notices: Array<string> = []
			if (output.kind !== undefined && !output.reporting.includes(output.kind)) {
				notices.push(
					output.reporting.length === 0
						? `No ${KIND_NOUN[output.kind]} report metrics in this window, and neither does any other kind.`
						: `No ${KIND_NOUN[output.kind]} report metrics in this window. Reporting: ${output.reporting.join(", ")}.`,
				)
			}
			const nonEmpty = output.sections.filter((section) => section.rows.length > 0)
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const blocks: Array<DocBlock> = nonEmpty.flatMap((section) => {
				return [
					doc.heading(KIND_NOUN[section.kind]),
					doc.text(summaryLine(section, output.status)),
					kindTable(section),
					doc.text(KIND_METRICS[section.kind]),
					...(section.truncated && output.kind === undefined
						? [doc.text(`More ${KIND_NOUN[section.kind]}: list_infra kind="${section.kind}".`)]
						: []),
				]
			})
			// A search that names one entity exactly is a request to look at that entity.
			const exact = nonEmpty.flatMap((section) =>
				section.rows.filter((row) => row.name === output.search).map((row) => ({ section, row })),
			)
			const exactNext: Array<NextCall> = exact.map(({ section, row }) =>
				doc.next(
					"inspect_infra",
					{
						kind: ENTITY_KIND[section.kind],
						name: row.name,
						namespace: row.namespace,
						host: section.kind === "containers" ? row.host : undefined,
						...window,
					},
					section.kind === "nodes"
						? `${row.name}: its pods, CPU over the window and peer nodes`
						: `${row.name} over the window`,
				),
			)
			const next: Array<NextCall> = nonEmpty.flatMap((section) => {
				const hot = hottest(section)
				const target = hot ?? section.rows[0]
				if (target === undefined) return []
				return [
					doc.next(
						"inspect_infra",
						{
							kind: ENTITY_KIND[section.kind],
							name: target.name,
							namespace: target.namespace,
							host: section.kind === "containers" ? target.host : undefined,
							workload_kind:
								section.kind === "workloads" && target.workloadKind !== undefined
									? target.workloadKind
									: undefined,
							...window,
						},
						hot === undefined
							? `see ${target.name} over the same window`
							: `${target.name} (${statusOf(hot, section.kind)}): see when it peaked`,
					),
				]
			})
			const truncatedSingle = output.kind !== undefined ? nonEmpty[0] : undefined
			return {
				title:
					output.kind === undefined
						? "Infrastructure overview"
						: `Infrastructure: ${KIND_NOUN[output.kind]}`,
				scope: [
					["Window", `${windowText(output.timeRange)}; start_time widens it`],
					["Reporting", output.reporting.length === 0 ? "nothing" : output.reporting.join(", ")],
					["Search", output.search],
					["Sort", output.sort],
				],
				...(nonEmpty.length === 0
					? {
							empty: {
								message:
									output.reporting.length === 0
										? "No infrastructure metrics in this window: no hostmetrics, kubeletstats or docker stats receivers are reporting."
										: "Nothing matched these filters.",
								hints:
									output.reporting.length === 0
										? [
												"Widen start_time/end_time if the collector was down.",
												"Infra pages need an OpenTelemetry Collector with the hostmetrics, kubeletstats or docker_stats receiver; audit_setup checks what is configured.",
											]
										: ["Drop search/namespace/status, or pick a kind from Reporting."],
							},
						}
					: undefined),
				blocks,
				notices,
				...(truncatedSingle?.truncated === true
					? {
							truncation: {
								shown: truncatedSingle.rows.length,
								noun: KIND_NOUN[truncatedSingle.kind],
							},
						}
					: undefined),
				next: [
					...exactNext,
					...next.filter((call) => !exactNext.some((e) => e.args.name === call.args.name)),
					...(output.reporting.length === 0
						? [doc.next("audit_setup", {}, "check which collectors report")]
						: []),
				],
			}
		},
	})
}
