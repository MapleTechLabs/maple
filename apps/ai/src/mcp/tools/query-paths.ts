import { Effect, Order, Schema, Array as Arr, String as Str } from "effect"
import {
	DEFAULT_PATHS_DEPTH,
	FunnelKeyBy,
	funnelStepLabel,
	PATHS_MAX_BRANCHES,
	PATHS_MAX_DEPTH,
	PATHS_OTHER,
	PathsAnchor,
	PathsDirection,
	PathsInclude,
	type FunnelStep,
	type PathsDirection as PathsDirectionType,
} from "@maple/query-model"
import { productEventsPaths } from "@maple/query-engine/observability"
import { QueryPathsOutput } from "@maple/domain/mcp-outputs"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import { CurrentMcpTenant } from "../tenant"
import { MCP_PRODUCT_EVENTS_MAX_HOURS } from "../lib/time"
import { formatNumber, formatPercent, truncate } from "../lib/format"
import { stringifyJson } from "../lib/json"
import * as P from "../lib/params"
import { doc, type DocBlock } from "../lib/tool-doc"

const TOOL = "query_paths"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_PRODUCT_EVENTS_MAX_HOURS })
const DEFAULT_WINDOW_SECONDS = 24 * 3600
/** A table has room for more branches than a chart's four. */
const DEFAULT_BRANCHES = 6
/** Transitions shown per hop past the first; the structured output keeps all of them. */
const EDGE_ROWS = 12

const ANCHOR_EXAMPLE = '{"kind":"event","eventName":"signup_completed"}'

type Output = typeof QueryPathsOutput.Type
type Hop = Output["hops"][number]

interface Counted {
	readonly name: string
	readonly count: number
}
const byCountThenName: Order.Order<Counted> = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (entry: Counted) => entry.count),
	Order.mapInput(Order.String, (entry: Counted) => entry.name),
)

/**
 * `{ hop, fromNode, toNode, count }` rows as one entry per hop: the column's nodes with how many
 * reached each, and the transitions into it. The first hop's rows all leave the anchor, so their
 * sum is everyone who reached it.
 */
export const pathHops = (
	rows: ReadonlyArray<{
		readonly hop: number
		readonly fromNode: string
		readonly toNode: string
		readonly count: number
	}>,
): Pick<Output, "hops" | "total"> => {
	const byHop = Arr.groupBy(rows, (row) => String(row.hop))
	const hops = Arr.map(Arr.sort(Arr.dedupe(Arr.map(rows, (row) => row.hop)), Order.Number), (hop): Hop => {
		const edges = byHop[String(hop)] ?? []
		const reached = new Map<string, number>()
		Arr.forEach(edges, (edge) => reached.set(edge.toNode, (reached.get(edge.toNode) ?? 0) + edge.count))
		return {
			hop,
			nodes: Arr.sort(
				Arr.map([...reached], ([name, count]) => ({ name, count })),
				byCountThenName,
			),
			edges: Arr.map(
				Arr.sort(
					Arr.map(edges, (edge) => ({ name: `${edge.fromNode} ${edge.toNode}`, ...edge })),
					byCountThenName,
				),
				(edge) => ({ from: edge.fromNode, to: edge.toNode, count: edge.count }),
			),
		}
	})
	const first = hops[0]
	return {
		hops,
		total: first === undefined ? 0 : Arr.reduce(first.nodes, 0, (sum, node) => sum + node.count),
	}
}

/** A node as a reader sees it: the two sentinels spelled out. */
const nodeLabel = (name: string, direction: PathsDirectionType): string =>
	name === ""
		? direction === "after"
			? "(nothing after)"
			: "(nothing before)"
		: name === PATHS_OTHER
			? "(other)"
			: truncate(name, 60)

