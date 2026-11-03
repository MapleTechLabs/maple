import { GCP_INFRA_SERVICES } from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	formatGcpValue,
	GCP_INFRA_COLUMNS,
	GCP_RESOURCES_TAB,
	gcpAssetTypeLabel,
	gcpWorkloadLocation,
	gcpWorkloadName,
	gcpWorkloadProject,
	gcpWorkloadSearch,
	gcpWorkloadTone,
} from "../../components/infra/gcp/tabs"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "@maple/views/ui/heading"
import { AppRoute, hrefOf } from "../../route"
import { emptyMessage } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { countChipItem } from "./kit/count-chip"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { statRail } from "../kit/stat-rail"
import { valueClass } from "../infra-integrations/gcp/list/view-tables"
import { Message } from "./message"
import type { Model } from "./model"
import { fleetOf, gcpTitles, inventoryOf, logTiles, metricsTiles } from "./view-gcp-band"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

// `Workloads`, `Resources` and `GcpUsageBand`.

type H = HtmlBuilder<Message>

const TONE_ORDER = ["crit", "warn", "neutral"] as const
const VALUES_SHOWN = 3
const VALUE_VISIBLE = ["flex", "hidden @sm:flex", "hidden @lg:flex"]
const WINDOW = "24h"

const workloads = (h: H, model: Model, className: string): Html => {
	const fleet = fleetOf(model)
	if (fleet === null) return skeleton(h, cn("h-40 rounded-md", className))
	const services = fleet === "failed" ? [] : Arr.filter(fleet, ({ workloads: list }) => list.length > 0)
	const unread = fleet === "failed" ? [] : Arr.filter(fleet, ({ failed }) => failed)
	const chosen = model.gcpCard.workloadFilter.values[0] ?? "all"
	const service = Arr.some(services, (entry) => entry.service === chosen) ? chosen : "all"
	const all = Arr.flatMap(services, (entry) =>
		Arr.map(entry.workloads, (workload) => ({ service: entry.service, workload })),
	)
	const rows = Arr.filter(all, (row) => service === "all" || row.service === service).toSorted(
		(a, b) =>
			TONE_ORDER.indexOf(gcpWorkloadTone(a.workload)) -
				TONE_ORDER.indexOf(gcpWorkloadTone(b.workload)) ||
			Str.localeCompare(gcpWorkloadName(b.service, b.workload.keys))(
				gcpWorkloadName(a.service, a.workload.keys),
			),
	)
	const manyProjects =
		new Set(Arr.map(all, (row) => gcpWorkloadProject(row.service, row.workload.keys))).size > 1
	return panel(h, { className: cn("@container border-border-subtle", className) }, [
		panelHeader(h, {
			className: "gap-2 border-border-subtle pr-2.5",
			children: [
				h.div(
					[h.Class("flex min-w-0 flex-1 items-baseline gap-3")],
					[
						heading(h, { level: 3, variant: "section" }, ["Workloads"]),
						typography(h, { size: "2xs", tone: "muted", truncate: true }, ["last 24h"]),
					],
				),
				...(services.length > 1
					? [
							ToggleGroup.view(h, {
								model: { ...model.gcpCard.workloadFilter, values: [service] },
								toParentMessage: (message) => Message.GotWorkloadFilterMessage({ message }),
								isConnected: false,
								size: "xs",
								className: "gap-1.5",
								items: [
									countChipItem(h, { value: "all", label: "All", count: all.length }),
									...Arr.map(services, (entry) =>
										countChipItem(h, {
											value: entry.service,
											label: GCP_INFRA_SERVICES[entry.service].title,
											count: entry.workloads.length,
										}),
									),
								],
							}),
						]
					: []),
			],
		}),
		...(unread.length === 0
			? []
			: [
					h.p(
						[h.Class("border-b border-border-subtle px-4 py-2 text-2xs text-severity-warn")],
						[`${gcpTitles(unread)} metrics could not be read. Reload to try again.`],
					),
				]),
		...(rows.length === 0
			? unread.length > 0
				? []
				: [
						emptyMessage(h, { className: "px-3 py-10" }, [
							fleet === "failed"
								? "Not available right now"
								: "No workload reported metrics in 24 hours",
						]),
					]
			: [
					h.div(
						[h.Class("max-h-[22rem] overflow-y-auto overscroll-contain")],
						Arr.map(rows, ({ service: rowService, workload }) => {
							const tone = gcpWorkloadTone(workload)
							return h.a(
								[
									h.Href(
										hrefOf(
											AppRoute.InfraGcpResource({
												service: rowService,
												name: workload.keys[0] ?? "",
												search: {
													...gcpWorkloadSearch(rowService, workload.keys),
													timePreset: WINDOW,
												},
											}),
										),
									),
									h.Class(
										"group flex items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-0 hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none",
									),
								],
								[
									statusDot(h, { tone: tone === "neutral" ? "ok" : tone }),
									vstack(h, { gap: "0.5", shrink: true, grow: true }, [
										truncatedText(h, {
											text: gcpWorkloadName(rowService, workload.keys),
											className:
												"text-xs font-medium text-foreground group-hover:text-primary",
										}),
										truncatedText(h, {
											text: [
												GCP_INFRA_SERVICES[rowService].title,
												gcpWorkloadLocation(rowService, workload.keys),
												manyProjects
													? gcpWorkloadProject(rowService, workload.keys)
													: undefined,
											]
												.filter((part) => part !== undefined && part !== "")
												.join(" · "),
											className: typographyClass({ size: "2xs", tone: "muted" }),
										}),
									]),
									...Arr.map(
										GCP_INFRA_COLUMNS[rowService].slice(0, VALUES_SHOWN),
										(spec, index) =>
											h.div(
												[
													h.Class(
														cn(
															"w-24 shrink-0 flex-col gap-0.5 text-right",
															VALUE_VISIBLE[index],
														),
													),
												],
												[
													h.span(
														[
															h.Class(
																cn(
																	"text-xs font-medium tabular-nums",
																	valueClass(spec, workload.values[index]),
																),
															),
														],
														[formatGcpValue(spec.format, workload.values[index])],
													),
													typography(h, { size: "2xs", tone: "muted" }, [
														spec.label,
													]),
												],
											),
									),
								],
							)
						}),
					),
				]),
	])
}

