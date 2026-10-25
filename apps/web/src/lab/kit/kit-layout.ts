import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../ui/eyebrow"

// Port of apps/web/src/lab/kit/kit-layout.ts: the frame every `/lab/kit/<group>` page shares.

export const kitPage = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ title: string; description: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.div(
		[h.Class("mx-auto flex max-w-5xl flex-col gap-10 p-8")],
		[
			h.header(
				[h.Class("flex flex-col gap-1")],
				[
					h.h1([h.Class("font-semibold text-lg")], [options.title]),
					h.p([h.Class("text-muted-foreground text-sm")], [options.description]),
				],
			),
			...children,
		],
	)

export const kitSection = <Message>(
	h: HtmlBuilder<Message>,
	title: string,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[h.AriaLabel(title), h.Class("flex flex-col gap-3")],
		[eyebrow(h, { variant: "label", as: "h2" }, [title]), ...children],
	)

export const kitRow = <Message>(
	h: HtmlBuilder<Message>,
	label: string | undefined,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-3")],
		[
			...(label === undefined
				? []
				: [h.span([h.Class("w-36 shrink-0 font-mono text-muted-foreground text-xs")], [label])]),
			...children,
		],
	)
