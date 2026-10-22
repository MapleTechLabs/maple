import { TIME_RANGES } from "../../lib/time"
import { formatNumber } from "@maple/ui/lib/format"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { button } from "@maple/web/ui/button"
import { icon } from "@maple/web/ui/icon"
import { nativeOption, nativeSelect } from "@maple/web/ui/native-select"
import { searchInput } from "@maple/web/ui/search-input"
import { statusDot } from "@maple/web/ui/status-dot"
import type { Html, HtmlBuilder } from "foldkit/html"

// packages/ui/src/components/toolbar.tsx.

type Children = ReadonlyArray<Html | null>
const present = (children: Children): ReadonlyArray<Html> => children.filter((child) => child !== null)

export const toolbar = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div(
		[h.Class(cn("flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3", className))],
		present(children),
	)

/** Right-hand cluster of `toolbarStat`s. */
export const toolbarStats = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div([h.Class(cn("flex items-center gap-4", className))], present(children))

export const toolbarStat = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		value: number | string
		label: string
		hasDot?: boolean
		isDanger?: boolean
		tone?: Tone
	}>,
): Html =>
	h.span(
		[h.Class("flex items-center gap-1.5 whitespace-nowrap text-sm")],
		[
			...(options.hasDot === true ? [statusDot(h, { tone: "ok" })] : []),
			h.span(
				[
					h.Class(
						cn(
							"font-medium tabular-nums",
							options.tone && TONE_TEXT[options.tone],
							options.isDanger === true &&
								typeof options.value === "number" &&
								options.value > 0 &&
								TONE_TEXT.crit,
						),
					),
				],
				[typeof options.value === "number" ? formatNumber(options.value) : options.value],
			),
			h.span([h.Class("text-muted-foreground")], [options.label]),
		],
	)

/**
 * apps/local-ui's `RefreshButton`: the "New data" pill once the server took telemetry after the
 * list loaded, then the shared reload button, disabled and spinning while the refresh runs.
 */
export const refreshButton = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isSpinning: boolean; hasNewData: boolean; onRefresh: M; className?: string }>,
): Html =>
	h.span(
		[h.Class(cn("flex items-center gap-1", options.className))],
		[
			...(options.hasNewData
				? [
						h.button(
							[
								h.Type("button"),
								h.OnClick(options.onRefresh),
								h.Class(
									"inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-primary transition-colors hover:bg-primary/15",
								),
							],
							[h.span([h.Class("size-1.5 rounded-full bg-primary")], []), "New data"],
						),
					]
				: []),
			button(
				h,
				{
					variant: "ghost",
					size: "icon-sm",
					isDisabled: options.isSpinning,
					attributes: [h.AriaLabel("Reload"), h.Title("Reload"), h.OnClick(options.onRefresh)],
				},
				[
					icon(
						h,
						"ArrowRotateClockwiseIcon",
						options.isSpinning ? { className: "animate-spin" } : {},
					),
				],
			),
		],
	)

const RANGE_LABELS: ReadonlyMap<string, string> = new Map([
	["5m", "Last 5 minutes"],
	["15m", "Last 15 minutes"],
	["30m", "Last 30 minutes"],
	["1h", "Last 1 hour"],
	["6h", "Last 6 hours"],
	["12h", "Last 12 hours"],
	["24h", "Last 24 hours"],
	["7d", "Last 7 days"],
	["30d", "Last 30 days"],
])

/** `TimeRangeSelect` bound to local mode's presets. */
export const timeRangeSelect = <M>(h: HtmlBuilder<M>, value: string, onChange: (next: string) => M): Html =>
	h.div(
		[h.Class("flex items-center gap-1.5")],
		[
			icon(h, "ClockIcon", {
				className: "size-3.5 text-muted-foreground",
				attributes: [h.Attribute("stroke-width", "2")],
			}),
			nativeSelect(
				h,
				{
					size: "sm",
					defaultValue: value,
					attributes: [h.AriaLabel("Time range"), h.OnChange(onChange)],
				},
				TIME_RANGES.map((range) =>
					nativeOption(range.key, RANGE_LABELS.get(range.key) ?? range.label),
				),
			),
		],
	)

/** `ToolbarSearch`: the draft lives in the page Model and commits after the page's debounce. */
export const toolbarSearch = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		id: string
		value: string
		placeholder: string
		onInput: (value: string) => M
		onClear: M
		className?: string
	}>,
): Html =>
	searchInput(h, {
		id: options.id,
		size: "default",
		value: options.value,
		placeholder: options.placeholder,
		onInput: options.onInput,
		onClear: options.onClear,
		className: cn("max-w-sm", options.className),
	})
