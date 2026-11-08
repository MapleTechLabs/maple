import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "@maple/ui/lib/utils"
import { hstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"

/** `NoEdgesNotice`: services are on the map but none called another; say what draws an edge. */
export const noEdgesNotice = <M>(h: HtmlBuilder<M>): Html => {
	const strong = (text: string) => typography(h, { weight: "medium", tone: "foreground" }, [text])
	return hstack(
		h,
		{
			gap: "2",
			align: "start",
			className: cn(
				"shrink-0 border-b bg-muted/30 px-4 py-2",
				typographyClass({ size: "xs", tone: "muted" }),
			),
		},
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
					inlineCode(h, { variant: "chip" }, ["db.system.name"]),
					".",
				],
			),
		],
	)
}
