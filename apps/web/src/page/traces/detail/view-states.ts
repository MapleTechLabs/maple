import type { Html, HtmlBuilder } from "foldkit/html"

import { traceIdBadge } from "../../../ui/trace-badges"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { resourceNotFound } from "../../kit/resource-not-found"
import { docsLink } from "../../kit/signal-empty-state"
import type { Message } from "./message"

// `TraceDetailLoading` and `TraceNotFound` (`ResourceNotFound` with the trace id badge).

const loadingRow = (h: HtmlBuilder<Message>): Html =>
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
	)

export const detailLoading = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("space-y-4")],
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
			skeletonList(h, { rows: 5, className: "gap-0 rounded-md border", renderRow: () => loadingRow(h) }),
		],
	)

export const traceNotFound = (
	h: HtmlBuilder<Message>,
	traceId: string,
	backHref: string,
	copy: Readonly<{ title: string; description: string; hasRetentionLink?: boolean }>,
): Html =>
	resourceNotFound(h, {
		title: copy.title,
		description: [
			h.div(
				[h.Class("flex flex-col items-center gap-3")],
				[
					traceIdBadge(h, traceId),
					h.p([h.Class("max-w-md")], [copy.description]),
					copy.hasRetentionLink === true
						? docsLink(h, "retention", "How long traces are kept")
						: null,
				],
			),
		],
		back: { href: backHref, label: "Back to Traces" },
	})
