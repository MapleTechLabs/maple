import { cn } from "@maple/ui/lib/utils"
import { hoverCardContentStyles } from "@maple/ui/styles/ui/hover-card"
import { place } from "@maple/web/ui/logs/chip-card"
import { highlightCode } from "@maple/web/lib/highlight"
import { tryParseJson } from "@maple/web/ui/attributes/attribute-row"
import * as CopyButton from "@maple/web/ui/copy-button"
import { copyButton } from "@maple/web/ui/copy-button"
import { eyebrow } from "@maple/web/ui/eyebrow"
import { icon } from "@maple/web/ui/icon"
import * as Tooltip from "@maple/web/ui/tooltip"
import { Array, Effect, Option, Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type RowChip, rowChips } from "./derive"
import { Message } from "./message"
import { copyOf } from "../kit/copies"
import { CHIP_JSON_COPY_ID, type ChipRef, type LocalLog, type Model } from "./model"
import { logKey, rowsOf } from "./stream"
import { chipId } from "./view-row"

// `LogAttributeChip`'s card: the full key and value, mounted only while shown, in `<body>`.

type H = HtmlBuilder<Message>

/** Moves the card to `<body>` (Base UI's portal) and keeps it under its chip while anything scrolls. */
export const PlaceLocalChipCard = Mount.define("PlaceLocalChipCard", {
	args: { anchorId: Schema.String },
	messages: [Message.PlacedChipCard],
	execute: ({ element, anchorId }) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const positioner = element.firstElementChild
				const popup = positioner?.firstElementChild
				document.body.appendChild(element)
				const update = () => {
					const anchor = document.getElementById(anchorId)
					if (anchor !== null && positioner instanceof HTMLElement && popup instanceof HTMLElement)
						place(positioner, popup, anchor.getBoundingClientRect())
				}
				update()
				const listenerOptions = { capture: true, passive: true }
				window.addEventListener("scroll", update, listenerOptions)
				window.addEventListener("resize", update)
				return () => {
					window.removeEventListener("scroll", update, listenerOptions)
					window.removeEventListener("resize", update)
					element.remove()
				}
			}),
			(cleanup) => Effect.sync(cleanup),
		).pipe(Effect.as(Message.PlacedChipCard())),
})

const cardEyebrow = (h: H, text: string): Html => eyebrow(h, { as: "div", className: "mb-0.5" }, [text])

// copied: `copyTooltipText` (packages/ui/src/components/ui/copy-button.tsx).
const copyTooltipText = (status: CopyButton.CopyStatus, label: string): string =>
	status === "copied" ? "Copied" : status === "error" ? "Failed to copy" : `Copy ${label}`

/** `<CopyButton label="JSON" tooltip>` over the expanded block, with its Base UI tooltip. */
const jsonCopy = (h: H, model: Model, value: string, block: ReadonlyArray<Html>): Html => {
	const status = copyOf(model.copies, CHIP_JSON_COPY_ID).status
	return h.submodel({
		slotId: "chip-json-tooltip",
		model: model.chipJsonTooltip,
		view: Tooltip.view,
		toParentMessage: (message: Tooltip.Message) => Message.GotChipJsonTooltipMessage({ message }),
		viewInputs: {
			toContent: () => [copyTooltipText(status, "JSON")],
			toView: ({ trigger, portal }) =>
				h.div([h.Class("group/json relative mt-1 overflow-hidden rounded-md border bg-muted/30")], [
					...block,
					copyButton(h, {
						label: "JSON",
						status,
						iconSize: 10,
						slot: "tooltip-trigger",
						className:
							"absolute top-1 right-1 border-border/60 bg-background/80 opacity-0 backdrop-blur-sm transition-opacity focus-visible:opacity-100 group-hover/json:opacity-100 pointer-coarse:opacity-100",
						attributes: [
							...trigger(),
							h.OnClick(
								Message.GotCopyMessage({ id: CHIP_JSON_COPY_ID, message: CopyButton.Message.ClickedCopy({ text: value }) }),
								{ propagation: "Stop" },
							),
						],
					}),
					...(portal === null ? [] : [portal]),
				]),
		},
	})
}

