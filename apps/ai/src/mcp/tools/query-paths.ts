import { Clock, Effect, Order, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
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
import { PROPERTY_FILTER_FIELDS, propertyFilterArgs, propertyFiltersOf } from "../lib/attribute-filters"
import { doc, type DocBlock } from "../lib/tool-doc"
import { sessionRetentionNote } from "../lib/product-identity"
import { readHorizonDays } from "../lib/read-horizon"

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
			...PROPERTY_FILTER_FIELDS,
		}),
		untrustedOutput: true,
		hints: { readOnly: true },
		permission: "telemetry:read",
		phrases: ["Tracing paths", "Following what people did next"],
		handler: Effect.fn("McpTool.queryPaths")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const anchor = params.anchor_json
			const filters = {
				host: params.host,
				country: params.country,
				utmSource: params.utm_source,
				deviceType: params.device_type,
			}
			const givenFilters = Rec.filter(
				{
					host: params.host,
					country: params.country,
					utm_source: params.utm_source,
					device_type: params.device_type,
				},
				(value): value is string => value !== undefined,
			)
			const nowMs = yield* Clock.currentTimeMillis
			const sessionsKeptDays = yield* readHorizonDays("sessions")
			const sessionNote = sessionRetentionNote(
				{ startTime: st, endTime: et },
				nowMs,
				Arr.some(Rec.values(filters), (value) => value !== undefined),
				sessionsKeptDays,
			)
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
					filters,
					...(yield* propertyFiltersOf(params)),
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
							parameter:
								error.reason === "InvalidWindow"
									? "window_seconds"
									: Str.includes("branches")(error.message)
										? "branches"
										: "depth",
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
				...(sessionNote === undefined ? undefined : { sessionNote }),
				...(Rec.isEmptyRecord({ ...givenFilters, ...propertyFilterArgs(params) })
					? undefined
					: { filters: { ...givenFilters, ...propertyFilterArgs(params) } }),
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
							// `from` is the node nearer the anchor: going backward that is the later one,
							// so the columns swap to keep the table reading forward in time.
							doc.table(
								direction === "after" ? ["From", "To", noun] : ["Earlier", "Later", noun],
								Arr.map(hop.edges.slice(0, EDGE_ROWS), (edge) => [
									nodeLabel(direction === "after" ? edge.from : edge.to, direction),
									nodeLabel(direction === "after" ? edge.to : edge.from, direction),
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
			// The people and the reach a follow-up has to keep to measure the same thing.
			const samePopulation = {
				...(output.keyBy === "person" ? undefined : { key_by: output.keyBy }),
				...(output.windowSeconds === DEFAULT_WINDOW_SECONDS
					? undefined
					: { window_seconds: output.windowSeconds }),
				...output.filters,
				...window,
			}
			return {
				title: `Paths ${direction} ${truncate(anchorLabel, 60)} (by ${output.keyBy}, within ${output.windowSeconds}s)`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Reached the anchor", `${formatNumber(total)} ${noun}`],
				],
				...(output.sessionNote === undefined ? undefined : { notices: [output.sessionNote] }),
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
										...samePopulation,
									},
									// A node is a name alone: a mobile screen reads like an event here.
									Str.startsWith("/")(topNext.value.name)
										? "measure the conversion into the most common next step"
										: 'measure the conversion into the most common next step (if it is a mobile screen and not an event, make it {"kind":"page","pagePath":<the name>})',
								),
							]
						: []),
					doc.next(
						TOOL,
						{
							anchor_json: anchorJson,
							direction: direction === "after" ? "before" : "after",
							...samePopulation,
						},
						direction === "after" ? "what led up to it" : "what followed it",
					),
				],
			}
		},
	})
}
