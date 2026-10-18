import { cn } from "@maple/ui/lib/utils"
import { hoverCardContentStyles } from "@maple/ui/styles/ui/hover-card"
import { place } from "@maple/web-foldkit/ui/logs/chip-card"
import { copyButton } from "@maple/web-foldkit/ui/copy-button"
import { eyebrow } from "@maple/web-foldkit/ui/eyebrow"
import { Array, Effect, Option, Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type RowChip, rowChips } from "./derive"
import { Message } from "./message"
import type { ChipRef, Model } from "./model"
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

const cardView = (h: H, ref: ChipRef, chip: RowChip): Html =>
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
									]),
								]),
							]),
						],
					),
				],
			),
		],
	)

/** The shown card, if its row and chip are still on screen. */
export const chipCard = (h: H, model: Model): ReadonlyArray<Html> =>
	Option.match(
		Option.flatMap(model.chipCard.visible, (ref) =>
			Option.flatMap(Option.filter(Array.get(rowsOf(model), ref.index), (log) => logKey(log) === ref.logKey), (log) =>
				Option.map(Array.findFirst(rowChips(log), (chip) => chip.key === ref.key), (chip) => ({ ref, chip })),
			),
		),
		{ onNone: () => [], onSome: ({ ref, chip }) => [cardView(h, ref, chip)] },
	)