const TYPES_SHOWN = 8

const resources = (h: H, model: Model, className: string): Html => {
	const inventory = inventoryOf(model)
	if (inventory === null) return skeleton(h, cn("h-40 rounded-md", className))
	const types = inventory === "failed" ? [] : inventory.types.toSorted((a, b) => b.count - a.count)
	return panel(h, { className: cn("h-fit border-border-subtle", className) }, [
		panelHeader(h, {
			className: "border-border-subtle",
			children: [heading(h, { level: 3, variant: "section" }, ["Resources"])],
			action: typography(h, { size: "2xs", tone: "muted" }, ["listed hourly"]),
		}),
		types.length === 0
			? h.p(
					[h.Class("px-4 py-3 text-xs text-muted-foreground")],
					[inventory === "failed" ? "Not available right now" : "Listed within an hour of setup"],
				)
			: h.ul(
					[h.Class("flex flex-col px-2 py-1.5")],
					Arr.map(types.slice(0, TYPES_SHOWN), ({ assetType, count }) =>
						h.li(
							[],
							[
								h.a(
									[
										h.Href(
											hrefOf(
												AppRoute.InfraGcp({
													search: { tab: GCP_RESOURCES_TAB, type: assetType },
												}),
											),
										),
										h.Class(
											"flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-xs hover:bg-surface-sunken active:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none",
										),
									],
									[
										truncatedText(h, { text: gcpAssetTypeLabel(assetType) }),
										typography(
											h,
											{ tone: "muted", numeric: true, className: "shrink-0" },
											[formatNumber(count)],
										),
									],
								),
							],
						),
					),
				),
		...(inventory === "failed" || inventory.total === 0
			? []
			: [
					h.footer(
						[
							h.Class(
								"flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-2.5 text-xs text-muted-foreground",
							),
						],
						[
							h.span(
								[],
								[
									formatNumber(inventory.total),
									" in ",
									countLabel(inventory.projects, "project"),
								],
							),
							h.a(
								[
									h.Href(hrefOf(AppRoute.InfraGcp({ search: { tab: GCP_RESOURCES_TAB } }))),
									h.Class(
										"inline-flex shrink-0 items-center gap-1 text-foreground hover:text-primary active:text-primary",
									),
								],
								[
									types.length > TYPES_SHOWN
										? `All ${countLabel(types.length, "type")}`
										: "All resources",
									icon(h, "ArrowRightIcon", { size: 12 }),
								],
							),
						],
					),
				]),
	])
}

/** `GcpUsageBand`: shown once a connection has delivered logs or metrics. */
export const usageBand = (h: H, model: Model, connectors: ReadonlyArray<V2GcpConnector>): Html | null => {
	const logs = Arr.some(connectors, (connector) => connector.last_log_received_at !== null)
	const metrics = Arr.some(connectors, (connector) => connector.last_metrics_received_at !== null)
	if (!logs && !metrics) return null
	return vstack(h, { gap: "4" }, [
		logs && metrics
			? statRail(
					h,
					{
						className: "md:grid-cols-2 md:divide-y @2xl/page:grid-cols-4 @2xl/page:divide-y-0",
					},
					[...logTiles(h, model, false), ...metricsTiles(h, model, false)],
				)
			: statRail(
					h,
					{ className: "md:grid-cols-2 md:divide-y @md/page:grid-cols-3 @md/page:divide-y-0" },
					logs ? logTiles(h, model, true) : metricsTiles(h, model, true),
				),
		...(metrics
			? [
					h.div(
						[h.Class("flex flex-col gap-4 lg:flex-row lg:items-start")],
						[
							workloads(h, model, "min-w-0 flex-1"),
							resources(h, model, "lg:w-72 lg:shrink-0 xl:w-80"),
						],
					),
				]
			: []),
	])
}
