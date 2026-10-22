import { skeleton, skeletonList } from "@maple/web/ui/skeleton"
import { traceIdBadge } from "@maple/web/ui/trace-badges"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyState } from "../kit/view-states"
import type { Message } from "./message"

/** `TraceDetailLoading`: shaped like the loaded page (strip, spectrum bar, waterfall rows). */
export const traceDetailLoading = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("space-y-4 p-4")],
		[
			h.div(
				[h.Class("space-y-2")],
				[
					skeleton(h, "h-8 w-32"),
					skeleton(h, "h-1.5 w-full rounded-full"),
					h.div(
						[h.Class("flex gap-4")],
						[skeleton(h, "h-4 w-24"), skeleton(h, "h-4 w-24"), skeleton(h, "h-4 w-24")],
					),
				],
			),
			skeletonList(h, {
				rows: 8,
				gap: "px",
				className: "gap-0 rounded-md border",
				renderRow: () =>
					h.div(
						[h.Class("flex items-center gap-2 border-b p-3")],
						[
							skeleton(h, "size-4"),
							skeleton(h, "h-4 w-20"),
							skeleton(h, "h-4 w-16"),
							skeleton(h, "h-4 flex-1"),
							skeleton(h, "h-2 w-32"),
							skeleton(h, "h-4 w-16"),
						],
					),
			}),
		],
	)

/** No spans for this id: outside retention, or not arrived yet. */
export const traceNotFound = (h: HtmlBuilder<Message>, traceId: string): Html =>
	emptyState(h, {
		title: "Trace not found",
		hint: ["It may be outside the store's retention, or its spans have not arrived yet."],
		action: traceIdBadge(h, traceId, { size: "default", className: "text-xs" }),
	})
