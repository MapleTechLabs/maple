import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../ui/eyebrow"

// apps/web/src/lab/kit/kit-layout.tsx: one page per primitive group, one section per primitive.
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
