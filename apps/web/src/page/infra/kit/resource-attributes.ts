import { cn } from "@maple/ui/lib/utils"
import { cardStyles } from "@maple/ui/styles/ui/card"
import { Duration, Effect, Layer, Schema } from "effect"
import { Block } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { card, cardHeader, cardPanel, cardTitle } from "../../../ui/card"
import * as CopyButton from "../../../ui/copy-button"
import { detailRailMetaRow } from "../../../ui/detail-rail"
import { icon, type IconName } from "../../../ui/icon"
import { skeleton } from "../../../ui/skeleton"

// `ResourceAttributesCard` / `ResourceAttributesCardSkeleton` and `DetailRail.MetaRow` with its copy buttons.
// TODO(tooltip): a row's `tooltip` renders its trigger; the hover popup is not wired yet.

// ROW COPIES BLOCK

// `detailRailMetaRow` draws its own copy button from a status and a click, so the rows' `useCopy`
// state lives in one Block keyed by row label, with `CopyButtonBlock`'s write, hold and reset.

/** Copy status per row label: each row's `CopyButton` keeps its own `useCopy` state. */
export const Copies = Schema.Record(Schema.String, CopyButton.Model)
export type Copies = typeof Copies.Type

export const CopiesModel = Schema.Struct({ byLabel: Copies })
export type CopiesModel = typeof CopiesModel.Type

export const CopiesMessage = defineMessageUnion({
	ClickedCopy: { label: Schema.String, text: Schema.String },
	SucceededCopy: { label: Schema.String, generation: Schema.Finite },
	FailedCopy: { label: Schema.String, generation: Schema.Finite },
	ElapsedCopyStatus: { label: Schema.String, generation: Schema.Finite },
})
export type CopiesMessage = typeof CopiesMessage.Type

const COPY_TIMEOUT = Duration.millis(2000)
const IDLE_COPY: CopyButton.Model = { status: "idle", generation: 0 }

const MetaRowCopiesDefinition = Block.makeDefinition("MetaRowCopies", {
	Model: CopiesModel,
	Message: CopiesMessage,
})

export const WriteRowClipboard = MetaRowCopiesDefinition.makeCommand("WriteMetaRowClipboard", {
	args: { label: Schema.String, text: Schema.String, generation: Schema.Finite },
	messages: [CopiesMessage.SucceededCopy, CopiesMessage.FailedCopy],
	handler: function* () {
		return ({ label, text, generation }) =>
			Effect.map(CopyButton.writeClipboard(text), (ok) =>
				ok
					? CopiesMessage.SucceededCopy({ label, generation })
					: CopiesMessage.FailedCopy({ label, generation }),
			)
	},
})

export const WaitRowCopyStatus = MetaRowCopiesDefinition.makeCommand("WaitMetaRowCopyStatus", {
	args: { label: Schema.String, generation: Schema.Finite },
	messages: [CopiesMessage.ElapsedCopyStatus],
	handler: function* () {
		return ({ label, generation }) =>
			Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(CopiesMessage.ElapsedCopyStatus({ label, generation })))
	},
})

const MetaRowCopiesComposition = MetaRowCopiesDefinition.makeComposition()

const entryOf = (model: CopiesModel, label: string): CopyButton.Model => model.byLabel[label] ?? IDLE_COPY

const withEntry = (model: CopiesModel, label: string, entry: CopyButton.Model): CopiesModel => ({
	byLabel: { ...model.byLabel, [label]: entry },
})

const settled = (model: CopiesModel, label: string, generation: number, status: CopyButton.CopyStatus) => {
	const entry = entryOf(model, label)
	return generation === entry.generation
		? {
				model: withEntry(model, label, { ...entry, status }),
				commands: [WaitRowCopyStatus({ label, generation })],
			}
		: { model, commands: [] }
}

const updateCopies = MetaRowCopiesComposition.makeUpdate({
	ClickedCopy: (model, { label, text }) => {
		const generation = entryOf(model, label).generation + 1
		const next = withEntry(model, label, { ...entryOf(model, label), generation })
		return text === ""
			? settled(next, label, generation, "error")
			: { model: next, commands: [WriteRowClipboard({ label, text, generation })] }
	},
	SucceededCopy: (model, { label, generation }) => settled(model, label, generation, "copied"),
	FailedCopy: (model, { label, generation }) => settled(model, label, generation, "error"),
	ElapsedCopyStatus: (model, { label, generation }) => {
		const entry = entryOf(model, label)
		return generation === entry.generation
			? { model: withEntry(model, label, { ...entry, status: "idle" }) }
			: { model }
	},
})

