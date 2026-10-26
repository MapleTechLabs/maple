import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { dotLoader } from "../../page/chat/kit/dot-loader"
import { statusMarker } from "../../page/chat/kit/view-transcript"
import { eyebrow } from "../../ui/eyebrow"
import { defineLab } from "../define"

// `/lab/loaders`: the chat's loader on the lines it sits on.

const Model = Schema.Struct({})
type Model = typeof Model.Type

const heading = <M>(h: HtmlBuilder<M>, text: string): Html =>
	eyebrow(h, { variant: "label", as: "h2", className: "mb-2" }, [text])

const view = (_model: Model, h: HtmlBuilder<never>): Html =>
	h.div(
		[h.Class("mx-auto flex max-w-3xl flex-col gap-10 p-8")],
		[
			h.header(
				[h.Class("flex flex-col gap-1")],
				[
					h.h1([h.Class("font-semibold text-lg")], ["Chat loader"]),
					h.p(
						[h.Class("text-muted-foreground text-sm")],
						[
							"One dot-matrix animation, one 14px box, everywhere the chat reports work in flight.",
						],
					),
				],
			),
			h.section(
				[h.Class("flex flex-col gap-1")],
				[
					heading(h, "The tool row: running, then settled"),
					...["Searching Traces", "Reading spans", "Grouping by service"].map((line) =>
						h.div(
							[h.Key(line), h.Class("flex items-center gap-2 py-0.5 text-xs")],
							[
								h.span(
									[h.Class("flex size-5 shrink-0 items-center justify-center")],
									[dotLoader(h)],
								),
								h.span(
									[h.Class("min-w-0 flex-1 truncate font-medium text-foreground")],
									[line],
								),
							],
						),
					),
				],
			),
			h.section(
				[h.Class("flex flex-col gap-1")],
				[
					heading(h, "The sidebar tab"),
					h.div(
						[h.Class("flex items-center gap-2 py-0.5 text-sm")],
						[
							dotLoader(h, { color: "var(--primary)", label: "Working" }),
							h.span([h.Class("min-w-0 flex-1 truncate")], ["Investigating checkout latency"]),
						],
					),
				],
			),
			h.section([h.Class("flex flex-col gap-1")], [heading(h, "The thinking row"), statusMarker(h)]),
			h.section(
				[h.Class("flex flex-col gap-2")],
				[
					heading(h, "In running prose"),
					h.p(
						[h.Class("text-sm leading-relaxed")],
						[
							"The checkout path is still degraded ",
							dotLoader(h),
							" and the paywall worker is the one dragging it down ",
							dotLoader(h),
							" so I am pulling the last hour of spans ",
							dotLoader(h),
							"before saying anything firmer.",
						],
					),
				],
			),
		],
	)

export const lab = defineLab("Chat loaders", {
	Model,
	init: () => ({ model: {} }),
	update: (model: Model, _message: never) => ({ model }),
	view,
})
