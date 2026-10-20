import type { Html, HtmlBuilder } from "foldkit/html"
import { MAPLE_MARK_PATH } from "../ui/icons.generated"

const TRACKS = [1, 2, 3, 4, 5]

/** The boot splash: shown while the session resolves. */
export const bootSplash = <Message>(h: HtmlBuilder<Message>): Html =>
	h.main(
		[
			h.Role("status"),
			h.AriaLabel("Loading Maple"),
			h.Class("flex min-h-screen w-full flex-col items-center justify-center gap-6 bg-background"),
		],
		[
			h.div(
				[h.Class("boot-mark")],
				[
					h.svg(
						[
							h.Attribute("viewBox", "0 0 739 739"),
							h.Attribute("width", "56"),
							h.Attribute("height", "56"),
							h.AriaHidden(true),
						],
						[
							h.path([
								h.Attribute("fill-rule", "evenodd"),
								h.Attribute("fill", "currentColor"),
								h.Attribute("d", MAPLE_MARK_PATH),
							]),
							lid(h, "119", "255"),
							lid(h, "284", "275"),
						],
					),
				],
			),
			h.div(
				[h.Class("boot-trace"), h.AriaHidden(true)],
				[
					...TRACKS.map((index) => h.span([h.Class(`boot-track boot-track--${index}`)])),
					...TRACKS.map((index) => h.span([h.Class(`boot-span boot-span--${index}`)])),
					h.span([h.Class("boot-scan")]),
				],
			),
			h.p([h.Class("boot-caption")], ["Collecting spans…"]),
			h.span([h.Class("sr-only")], ["Loading…"]),
		],
	)

const lid = <Message>(h: HtmlBuilder<Message>, x: string, y: string): Html =>
	h.rect([
		h.Class("boot-lid"),
		h.Attribute("x", x),
		h.Attribute("y", y),
		h.Attribute("width", "142"),
		h.Attribute("height", "222"),
		h.Attribute("fill", "currentColor"),
	])
