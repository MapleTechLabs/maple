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
	/** The list failed: the triage chips have nothing to filter. */
	isFailed?: boolean
}>

const triageChip = <M>(
	h: HtmlBuilder<M>,
	isPressed: boolean,
	onClick: M,
	tone: Tone,
	children: ReadonlyArray<Html | string>,
	isDisabled = false,
): Html => filterChip(h, { isPressed, isDisabled, onClick, tone, hasDot: true }, children)

export const replaysToolbar = <M>(h: HtmlBuilder<M>, options: ReplaysToolbarOptions<M>): Html => {
	const isWaiting = options.isWaiting ?? false
	return h.div([h.Class("flex flex-wrap items-center justify-between gap-3")], [
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
				h.Class(cn("flex flex-wrap items-center gap-2", refreshingClass(isWaiting))),
			],
			[
				triageChip(h, options.isErrorsOnly, options.onToggleErrorsOnly, "crit", [
					...(options.errorSessions === undefined
						? ["with errors"]
						: [h.span([h.Class("tabular-nums")], [formatNumber(options.errorSessions)]), " with errors"]),
				], options.isFailed),
				triageChip(h, options.isEngagedOnly, options.onToggleEngagedOnly, "ok", [
					...(options.engagedSessions === undefined
						? []
						: [h.span([h.Class("tabular-nums")], [formatNumber(options.engagedSessions)])]),
					"engaged",
				], options.isFailed),
			],
		),
	])
}