/** `CollapsibleJsonValue`: an 80-char preview that expands into highlighted JSON. */
const jsonValue = (h: H, model: Model, value: string, parsed: unknown): Html => {
	const isExpanded = model.chipCard.isJsonExpanded
	const preview = value.length > 80 ? value.slice(0, 80) + "…" : value
	return h.div([h.Class("min-w-0")], [
		h.button(
			[
				h.Type("button"),
				h.Class(
					"flex items-start gap-1 w-full text-left font-mono text-xs break-all cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors",
				),
				h.OnClick(Message.ClickedChipJson()),
				h.Title(isExpanded ? "Collapse" : "Expand JSON"),
			],
			[
				icon(h, "ChevronRightIcon", { size: 12, className: `shrink-0 mt-0.5 transition-transform ${isExpanded ? "rotate-90" : ""}` }),
				isExpanded ? h.span([h.Class("text-muted-foreground")], ["JSON"]) : h.span([], [preview]),
			],
		),
		...(isExpanded
			? [
					jsonCopy(h, model, value, [
						h.div([h.Class("max-h-64 overflow-auto p-2")], [
							h.pre([h.Class("text-xs leading-relaxed")], [
								h.code([h.InnerHTML(highlightCode(JSON.stringify(parsed, null, 2), "json"))], []),
							]),
						]),
					]),
				]
			: []),
	])
}

const cardView = (h: H, model: Model, ref: ChipRef, log: LocalLog, chip: RowChip): Html =>
	h.keyed("div")(
		`chip-card-${ref.index}-${chip.key}`,
		[h.DataAttribute("base-ui-portal", ""), h.DataAttribute("slot", "hover-card-portal"), h.OnMount(PlaceLocalChipCard({ anchorId: chipId(ref) }))],
		[
			h.div(
				[h.DataAttribute("open", ""), h.Role("presentation"), h.Class("isolate z-55"), h.Style({ position: "absolute", top: "0px", left: "0px" })],
				[
					h.div(
						[
							h.DataAttribute("open", ""),
							h.Tabindex(-1),
							h.DataAttribute("base-ui-focusable", ""),
							h.DataAttribute("slot", "hover-card-content"),
							h.Class(cn(hoverCardContentStyles, "max-h-[60vh] w-80 overflow-auto p-0")),
							h.OnMouseEnter(Message.EnteredChipCard()),
							h.OnMouseLeave(Message.LeftChipCard()),
							// A click the card does not stop opens the log, as a click on its row does.
							h.OnClick(Message.ClickedLog({ log })),
						],
						[
							h.div([h.Class("px-3 py-2 border-b")], [
								cardEyebrow(h, "Attribute"),
								h.div([h.Class("font-mono text-xs break-all")], [
									h.button(
										[
											h.Type("button"),
											h.AriaLabel("Copy value"),
											h.Class("-mx-0.5 cursor-pointer rounded px-0.5 text-left transition-colors hover:bg-muted/50"),
											h.Title("Click to copy"),
											h.OnClick(Message.ClickedChip({ text: chip.key }), { propagation: "Stop" }),
										],
										[chip.key],
									),
								]),
							]),
							h.div([h.Class("px-3 py-2")], [
								cardEyebrow(h, "Value"),
								h.div([h.Class("font-mono text-xs break-all")], [
									Option.match(tryParseJson(chip.value), {
										onSome: (parsed) => jsonValue(h, model, chip.value, parsed),
										onNone: () => selectableValue(h, chip),
									}),
								]),
							]),
						],
					),
				],
			),
		],
	)

/** `SelectableValue`: the text plus a copy button for the whole value. */
const selectableValue = (h: H, chip: RowChip): Html =>
	h.span([h.Class("group/sel")], [
		h.span([h.Class("select-text")], [chip.value]),
		copyButton(h, {
			label: chip.key,
			status: "idle",
			iconSize: 10,
			className:
				"-my-1 ml-1 size-5 shrink-0 align-middle opacity-0 transition-opacity group-hover/sel:opacity-100 group-hover/attr:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 sm:size-5",
			attributes: [h.OnClick(Message.ClickedChip({ text: chip.value }), { propagation: "Stop" })],
		}),
	])

/** The shown card, if its row and chip are still on screen. */
export const chipCard = (h: H, model: Model): ReadonlyArray<Html> =>
	Option.match(
		Option.flatMap(model.chipCard.visible, (ref) =>
			Option.flatMap(Option.filter(Array.get(rowsOf(model), ref.index), (log) => logKey(log) === ref.logKey), (log) =>
				Option.map(Array.findFirst(rowChips(log), (chip) => chip.key === ref.key), (chip) => ({ ref, log, chip })),
			),
		),
		{ onNone: () => [], onSome: ({ ref, log, chip }) => [cardView(h, model, ref, log, chip)] },
	)
