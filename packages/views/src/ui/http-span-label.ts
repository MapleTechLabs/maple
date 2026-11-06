import { getHttpInfo, HTTP_METHOD_COLORS } from "@maple/ui/lib/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { middleTruncate } from "./middle-truncate"

// Port of `HttpSpanLabel` (packages/ui/src/components/traces/http-span-label.tsx).

export type HttpSpanLabelOptions = Readonly<{
	spanName: string
	spanAttributes?: Readonly<Record<string, string>>
	spanKind?: string
	className?: string
	textClassName?: string
}>

const outgoingGlyph = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(
		[
			h.Attribute("aria-label", "outgoing request"),
			h.Attribute("class", "size-2.5 -ml-0.5 opacity-90"),
			h.Attribute("fill", "none"),
			h.Attribute("stroke", "currentColor"),
			h.Attribute("stroke-linecap", "square"),
			h.Attribute("stroke-linejoin", "miter"),
			h.Attribute("stroke-width", "2"),
			h.Attribute("viewBox", "0 0 10 10"),
		],
		[h.path([h.Attribute("d", "M3 7L7 3")]), h.path([h.Attribute("d", "M4 3H7V6")])],
	)

export const httpSpanLabel = <M>(h: HtmlBuilder<M>, options: HttpSpanLabelOptions): Html => {
	const info = getHttpInfo({
		spanName: options.spanName,
		spanAttributes: options.spanAttributes === undefined ? undefined : { ...options.spanAttributes },
		spanKind: options.spanKind,
	})
	if (info === null) {
		return h.span(
			[
				h.Class(cn("block truncate", options.className, options.textClassName)),
				h.Title(options.spanName),
			],
			[options.spanName],
		)
	}
	const isClient = info.kind === "client"
	const route = info.route === null || info.route === "" ? options.spanName : info.route
	return h.span(
		[
			h.Class(cn("flex min-w-0 items-center gap-1.5 font-mono", options.className)),
			h.Title(`${isClient ? "Outgoing → " : ""}${route}`),
		],
		[
			h.span(
				[
					h.Class(
						cn(
							"shrink-0 inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-3xs font-bold leading-none text-white",
							HTTP_METHOD_COLORS[info.method] ?? "bg-http-options",
						),
					),
				],
				[...(isClient ? [outgoingGlyph(h)] : []), info.method],
			),
			middleTruncate(h, { text: route, tail: 16, className: options.textClassName }),
		],
	)
}