const prepareCopies = () =>
	MetaRowCopiesComposition.prepareBlock({
		init: MetaRowCopiesComposition.makeInit(() => ({ model: { byLabel: {} } })),
		update: updateCopies,
		EffectsLayer: Layer.mergeAll(WriteRowClipboard.layer, WaitRowCopyStatus.layer),
	})
/** Bind it once per page (`field: "copies"`) and embed each copyable row with `metaRowView`. */
export const MetaRowCopiesBlock: Block.FromAssemblyWithoutViewOrOutMessage<
	typeof CopiesModel,
	typeof prepareCopies
> = Block.assemble(prepareCopies)

const titled = <M>(h: HtmlBuilder<M>, iconName: IconName) =>
	cardHeader(
		h,
		[
			cardTitle(
				h,
				[icon(h, iconName, { size: 14, className: "text-muted-foreground" }), "Resource attributes"],
				"flex items-center gap-2 text-sm font-medium",
			),
		],
		"pb-3",
	)

export const resourceAttributesCard = <M>(
	h: HtmlBuilder<M>,
	iconName: IconName,
	children: ReadonlyArray<Html>,
	contentClassName?: string,
): Html => card(h, [titled(h, iconName), cardPanel(h, children, contentClassName ?? "space-y-1")])

const SKELETON_ROWS = [
	["w-12", "w-24"],
	["w-16", "w-28"],
	["w-10", "w-20"],
	["w-14", "w-32"],
	["w-12", "w-16"],
	["w-16", "w-24"],
] as const

export const resourceAttributesCardSkeleton = <M>(h: HtmlBuilder<M>, iconName: IconName): Html =>
	h.div(
		[h.Class(cn(cardStyles)), h.DataAttribute("slot", "card"), h.AriaBusy(true)],
		[
			titled(h, iconName),
			cardPanel(
				h,
				SKELETON_ROWS.map(([label, value]) =>
					h.div(
						[h.Class("flex items-center justify-between gap-3")],
						[skeleton(h, `h-2.5 ${label}`), skeleton(h, `h-2.5 ${value}`)],
					),
				),
				"space-y-3",
			),
		],
	)

/** `HostMetadataPanel`'s `Section`. */
export const attributeSection = <M>(h: HtmlBuilder<M>, title: string, rows: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("space-y-0.5 py-2 first:pt-0 last:pb-0")],
		[h.div([h.Class("text-2xs font-medium text-muted-foreground")], [title]), h.div([], rows)],
	)

export type MetaRowOptions = Readonly<{
	label: string
	value: string | null | undefined
	copyable?: boolean
	copyValue?: string
	tooltip?: string
	valueClassName?: string
}>

const rowOptions = (options: MetaRowOptions) => ({
	label: options.label,
	value: options.value,
	valueClassName: options.valueClassName,
	tooltip: options.tooltip,
})

/** `DetailRail.MetaRow` without a copy button (`copyable` needs `metaRowView`'s copy state). */
export const metaRow = <M>(h: HtmlBuilder<M>, options: MetaRowOptions): Html =>
	detailRailMetaRow(h, rowOptions(options))

/**
 * `DetailRail.MetaRow` with the copy button's state kept in `MetaRowCopiesBlock`:
 * `h.block(CopiesBinding.embedView({ slotId, model, view: metaRowView, viewInputs }))`.
 */
export const metaRowView = MetaRowCopiesBlock.makeView.withInputs<MetaRowOptions>((model, options, h) => {
	const value = options.value
	const isCopyable = options.copyable === true || Boolean(options.copyValue)
	return detailRailMetaRow(h, {
		...rowOptions(options),
		copy:
			isCopyable && value
				? {
						status: entryOf(model, options.label).status,
						onClick: CopiesMessage.ClickedCopy({
							label: options.label,
							text: options.copyValue ?? value,
						}),
					}
				: undefined,
	})
})