export function registerQueryPathsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Query Paths",
		description:
			'What people do right after one event or page view, or with `direction="before"` what led up to it: each hop away from the anchor with the most common next events and pages and how many went that way. ' +
			"Per person, the walk starts at their first anchor in the window (their last, going backward); consecutive repeats count once. " +
			'Answers "what do people do after signing up" and "what do people do before cancelling". For conversion between named steps use `query_funnel`.',
		parameters: Schema.Struct({
			anchor_json: P.json(
				PathsAnchor,
				`The event or page the paths start from, as JSON: {kind:"event", eventName, attributeEquals?} or {kind:"page", pagePath, host?}. Example: ${ANCHOR_EXAMPLE}`,
			),
			direction: P.optionalOneOf(
				PathsDirection.literals,
				"`after` (default): what followed the anchor. `before`: what led up to it.",
			),
			depth: P.optionalNumber(
				`Hops away from the anchor, 1 to ${PATHS_MAX_DEPTH}. Default ${DEFAULT_PATHS_DEPTH}.`,
			),
			branches: P.optionalNumber(
				`Events and pages named per hop, 1 to ${PATHS_MAX_BRANCHES}; the rest fold into (other). Default ${DEFAULT_BRANCHES}.`,
			),
			key_by: P.optionalOneOf(
				FunnelKeyBy.literals,
				"Whose history a path is: `person` (default), `visitor`, `user`, `group` (the account) or `session`.",
			),
			window_seconds: P.optionalNumber(
				"How far from the anchor a hop may be, in seconds. Default 86400 (24h).",
			),
			include: P.optionalOneOf(
				PathsInclude.literals,
				"`all` (default), only `events` (track() and server events) or only `pages` (page and screen views).",
			),
			exclude: P.optionalList(
				"Event names or page paths left out before the paths are built, such as a heartbeat event or `/`",
			),
			...WINDOW.fields,
			host: P.optionalText("Only persons with a session on this site host."),
			country: P.optionalText("Only persons with a session from this country (ISO code)."),
			utm_source: P.optionalText("Only persons with a session carrying this utm_source."),
			device_type: P.optionalText(
				"Only persons with a session on this device type (desktop, mobile, tablet).",
			),
		}),
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Tracing paths", "Following what people did next"],
		handler: Effect.fn("McpTool.queryPaths")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const anchor = params.anchor_json
			const direction = params.direction ?? "after"
			const depth = params.depth ?? DEFAULT_PATHS_DEPTH
			const branches = params.branches ?? DEFAULT_BRANCHES
			const keyBy = params.key_by ?? "person"
			const windowSeconds = params.window_seconds ?? DEFAULT_WINDOW_SECONDS
			if (Str.trim(anchor.kind === "event" ? anchor.eventName : anchor.pagePath) === "") {
				return yield* new McpInvalidInputError({
					message: "anchor_json needs an event name or a page path to start from.",
					parameter: "anchor_json",
					example: ANCHOR_EXAMPLE,
				})
			}

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.direction": direction,
				"maple.ai.depth": depth,
				"maple.ai.key_by": keyBy,
			})

			const exclude = Arr.filter(params.exclude ?? [], (name) => Str.trim(name) !== "")
			const rows = yield* withTenantExecutor(
				productEventsPaths({
					anchor,
					direction,
					depth,
					branches,
					keyBy,
					windowSeconds,
					include: params.include ?? "all",
					...(exclude.length > 0 ? { exclude } : undefined),
					filters: {
						host: params.host,
						country: params.country,
						utmSource: params.utm_source,
						deviceType: params.device_type,
					},
					startTime: st,
					endTime: et,
				}),
			).pipe(
				Effect.catchTags(warehouseToMcpHandlers(TOOL)),
				// Depth, branches and the window are the builder's to check; its rejection is a caller error.
				Effect.catchTag("@maple/query-engine/ProductEventsFunnelError", (error) =>
					Effect.fail(
						new McpInvalidInputError({
							message: error.message,
							parameter: error.reason === "InvalidWindow" ? "window_seconds" : "depth",
						}),
					),
				),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)

			return {
				timeRange: { start: st, end: et },
				anchor,
				direction,
				depth,
				keyBy,
				windowSeconds,
				...pathHops(rows),
			}
		}),
		render: (output) => {
			const { direction, total } = output
			const anchorLabel = funnelStepLabel(output.anchor)
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const anchorJson = stringifyJson(output.anchor)
			const noun = output.keyBy === "person" ? "persons" : `${output.keyBy}s`
			const share = (count: number): string => (total === 0 ? "-" : formatPercent(count / total))
			const blocks: Array<DocBlock> = Arr.flatMap(output.hops, (hop) => [
				doc.heading(`${hop.hop} ${hop.hop === 1 ? "step" : "steps"} ${direction}`),
				doc.table(
					[direction === "after" ? "Then" : "Before that", noun, `Of the ${formatNumber(total)}`],
					Arr.map(hop.nodes, (node) => [
						nodeLabel(node.name, direction),
						formatNumber(node.count),
						share(node.count),
					]),
				),
				// The first hop's transitions all leave the anchor: the table above already is them.
				...(hop.hop === 1
					? []
					: [
							doc.table(
								["From", "To", noun],
								Arr.map(hop.edges.slice(0, EDGE_ROWS), (edge) => [
									nodeLabel(edge.from, direction),
									nodeLabel(edge.to, direction),
									formatNumber(edge.count),
								]),
							),
						]),
			])
			// The busiest real next step, for the funnel that measures it.
			const topNext = Arr.findFirst(
				output.hops[0]?.nodes ?? [],
				(node) => node.name !== "" && node.name !== PATHS_OTHER,
			)
			const nextStep = (name: string): FunnelStep =>
				Str.startsWith("/")(name)
					? { kind: "page", pagePath: name }
					: { kind: "event", eventName: name }
			return {
				title: `Paths ${direction} ${truncate(anchorLabel, 60)} (by ${output.keyBy}, within ${output.windowSeconds}s)`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Reached the anchor", `${formatNumber(total)} ${noun}`],
				],
				...(total === 0
					? {
							empty: {
								message: `Nobody did ${anchorLabel} in this window.`,
								hints: [
									"Widen start_time/end_time, or check the name against `list_product_events`.",
								],
							},
						}
					: undefined),
				blocks: total === 0 ? [] : blocks,
				next: [
					...(topNext._tag === "Some" && direction === "after"
						? [
								doc.next(
									"query_funnel",
									{
										steps_json: stringifyJson([
											output.anchor,
											nextStep(topNext.value.name),
										]),
										...window,
									},
									"measure the conversion into the most common next step",
								),
							]
						: []),
					doc.next(
						TOOL,
						{
							anchor_json: anchorJson,
							direction: direction === "after" ? "before" : "after",
							...window,
						},
						direction === "after" ? "what led up to it" : "what followed it",
					),
				],
			}
		},
	})
}
