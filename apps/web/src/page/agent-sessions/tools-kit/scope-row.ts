import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { pressable } from "@maple/views/ui/pressable"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

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
	pressable(
		h,
		{
			onClick: onRemove,
			label: `Remove ${chip.kind} ${chip.value}`,
			className:
				"inline-flex h-[22px] max-w-64 items-center gap-1.5 rounded-sm border border-primary-a4 bg-primary-a2 px-2 hover:bg-primary-a3 active:bg-primary-a3",
			attributes: [
				h.Key(`${chip.kind}:${chip.value}`),
				h.DataAttribute("base-ui-tooltip-trigger", ""),
				h.DataAttribute("slot", "tooltip-trigger"),
			],
		},
		[
			typography(h, { size: "2xs", tone: "muted" }, [chip.kind]),
			typography(h, { size: "2xs", tone: "primary", truncate: true }, [chip.value]),
			icon(h, "XmarkIcon", {
				size: 10,
				className: "shrink-0 text-muted-foreground",
				attributes: [h.AriaHidden(true)],
			}),
		],
	)

export const scopeRow = <M>(h: HtmlBuilder<M>, config: ScopeRowConfig<M>): Html => {
	// The leading number is the answer; the rest of the sentence is its unit.
	const [count, ...rest] = Str.split(" ")(config.summary)
	return hstack(
		h,
		{
			align: "center",
			justify: "between",
			wrap: true,
			className: "gap-x-4 gap-y-2 border-b border-border bg-card px-6 py-2.5 font-mono",
		},
		[
			hstack(h, { gap: "2", wrap: true }, [
				eyebrow(h, { variant: "mono" }, ["Scope"]),
				...(config.chips.length === 0
					? [typography(h, { size: "2xs", tone: "subtle" }, ["all tools · all models"])]
					: [
							...Arr.map(config.chips, (chip) => chipButton(h, chip, config.onRemove(chip))),
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
			]),
			hstack(h, { gap: "1.5", align: "center", as: "span", className: "text-2xs tabular-nums" }, [
				typography(h, { tone: "foreground" }, [count ?? ""]),
				typography(h, { tone: "muted" }, [Arr.join(rest, " ")]),
			]),
		],
	)
}
