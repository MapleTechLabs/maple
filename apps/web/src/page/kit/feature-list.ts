import type { IntegrationFeatureSpec } from "@maple/domain/integration-features"
import { badge } from "@maple/views/ui/display"
import { dividedList } from "@maple/views/ui/rule"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { switchRow } from "./switch-row"

// An integration's features as one list of switches: the same list when connecting and afterwards.

/** Where a switched-on feature stands, when it is not simply working. */
export type FeatureNote =
	| Readonly<{ _tag: "Pending"; text: string }>
	| Readonly<{ _tag: "Failing"; text: string }>
	| Readonly<{ _tag: "Info"; text: string }>

export type FeatureRow<M> = Readonly<{
	spec: IntegrationFeatureSpec
	isChecked: boolean
	isDisabled?: boolean
	onToggle: M
	/** A short tag beside the title (the drain a feature creates). */
	tag?: string
	note?: FeatureNote
}>

const NOTE_VARIANT = { Pending: "warn", Failing: "crit", Info: "meta" } as const

const status = <M>(h: HtmlBuilder<M>, row: FeatureRow<M>): Html | undefined => {
	if (row.note !== undefined && row.isChecked) {
		return badge(h, { variant: NOTE_VARIANT[row.note._tag], size: "xs" }, [row.note.text])
	}
	return row.tag === undefined
		? undefined
		: badge(h, { variant: "outline", size: "xs", mono: true }, [row.tag])
}

/** `FeatureList`: an integration's features as switches, one row each, with a note for one that is pending or failing. */
export const featureList = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ idPrefix: string; rows: ReadonlyArray<FeatureRow<M>>; className?: string }>,
): Html =>
	dividedList(
		h,
		{ as: "div", className: options.className ?? "rounded-lg" },
		Arr.map(options.rows, (row) => {
			const note = status(h, row)
			return switchRow(h, {
				id: `${options.idPrefix}-${row.spec.id}`,
				className: "p-3",
				label: row.spec.title,
				description: row.spec.summary,
				isChecked: row.isChecked,
				onToggle: row.onToggle,
				...(row.isDisabled !== undefined && { isDisabled: row.isDisabled }),
				...(note !== undefined && { status: note }),
			})
		}),
	)

