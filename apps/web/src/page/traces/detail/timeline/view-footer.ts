import type { Html } from "foldkit/html"
import { button } from "../../../../ui/button"
import { kbd } from "../../../../ui/display"
import { serviceDot } from "../../../../ui/values"
import type { TimelineViewBuilder } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"

// The Timeline's footer (key hints and the service legend) and its shortcuts sheet.

type H = TimelineViewBuilder

const HINT_KBD = "h-4 font-mono text-4xs"

const hint = (h: H, keys: string, label: string): Html => h.span([], [kbd(h, HINT_KBD, [keys]), ` ${label}`])

export const footer = (h: H, model: Model): Html =>
	h.div(
		[
			h.Class(
				"flex shrink-0 items-center gap-3 border-t border-border bg-muted/30 px-2 py-1.5 text-3xs text-muted-foreground @min-[560px]/timeline:px-3",
			),
		],
		[
			h.div(
				[h.Class("hidden shrink-0 items-center gap-3 text-foreground/30 @min-[560px]/timeline:flex")],
				[
					hint(h, "Drag", "zoom"),
					hint(h, "W A S D", "navigate"),
					hint(h, "/", "search"),
					h.button(
						[
							h.Class("hover:text-foreground/70"),
							h.Type("button"),
							h.OnClick(Message.ClickedShortcuts()),
						],
						[kbd(h, HINT_KBD, ["?"]), " all shortcuts"],
					),
				],
			),
			h.div(
				[
					h.Class(
						"-mx-2 flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto px-2 [mask-image:linear-gradient(to_right,black_calc(100%-12px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden @min-[560px]/timeline:mx-0 @min-[560px]/timeline:flex-wrap @min-[560px]/timeline:justify-end @min-[560px]/timeline:overflow-x-visible @min-[560px]/timeline:px-0 @min-[560px]/timeline:[mask-image:none]",
					),
				],
				[
					...model.services.map((service) =>
						h.div(
							[h.Class("flex shrink-0 items-center gap-1")],
							[
								serviceDot(h, { serviceName: service }),
								h.span([h.Class("font-medium whitespace-nowrap")], [service]),
							],
						),
					),
					h.div(
						[h.Class("flex shrink-0 items-center gap-1")],
						[
							h.span(
								[
									h.AriaHidden(true),
									h.Class(
										"size-2 shrink-0 rounded-[35%] bg-severity-error [corner-shape:squircle]",
									),
								],
								[],
							),
							h.span([h.Class("font-medium")], ["Error"]),
						],
					),
				],
			),
		],
	)

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
	["W / S", "Zoom in / out at cursor (⇧ faster)"],
	["A / D", "Pan left / right (⇧ faster)"],
	["F", "Fit focused span or whole trace"],
	["E / ⇧E", "Expand / collapse one level"],
	["Drag", "Zoom to selection"],
	["⇧ Drag / middle-drag", "Pan"],
	["⌘ Scroll", "Zoom at cursor"],
	["Double-click", "Zoom to span"],
	["↑ ↓", "Move row focus"],
	["← →", "Collapse / expand span (⌥ whole subtree)"],
	["⌥ Click chevron", "Collapse / expand whole subtree"],
	["Enter / Space", "Select focused span"],
	["/", "Search · Enter next · ⇧Enter previous"],
	["Esc", "Clear search / focus · close this"],
]

export const shortcutsOverlay = (h: H): Html =>
	h.div(
		[
			h.Class("absolute inset-0 z-30 flex items-center justify-center bg-background/60"),
			h.OnClick(Message.ClickedCloseShortcuts()),
		],
		[
			h.div(
				[
					h.Class(
						"max-h-[80%] w-[420px] max-w-[90%] overflow-y-auto border border-border bg-popover p-4 shadow-lg",
					),
					h.OnClick(Message.ClickedShortcutsSheet(), { propagation: "Stop" }),
				],
				[
					h.div(
						[h.Class("mb-3 flex items-center justify-between")],
						[
							h.span([h.Class("text-xs font-medium")], ["Timeline shortcuts"]),
							button(
								h,
								{
									variant: "link",
									size: "xs",
									attributes: [
										h.OnClick(Message.ClickedCloseShortcuts(), { propagation: "Stop" }),
									],
								},
								["Esc"],
							),
						],
					),
					h.div(
						[h.Class("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-2xs")],
						SHORTCUTS.flatMap(([keys, description]) => [
							kbd(h, "justify-self-start whitespace-nowrap font-mono text-3xs", [keys]),
							h.span([h.Class("text-muted-foreground self-center")], [description]),
						]),
					),
				],
			),
		],
	)
