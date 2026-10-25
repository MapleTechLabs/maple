import { icon } from "@maple/web/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"

/** `NoEdgesNotice`: services are on the map but none called another; say what draws an edge. */
export const noEdgesNotice = <M>(h: HtmlBuilder<M>): Html => {
	const strong = (text: string) => h.span([h.Class("font-medium text-foreground")], [text])
	return h.div(
		[h.Class("flex shrink-0 items-start gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground")],
		[
			icon(h, "CircleInfoIcon", { size: 14, className: "mt-px shrink-0" }),
			h.p(
				[],
				[
					"No service-to-service calls in this window. An edge appears when a",
					" ",
					strong("Client"),
					" (or Producer) span in one service has a ",
					strong("Server"),
					" (or Consumer) child span in another, so both services need tracing and must propagate trace context between them. Database calls show up from client spans that carry",
					" ",
					h.code([h.Class("rounded bg-muted px-1 font-mono")], ["db.system.name"]),
					".",
				],
			),
		],
	)
}
