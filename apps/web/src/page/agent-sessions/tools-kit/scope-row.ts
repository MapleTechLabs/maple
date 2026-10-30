import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"

// The tool scope row: what the page is about, one click out of each.

export type ScopeChip = Readonly<{ kind: "tool" | "model"; value: string }>

export type ScopeRowConfig<M> = Readonly<{
	chips: ReadonlyArray<ScopeChip>
	/** "120 of 4.0K calls match · 8 sessions" (`scopeSummary`). */
	summary: string
	onRemove: (chip: ScopeChip) => M
	onClearAll: M
}>

const chipButton = <M>(h: HtmlBuilder<M>, chip: ScopeChip, onRemove: M): Html =>
	h.button(
		[
			h.Key(`${chip.kind}:${chip.value}`),
			h.AriaLabel(`Remove ${chip.kind} ${chip.value}`),
			h.Class(
				"inline-flex h-[22px] max-w-64 items-center gap-1.5 rounded-sm border border-primary/35 bg-primary/10 px-2 transition-colors hover:bg-primary/20",
			),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
			h.Type("button"),
			h.OnClick(onRemove),
		],
		[
			h.span([h.Class("text-2xs text-muted-foreground")], [chip.kind]),
			h.span([h.Class("truncate text-2xs text-primary")], [chip.value]),
			icon(h, "XmarkIcon", {
				size: 10,
				className: "shrink-0 text-muted-foreground",
				attributes: [h.AriaHidden(true)],
			}),
		],
	)

export const scopeRow = <M>(h: HtmlBuilder<M>, config: ScopeRowConfig<M>): Html => {
	// The leading number is the answer; the rest of the sentence is its unit.
	const [count, ...rest] = config.summary.split(" ")
	return h.div(
		[
			h.Class(
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-6 py-2.5 font-mono",
			),
		],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					eyebrow(h, { variant: "mono" }, ["Scope"]),
					...(config.chips.length === 0
						? [h.span([h.Class("text-2xs text-foreground-subtle")], ["all tools · all models"])]
						: [
								...config.chips.map((chip) => chipButton(h, chip, config.onRemove(chip))),
								button(
									h,
									{
										variant: "link",
										size: "xs",
										className: "h-auto px-0.5 text-2xs text-muted-foreground sm:text-2xs",
										attributes: [h.OnClick(config.onClearAll)],
									},
									["Clear all"],
								),
							]),
				],
			),
			h.span(
				[h.Class("flex items-center gap-1.5 text-2xs tabular-nums")],
				[
					h.span([h.Class("text-foreground")], [count ?? ""]),
					h.span([h.Class("text-muted-foreground")], [rest.join(" ")]),
				],
			),
		],
	)
}
