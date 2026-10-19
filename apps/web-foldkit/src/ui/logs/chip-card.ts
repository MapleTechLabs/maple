import { cn } from "@maple/ui/lib/utils"
import { Array, Effect, Option, Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyButton } from "../copy-button"
import { eyebrow } from "../eyebrow"
import { icon } from "../icon"
import type { LogChip } from "./log-row-view"
import type { Model } from "./logs-stream"
import { Message } from "./logs-stream-message"
import { hoverCardContentStyles } from "@maple/ui/styles/ui/hover-card"
import { CHIP_FILTER_ACTION_CLASS } from "./styles"

/** Base UI PreviewCard positioning for `side="bottom" align="start"`, offsets 4, collision padding 5. */
const SIDE_OFFSET = 4
const ALIGN_OFFSET = 4
const COLLISION_PADDING = 5

const findChip = (index: number, key: string): HTMLElement | undefined =>
	Array.findFirst(
		document.querySelectorAll<HTMLElement>(`[role='log'] > [data-index="${index}"] button[aria-label]`),
		(button) => button.getAttribute("aria-label")?.startsWith(`Copy ${key}=`) === true,
	).pipe(Option.getOrUndefined)

/** Flips side, then alignment, then shifts into the viewport, as Floating UI does for Base UI. */
export const place = (positioner: HTMLElement, popup: HTMLElement, anchor: DOMRect) => {
	const width = popup.offsetWidth
	const height = popup.offsetHeight
	const viewportWidth = document.documentElement.clientWidth
	const viewportHeight = document.documentElement.clientHeight
	const below = anchor.bottom + SIDE_OFFSET
	const isBottom =
		below + height <= viewportHeight - COLLISION_PADDING ||
		anchor.top - SIDE_OFFSET - height < COLLISION_PADDING
	const y = isBottom ? below : anchor.top - SIDE_OFFSET - height
	const start = anchor.left + ALIGN_OFFSET
	const isStart = start + width <= viewportWidth - COLLISION_PADDING
	const aligned = isStart ? start : anchor.right - width - ALIGN_OFFSET
	const x = Math.min(Math.max(aligned, COLLISION_PADDING), viewportWidth - COLLISION_PADDING - width)
	const side = isBottom ? "bottom" : "top"
	const align = isStart ? "start" : "end"
	positioner.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
	positioner.style.setProperty("--anchor-width", `${anchor.width}px`)
	positioner.style.setProperty("--anchor-height", `${anchor.height}px`)
	positioner.style.setProperty(
		"--transform-origin",
		`${isStart ? "0%" : "100%"} ${isBottom ? -SIDE_OFFSET : height + SIDE_OFFSET}px`,
	)
	Array.forEach([positioner, popup], (element) => {
		element.setAttribute("data-side", side)
		element.setAttribute("data-align", align)
	})
}

/** Moves the card to <body> (Base UI's portal) and keeps it under its chip while anything scrolls. */
export const PlaceChipCard = Mount.define("PlaceChipCard", {
	args: { index: Schema.Number, key: Schema.String },
	messages: [Message.PlacedChipCard],
	execute: ({ element, index, key }) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const positioner = element.firstElementChild
				const popup = positioner?.firstElementChild
				document.body.appendChild(element)
				const update = () => {
					const anchor = findChip(index, key)
					if (
						anchor !== undefined &&
						positioner instanceof HTMLElement &&
						popup instanceof HTMLElement
					)
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

/** `<CopyButton iconSize={10}>` in its idle state, as `SelectableValue` renders it. */
const valueCopyButton = (h: HtmlBuilder<Message>, label: string, onClick: Message): Html =>
	copyButton(h, {
		label,
		status: "idle",
		iconSize: 10,
		className:
			"-my-1 ml-1 size-5 shrink-0 align-middle opacity-0 transition-opacity group-hover/sel:opacity-100 group-hover/attr:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 sm:size-5",
		attributes: [h.OnClick(onClick, { propagation: "Stop" })],
	})

const cardEyebrow = (h: HtmlBuilder<Message>, text: string): Html =>
	eyebrow(h, { as: "div", className: "mb-0.5" }, [text])

const filterAction = (
	h: HtmlBuilder<Message>,
	label: string,
	negated: boolean,
	icon: Html,
	text: string,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.AriaLabel(label),
			h.OnClick(Message.ClickedChipFilter({ negated }), { propagation: "Stop" }),
			h.Class(CHIP_FILTER_ACTION_CLASS),
		],
		[icon, text],
	)

const cardView = (h: HtmlBuilder<Message>, index: number, chip: LogChip, canFilter: boolean): Html =>
	h.keyed("div")(
		`chip-card-${index}-${chip.key}`,
		[
			h.DataAttribute("base-ui-portal", ""),
			h.DataAttribute("slot", "hover-card-portal"),
			h.OnMount(PlaceChipCard({ index, key: chip.key })),
		],
		[
			h.div(
				[
					h.DataAttribute("open", ""),
					h.Role("presentation"),
					h.Class("isolate z-55"),
					h.Style({ position: "absolute", top: "0px", left: "0px" }),
				],
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
							h.div(
								[h.Class("px-3 py-2 border-b")],
								[
									cardEyebrow(h, "Attribute"),
									h.div(
										[h.Class("font-mono text-xs break-all")],
										[
											h.button(
												[
													h.Type("button"),
													h.AriaLabel("Copy value"),
													h.Class(
														"-mx-0.5 cursor-pointer rounded px-0.5 text-left transition-colors hover:bg-muted/50",
													),
													h.Title("Click to copy"),
													h.OnClick(Message.ClickedCardCopy({ part: "key" }), {
														propagation: "Stop",
													}),
												],
												[chip.key],
											),
										],
									),
								],
							),
							h.div(
								[h.Class("px-3 py-2")],
								[
									cardEyebrow(h, "Value"),
									h.div(
										[h.Class("font-mono text-xs break-all")],
										[
											h.span(
												[h.Class("group/sel")],
												[
													h.span([h.Class("select-text")], [chip.value]),
													valueCopyButton(
														h,
														chip.key,
														Message.ClickedCardCopy({ part: "value" }),
													),
												],
											),
										],
									),
								],
							),
							...(canFilter && !chip.isJson
								? [
										h.div(
											[h.Class("flex items-center gap-1 border-t px-2 py-1.5")],
											[
												filterAction(
													h,
													`Filter in ${chip.key} = ${chip.value}`,
													false,
													icon(h, "PlusIcon", { size: 10 }),
													"Filter in",
												),
												filterAction(
													h,
													`Filter out ${chip.key} = ${chip.value}`,
													true,
													icon(h, "MinusIcon", { size: 10 }),
													"Filter out",
												),
											],
										),
									]
								: []),
						],
					),
				],
			),
		],
	)

/** The open attribute card, or nothing. */
export const chipCard = (h: HtmlBuilder<Message>, model: Model, canFilter: boolean): Html =>
	Option.match(
		Option.flatMap(model.visibleChip, ({ index, key }) =>
			Option.flatMap(Option.fromNullishOr(model.rows[index]), (row) =>
				Option.map(
					Array.findFirst(row.chips, (chip) => chip.key === key),
					(chip) => ({ index, chip }),
				),
			),
		),
		{ onNone: () => h.empty, onSome: ({ index, chip }) => cardView(h, index, chip, canFilter) },
	)
