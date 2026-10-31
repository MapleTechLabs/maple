import { containerImage, finding, formatterCases, hosts, pods } from "../worst-case-fixture"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { HOST_SORT_ACCESSORS } from "../../page/infra/hosts/list/view"
import { hostTable } from "../../page/infra/hosts/list/view-table"
import { heroChip } from "../../page/infra/kit/hero-chip"
import { podTable } from "../../page/infra/kubernetes/pod-table"
import { FINDINGS_LIST_CLASS, findingRow } from "../../page/infra/overview/view-findings"
import { sortRowsBy } from "../../page/kit/table-sort"
import { listFooter } from "../../ui/list-footer"
import { Message, type Model } from "./model"

// `WcSection`, `Narrow`, `FormattersSection` and `InfraSection`.

export type H = HtmlBuilder<Message>

export const wcSection = (h: H, id: string, title: string, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Id(id), h.Class("space-y-3 border-b pb-10")],
		[
			h.h2(
				[h.Class("font-mono text-xs text-muted-foreground")],
				["#", id, " ", h.span([h.Class("text-foreground")], [title])],
			),
			...children,
		],
	)

/** A sidebar-ish container, for components that live in a narrow column. */
export const narrow = (h: H, children: ReadonlyArray<Html>, width = 360): Html =>
	h.div([h.Class("rounded-md border p-2"), h.Style({ width: `${width}px` })], children)

const footers = (h: H, model: Model): ReadonlyArray<Html | null> =>
	model.mode === "demo"
		? [
				listFooter(h, {
					shown: 50,
					total: 1284,
					noun: "logs",
					hasMore: true,
					onLoadMore: Message.ClickedLoadMore(),
				}),
			]
		: [
				listFooter(h, { shown: 1, total: 1, noun: "logs" }),
				listFooter(h, { shown: 0, total: 0, noun: "queries" }),
				listFooter(h, {
					shown: 12_849_302,
					total: Number.POSITIVE_INFINITY,
					noun: "spans",
					isCapped: true,
				}),
				listFooter(h, {
					shown: 200,
					noun: "traces",
					hasMore: true,
					isFailed: true,
					onLoadMore: Message.ClickedLoadMore(),
				}),
			]

const cell = (h: H, className: string, text: string) => h.td([h.Class(className)], [text])

export const formattersSection = (h: H, model: Model): Html =>
	wcSection(h, "wc-formatters", "Formatters: input to output", [
		h.table(
			[h.Class("w-full max-w-3xl border-collapse font-mono text-xs")],
			[
				h.thead(
					[],
					[
						h.tr(
							[h.Class("text-left text-muted-foreground")],
							[
								h.th([h.Class("border-b py-1 pr-4 font-normal")], ["function"]),
								h.th([h.Class("border-b py-1 pr-4 font-normal")], ["input"]),
								h.th([h.Class("border-b py-1 font-normal")], ["output"]),
							],
						),
					],
				),
				h.tbody(
					[],
					formatterCases(model.mode).map((row) =>
						h.tr(
							[],
							[
								cell(h, "border-b py-1 pr-4", row.fn),
								cell(h, "border-b py-1 pr-4", row.input),
								cell(h, "border-b py-1", row.output),
							],
						),
					),
				),
			],
		),
		h.div(
			[h.Class("max-w-3xl space-y-1 rounded-md border")],
			footers(h, model).flatMap((footer) => (footer === null ? [] : [footer])),
		),
	])

/** `<PodTable pods timeSearch={{}} />`, `<HostTable hosts />`, one finding and the image chips. */
export const infraSection = (h: H, model: Model): Html =>
	wcSection(h, "wc-infra", "Infra: pods, hosts, findings, image chip", [
		podTable(h, pods(model.mode), {
			sortBy: "saturation",
			sortDir: "desc",
			timeSearch: {},
			isWaiting: false,
			// No reference time is passed, so it is the boot clock.
			referenceTime: new Date(model.nowMs).toISOString(),
			nowMs: model.nowMs,
			timeZone: model.timeZone,
			restarts: Option.none(),
		}),
		hostTable(h, sortRowsBy(hosts(model.mode), model.hostSort, HOST_SORT_ACCESSORS), {
			nowMs: model.nowMs,
			timeZone: model.timeZone,
			isWaiting: false,
			sort: model.hostSort,
			onSort: (key) => Message.ClickedHostSort({ key }),
		}),
		h.div([h.Class(FINDINGS_LIST_CLASS)], [findingRow(h, finding(model.mode), {})]),
		narrow(h, [
			h.div(
				[h.Class("flex flex-wrap gap-1.5")],
				[heroChip(h, containerImage(model.mode)), heroChip(h, "linux/amd64")],
			),
		]),
	])

/** `ModeToggle`: the fixed pill that swaps every section between its demo and worst-case twin. */
export const modeToggle = (h: H, model: Model): Html =>
	// An opaque band, so rows scroll under it instead of colliding with the pill; the page's pb-24 clears it.
	h.div(
		[h.Class("fixed inset-x-0 bottom-0 z-50 flex justify-center border-t bg-background py-3")],
		[
			h.div(
				[h.Class("flex gap-0.5 rounded-full bg-neutral-200 p-1")],
				(
					[
						{ value: "demo", label: "Demo data" },
						{ value: "worst", label: "Worst case" },
					] satisfies ReadonlyArray<{ value: Model["mode"]; label: string }>
				).map((option) =>
					h.button(
						[
							h.Key(option.value),
							h.Type("button"),
							h.AriaPressed(String(model.mode === option.value)),
							h.OnClick(Message.ClickedMode({ mode: option.value })),
							h.Class(
								model.mode === option.value
									? "rounded-full px-3 py-1 text-xs bg-white text-neutral-900"
									: "rounded-full px-3 py-1 text-xs text-neutral-600",
							),
						],
						[option.label],
					),
				),
			),
		],
	)
