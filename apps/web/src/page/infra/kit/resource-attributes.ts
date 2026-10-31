import { Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { detailRailGroup, detailRailMetaRow } from "../../../ui/detail-rail"
import { skeleton } from "../../../ui/skeleton"

// `ResourceAttributesCard` / `ResourceAttributesCardSkeleton` and `DetailRail.MetaRow` with its copy buttons.
// TODO(tooltip): a row's `tooltip` renders its trigger; the hover popup is not wired yet.

/** Copy status per row label: each row's `CopyButton` keeps its own `useCopy` state. */
export const Copies = Schema.Record(Schema.String, CopyButton.Model)
export type Copies = typeof Copies.Type

export const updateCopy = <M>(
	copies: Copies,
	label: string,
	message: CopyButton.Message,
	wrap: (label: string, message: CopyButton.Message) => M,
) => {
	const next = CopyButton.update(copies[label] ?? CopyButton.init(), message)
	return {
		copies: { ...copies, [label]: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) => wrap(label, inner)),
	}
}

/** `ResourceAttributesCard`: the infra detail rail's attribute group, flat like every other rail group. */
export const resourceAttributesCard = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	detailRailGroup(h, "Resource attributes", children)

const SKELETON_ROWS = [
	["w-12", "w-24"],
	["w-16", "w-28"],
	["w-10", "w-20"],
	["w-14", "w-32"],
	["w-12", "w-16"],
	["w-16", "w-24"],
] as const

export const resourceAttributesCardSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.AriaBusy(true)],
		[
			detailRailGroup(
				h,
				"Resource attributes",
				SKELETON_ROWS.map(([label, value]) =>
					h.div(
						[h.Class("flex items-center justify-between gap-3 py-1")],
						[skeleton(h, `h-2.5 ${label}`), skeleton(h, `h-2.5 ${value}`)],
					),
				),
			),
		],
	)

/** `HostMetadataPanel`'s `Section`. */
export const attributeSection = <M>(h: HtmlBuilder<M>, title: string, rows: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("space-y-0.5 py-2 first:pt-0 last:pb-0")],
		[h.div([h.Class("text-2xs font-medium text-muted-foreground")], [title]), h.div([], rows)],
	)

export type MetaRowOptions<M> = Readonly<{
	label: string
	value: string | null | undefined
	copyable?: boolean
	copyValue?: string
	tooltip?: string
	valueClassName?: string
	copies?: Copies
	onCopy?: (label: string, message: CopyButton.Message) => M
}>

/** `DetailRail.MetaRow` with the copy button's state kept in the page's `copies`. */
export const metaRow = <M>(h: HtmlBuilder<M>, options: MetaRowOptions<M>): Html => {
	const value = options.value
	const onCopy = options.onCopy
	const isCopyable = (options.copyable === true || Boolean(options.copyValue)) && onCopy !== undefined
	return detailRailMetaRow(h, {
		label: options.label,
		value,
		valueClassName: options.valueClassName,
		tooltip: options.tooltip,
		copy:
			isCopyable && value
				? {
						status: (options.copies?.[options.label] ?? CopyButton.init()).status,
						onClick: onCopy(
							options.label,
							CopyButton.Message.ClickedCopy({ text: options.copyValue ?? value }),
						),
					}
				: undefined,
	})
}
