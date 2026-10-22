import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { buildErrorsLabFixture } from "../errors-fixture"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { listBody } from "../../page/errors/hub/view-list"
import { toolbar } from "../../page/errors/hub/view-toolbar"
import type { Message as HubMessage } from "../../page/errors/hub/message"
import type { Model as HubModel } from "../../page/errors/hub/model"
import { eyebrow } from "../../ui/eyebrow"
import { isMounted } from "../../ui/overlay/transition"
import { labSignals } from "./hub-step"
import { LAB_STATES, LAB_WIDTHS, type LabState, Message, type Model } from "./model"

// `LabControls`, `LabStatStrip` and `ErrorsHubView` over the fixture.
// Shell-free (the entry wraps it), so scene tests can render it.

type Option<T> = Readonly<{ value: T; label: string }>

/** `LabToggleGroup`. */
const toggleGroup = <M, T>(
	h: HtmlBuilder<M>,
	label: string,
	options: ReadonlyArray<Option<T>>,
	active: T,
	onChange: (value: T) => M,
): Html =>
	h.div(
		[h.Class("flex items-center gap-1.5")],
		[
			eyebrow(h, {}, [label]),
			h.div(
				[h.Class("flex items-center gap-0.5 rounded-md border border-border/60 p-0.5")],
				options.map((option) =>
					h.button(
						[
							h.Type("button"),
							h.OnClick(onChange(option.value)),
							h.Class(
								cn(
									"h-6 rounded px-2 text-xs transition-colors",
									option.value === active
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:text-foreground",
								),
							),
						],
						[option.label],
					),
				),
			),
		],
	)

/** The stat strip's success branch over fixture numbers. */
const labStatStrip = <M>(h: HtmlBuilder<M>, summary: { totalErrors: number; errorRate: number }): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs")],
		[
			...[
				{ value: formatNumber(summary.totalErrors), label: "error events" },
				{ value: formatErrorRate(summary.errorRate), label: "of all spans" },
			].map((stat) =>
				h.span(
					[h.Class("flex items-baseline gap-1.5")],
					[
						h.span([h.Class("font-medium tabular-nums text-foreground")], [stat.value]),
						h.span([h.Class("text-muted-foreground")], [stat.label]),
					],
				),
			),
			h.span([h.Class("text-muted-foreground/60")], ["in the last 24 hours"]),
		],
	)

type HubInputs = Readonly<{ state: LabState; timeZone: string }>

/** `ErrorsHubView`: the stat strip and toolbar over the skeleton, retry card, rows or empty state. */
const hubView = Submodel.defineView<HubModel, HubMessage, HubInputs>((hub, inputs, h) => {
	const fixture = buildErrorsLabFixture(hub.nowMs)
	const signals = labSignals(hub, inputs.state)
	const status = inputs.state === "ready" || inputs.state === "empty" ? "ready" : inputs.state
	const isSelecting = hub.selectedIds.length > 0
	// Split where the JSX interpolates, so the text runs match.
	const count =
		status === "ready" ? [String(signals.length), " ", signals.length === 1 ? "issue" : "issues"] : null
	return h.div(
		[],
		[
			labStatStrip(h, fixture.summary),
			toolbar(h, hub, count),
			...listBody(h, hub, {
				status,
				signals,
				isNarrowed: false,
				rowState: (signal) => ({
					isSelected: hub.selectedIds.includes(signal.id),
					isSelecting,
					isFocused: hub.focusedId === signal.id,
					timeZone: inputs.timeZone,
					nowMs: hub.nowMs,
					sparkWindow: fixture.sparkWindow,
					picker: hub.picker !== null && hub.picker.issueId === signal.id ? hub.picker : null,
					rowMenu:
						hub.rowMenuTarget === signal.id &&
						isMounted(hub.rowMenu.isOpen, hub.rowMenu.animation)
							? hub.rowMenu
							: null,
				}),
			}),
		],
	)
})

/** `DashboardLayout.Body` of the lab: the controls in the header, the hub in a width-capped column. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
	dashboardPage(
		h,
		{
			actions: h.div(
				[h.Class("flex flex-wrap items-center gap-3")],
				[
					toggleGroup(
						h,
						"State",
						LAB_STATES.map((value) => ({ value, label: value })),
						model.state,
						(state) => Message.ClickedState({ state }),
					),
					toggleGroup(h, "Width", LAB_WIDTHS, model.width, (width) =>
						Message.ClickedWidth({ width }),
					),
				],
			),
		},
		[
			h.div(
				[
					h.Class("@container/page mx-auto w-full min-w-0"),
					...(model.width === null ? [] : [h.Style({ maxWidth: `${model.width}px` })]),
				],
				[
					h.submodel({
						slotId: "errors-lab-hub",
						model: model.hub,
						view: hubView,
						viewInputs: { state: model.state, timeZone: model.timeZone },
						toParentMessage: (message) => Message.GotHubMessage({ message }),
					}),
				],
			),
		],
	),
)
