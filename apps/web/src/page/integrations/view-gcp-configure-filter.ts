import type { GcpLogRuntime } from "@maple/domain/primitives"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import { GCP_LOG_RUNTIMES, gcpLogFilterChoice } from "../../components/integrations/gcp-connector-state"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { type FieldState, field, fieldLabel } from "../../ui/field"
import { icon } from "../../ui/icon"
import { DOCS, OTEL_DOCS } from "./gcp-configure-copy"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import { externalLink } from "./view-gcp-configure-parts"
import { filterModeSelect } from "./view-gcp-configure-filter-mode"
import { runtimeFields } from "./view-gcp-configure-runtimes"

// `LogFilter` and `GcpLogFilterField`: the filter the script gives the log sink.

type H = HtmlBuilder<Message>

const PANEL_ID = "gcp-log-filter-panel"

export const runtimeLabels = (runtimes: ReadonlyArray<GcpLogRuntime>): string =>
	GCP_LOG_RUNTIMES.filter(({ value }) => runtimes.includes(value))
		.map(({ label }) => label)
		.join(", ")

/** The log filter's choice in a few words: the closed disclosure and the run summary. */
export const filterShort = (choice: ReturnType<typeof gcpLogFilterChoice>): string =>
	choice.keep
		? "Current filter"
		: choice.runtimes.length === 0
			? "Platform logs"
			: `Platform logs + ${runtimeLabels(choice.runtimes)}`

/** The log filter under Logs, closed on its current choice. */
export const logFilter = (
	h: H,
	configure: ConfigureModel,
	options: Readonly<{ sinkExists: boolean; logRouter?: string }>,
): Html => {
	const isOpen = configure.isFilterOpen
	const state = h.DataAttribute(isOpen ? "open" : "closed", "")
	return h.div(
		[
			h.Class("rounded-md border border-border-subtle bg-surface-sunken"),
			state,
			h.DataAttribute("slot", "collapsible"),
		],
		[
			h.button(
				[
					...(isOpen ? [h.AriaControls(PANEL_ID)] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(isOpen),
					h.Class(
						"group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
					),
					...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(Message.ClickedGcpLogFilter()),
				],
				[
					h.span([h.Class("text-foreground")], ["Log filter"]),
					h.span(
						[h.Class("truncate text-muted-foreground")],
						[filterShort(gcpLogFilterChoice(configure.filter, options.sinkExists))],
					),
					icon(h, "ChevronDownIcon", {
						size: 12,
						className:
							"ml-auto shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180",
					}),
				],
			),
			...(isOpen
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								state,
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id(PANEL_ID),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
								}),
							],
							[
								h.div(
									[h.Class("border-t border-border-subtle p-3")],
									[filterField(h, configure, options)],
								),
							],
						),
					]
				: []),
		],
	)
}

const summaryRow = (h: H, mark: Html, term: string, detail: string): Html =>
	h.div(
		[
			h.Class(
				"grid grid-cols-[1rem_1fr] items-center gap-x-3 gap-y-0.5 px-3.5 py-2.5 sm:grid-cols-[1rem_11.875rem_1fr]",
			),
		],
		[
			h.span([h.Class("flex justify-center text-muted-foreground")], [mark]),
			h.dt([h.Class("text-sm/5 font-medium")], [term]),
			h.dd(
				[h.Class("col-start-2 font-prose text-xs text-pretty text-muted-foreground sm:col-start-3")],
				[detail],
			),
		],
	)

export type FilterFieldOptions = Readonly<{
	sinkExists: boolean
	logRouter?: string
	/** `showLabel`: the field's own "Log filter" label, by this id; the disclosure names it otherwise. */
	labelId?: string
	/** The runtime fieldset's id, unique per field on a page. */
	forwardId?: string
}>

const LABEL = "text-xs font-medium text-muted-foreground"

/** `GcpLogFilterField`: whose application output comes along. */
export const filterField = (
	h: H,
	configure: Pick<ConfigureModel, "filter" | "filterMode">,
	options: FilterFieldOptions,
): Html => {
	const choice = gcpLogFilterChoice(configure.filter, options.sinkExists)
	// Base UI's field is filled once its Select holds a value.
	const state: FieldState = {
		isInvalid: false,
		isDirty: false,
		isFilled: options.sinkExists,
		isFocused: false,
		isTouched: false,
	}
	const label =
		options.labelId === undefined
			? h.span([], [])
			: fieldLabel(
					h,
					{
						ids: { control: `${options.labelId}-control`, label: options.labelId, error: "" },
						className: cn(LABEL, "sm:text-xs/4"),
						state,
					},
					"Log filter",
				)
	const newFilter = h.div(
		[h.Class("flex flex-col gap-2.5")],
		[
			h.dl(
				[h.Class("divide-y rounded-md border")],
				[
					summaryRow(
						h,
						icon(h, "CheckIcon", { size: 14, className: "text-severity-info" }),
						"Platform logs",
						"Requests, audit, deploys, crashes, scaling",
					),
					summaryRow(
						h,
						// Off reads as off: a cross, not an ambiguous dash; ticked runtimes get a check.
						choice.runtimes.length === 0
							? icon(h, "XmarkIcon", { size: 14 })
							: icon(h, "CheckIcon", { size: 14, className: "text-severity-info" }),
						"Application output",
						choice.runtimes.length === 0
							? "Not collected: stdout and stderr stay in Google Cloud"
							: `stdout and stderr, from ${runtimeLabels(choice.runtimes)} only`,
					),
				],
			),
			h.p(
				[
					h.Class(
						"flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-prose text-xs/5 text-pretty text-muted-foreground",
					),
				],
				[
					"Send application logs with your OpenTelemetry setup, where they link to traces.",
					externalLink(h, OTEL_DOCS, "Set up OpenTelemetry"),
				],
			),
			choice.forwardsOutput
				? runtimeFields(h, choice.runtimes, options.forwardId)
				: forwardOutputPrompt(h),
		],
	)
	return field(h, { className: "items-stretch gap-2.5", state }, [
		h.div(
			[h.Class("flex items-baseline justify-between gap-4 text-xs text-muted-foreground")],
			[
				label,
				choice.keep && options.logRouter !== undefined
					? externalLink(h, options.logRouter, "Current filter in Log Router")
					: externalLink(h, `${DOCS}#log-filter`, "Custom filter"),
			],
		),
		...(options.sinkExists ? filterModeSelect(h, configure, choice.keep, options.labelId) : []),
		...(choice.keep ? [] : [newFilter]),
	])
}

/** The ticks are an escape hatch: a workload sending over OpenTelemetry would store each line twice. */
const forwardOutputPrompt = (h: H): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1")],
		[
			h.span(
				[h.Class("font-prose text-xs/5 text-muted-foreground")],
				["No way to add OpenTelemetry to a workload?"],
			),
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					attributes: [h.OnClick(Message.ClickedGcpForwardOutput())],
				},
				["Forward application output instead"],
			),
		],
	)
