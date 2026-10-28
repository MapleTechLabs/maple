import { formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { filterChip } from "../../../ui/filter-chip"
import { searchInput } from "../../../ui/search-input"

// The replays toolbar: the URL search and the triage chips.
// TODO(tooltip): the chips' hover tooltips.

export type ReplaysToolbarOptions<M> = Readonly<{
	/** What is typed; the caller debounces it into `q` like `ToolbarSearch`. */
	query: string
	onInput: (value: string) => M
	onClear: M
	/** `undefined` until the facets answer, so a failed read never claims zero. */
	errorSessions: number | undefined
	isErrorsOnly: boolean
	onToggleErrorsOnly: M
	engagedSessions: number | undefined
	isEngagedOnly: boolean
	onToggleEngagedOnly: M
	isWaiting?: boolean
}>

/** A filter toggle, sized to the search box beside it; the count trails as on every filter chip. */
const triageChip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		isPressed: boolean
		onClick: M
		tone: Tone
		label: string
		count: number | undefined
	}>,
): Html =>
	filterChip(
		h,
		{
			isPressed: options.isPressed,
			onClick: options.onClick,
			tone: options.tone,
			hasDot: true,
			size: "sm",
			count: options.count === undefined ? undefined : formatNumber(options.count),
		},
		[options.label],
	)

export const replaysToolbar = <M>(h: HtmlBuilder<M>, options: ReplaysToolbarOptions<M>): Html => {
	const isWaiting = options.isWaiting ?? false
	return h.div(
		[h.Class("flex flex-wrap items-center justify-between gap-3")],
		[
			searchInput(h, {
				id: "replays-search",
				value: options.query,
				placeholder: "Search by URL…",
				onInput: options.onInput,
				onClear: options.onClear,
				size: "default",
				className: cn("max-w-sm", "w-full sm:max-w-sm"),
			}),
			h.div(
				[
					...(isWaiting ? [h.AriaBusy(true)] : []),
					h.Role("group"),
					h.AriaLabel("Quick filters"),
					h.Class(cn("flex flex-wrap items-center gap-2", refreshingClass(isWaiting))),
				],
				[
					triageChip(h, {
						isPressed: options.isErrorsOnly,
						onClick: options.onToggleErrorsOnly,
						tone: "crit",
						label: "With errors",
						count: options.errorSessions,
					}),
					triageChip(h, {
						isPressed: options.isEngagedOnly,
						onClick: options.onToggleEngagedOnly,
						tone: "ok",
						label: "Engaged",
						count: options.engagedSessions,
					}),
				],
			),
		],
	)
}
