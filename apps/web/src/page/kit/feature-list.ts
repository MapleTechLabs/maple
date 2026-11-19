import type { IntegrationFeatureSpec } from "@maple/domain/integration-features"
import { linkButton } from "@maple/views/ui/button"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { panel, panelBody, panelHeader } from "@maple/views/ui/panel"
import { dividedList } from "@maple/views/ui/rule"
import { settingRow } from "@maple/views/ui/setting-row"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { switchRow } from "./switch-row"

// An integration's features as one list of switches: the same list when connecting and afterwards.

/** Where a feature stands, when it is not simply working. A failure only shows while it is on. */
export type FeatureNote =
	| Readonly<{ _tag: "Pending"; text: string }>
	| Readonly<{ _tag: "Failing"; text: string }>
	| Readonly<{ _tag: "Info"; text: string }>

type RowCommon = Readonly<{
	spec: IntegrationFeatureSpec
	/** A short tag beside the title (the drain a feature creates). */
	tag?: string
	note?: FeatureNote
	/** Shown under the row: a filter it owns, what saving it does. */
	children?: ReadonlyArray<Html>
}>

/** A feature switched here. */
export type FeatureSwitchRow<M> = RowCommon &
	Readonly<{
		isChecked: boolean
		isDisabled?: boolean
		/** Why this person may not flip it; the switch locks and says so. */
		lockReason?: string
		onToggle: M
	}>

/** A feature set elsewhere (per repository, per project): a link to where it is switched. */
export type FeatureLinkRow = RowCommon & Readonly<{ link: Readonly<{ href: string; label: string }> }>

/** A feature set with a form of its own (a picker on the next step, an edit panel): its control, if any. */
export type FeatureControlRow = RowCommon & Readonly<{ control: ReadonlyArray<Html> }>

export type FeatureRow<M> = FeatureSwitchRow<M> | FeatureLinkRow | FeatureControlRow

const NOTE_VARIANT = { Pending: "warn", Failing: "crit", Info: "meta" } as const

const status = <M>(h: HtmlBuilder<M>, row: FeatureRow<M>, isChecked: boolean): Html | undefined => {
	if (row.note !== undefined && (row.note._tag !== "Failing" || isChecked)) {
		return badge(h, { variant: NOTE_VARIANT[row.note._tag], size: "xs" }, [row.note.text])
	}
	return row.tag === undefined
		? undefined
		: badge(h, { variant: "outline", size: "xs", mono: true }, [row.tag])
}

const linkRow = <M>(h: HtmlBuilder<M>, id: string, row: FeatureLinkRow): Html => {
	const note = status(h, row, true)
	// The label names no control: a link is named by its own text.
	return settingRow(
		h,
		{
			ids: { control: `${id}-link`, label: `${id}-label`, description: `${id}-description` },
			className: "p-3",
			label: row.spec.title,
			description: row.spec.summary,
			...(note !== undefined && { status: note }),
			control: [
				linkButton(h, { size: "sm", variant: "outline", href: row.link.href }, [row.link.label]),
			],
		},
		row.children ?? [],
	)
}

const controlRow = <M>(h: HtmlBuilder<M>, id: string, row: FeatureControlRow): Html => {
	const note = status(h, row, true)
	return settingRow(
		h,
		{
			ids: { control: `${id}-control`, label: `${id}-label`, description: `${id}-description` },
			className: "p-3",
			label: row.spec.title,
			description: row.spec.summary,
			...(note !== undefined && { status: note }),
			control: row.control,
		},
		row.children ?? [],
	)
}

/** `FeatureList`: an integration's features as switches, one row each, with a note for one that is pending or failing. */
export const featureList = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		idPrefix: string
		rows: ReadonlyArray<FeatureRow<M>>
		className?: string
		/** False inside a panel, where the list runs to its edges. */
		bordered?: boolean
		/** Why this person may not flip any of them (a missing grant): every switch locks and says so. */
		lockReason?: string | undefined
	}>,
): Html =>
	dividedList(
		h,
		{
			as: "div",
			bordered: options.bordered ?? true,
			className: options.className ?? ((options.bordered ?? true) ? "rounded-lg" : undefined),
		},
		Arr.map(options.rows, (row) => {
			const id = `${options.idPrefix}-${row.spec.id}`
			if ("link" in row) return linkRow(h, id, row)
			if ("control" in row) return controlRow(h, id, row)
			const note = status(h, row, row.isChecked)
			return switchRow(
				h,
				{
					id,
					className: "p-3",
					label: row.spec.title,
					description: row.spec.summary,
					isChecked: row.isChecked,
					onToggle: row.onToggle,
					...(row.isDisabled !== undefined && { isDisabled: row.isDisabled }),
					...((row.lockReason ?? options.lockReason) !== undefined && {
						lockReason: row.lockReason ?? options.lockReason,
					}),
					...(note !== undefined && { status: note }),
				},
				row.children ?? [],
			)
		}),
	)

/** `FeaturePanel`: a connected integration's feature list as a titled panel, with the error of a change that did not save. */
export const featurePanel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		idPrefix: string
		rows: ReadonlyArray<FeatureRow<M>>
		/** Why the last change did not save; its switch is back where it was. */
		error: string | null
		title?: string
		lockReason?: string | undefined
	}>,
): Html =>
	panel(h, {}, [
		panelHeader(h, { title: options.title ?? "What Maple collects", divided: true }),
		...(options.error === null
			? []
			: [
					panelBody(h, [
						alert(h, { variant: "crit" }, [
							icon(h, "CircleWarningIcon"),
							alertTitle(h, ["Couldn't save that change"]),
							alertDescription(h, [options.error]),
						]),
					]),
				]),
		featureList(h, {
			idPrefix: options.idPrefix,
			rows: options.rows,
			bordered: false,
			...(options.lockReason !== undefined && { lockReason: options.lockReason }),
		}),
	])
