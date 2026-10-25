import { cn } from "@maple/ui/lib/utils"
import { skeletonListGapStyles, skeletonListStyles } from "@maple/ui/styles/ui/skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { traceIdBadge } from "../../../ui/trace-badges"
import { skeleton } from "../../../ui/skeleton"
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
			h.div(
				[
					h.AriaBusy(true),
					h.Class(cn(skeletonListStyles, skeletonListGapStyles.px, "gap-0 rounded-md border")),
					h.DataAttribute("slot", "skeleton-list"),
				],
				Array.from({ length: 5 }, () => loadingRow(h)),
			),
		],
	)

export const traceNotFound = (
	h: HtmlBuilder<Message>,
	traceId: string,
	backHref: string,
	copy: Readonly<{ title: string; description: string; hasRetentionLink?: boolean }>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { size: 18 })]),
				emptyTitle(h, [copy.title]),
				emptyDescription(h, [
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
				]),
			]),
			linkButton(h, { variant: "outline", size: "sm", href: backHref }, ["Back to Traces"]),
		],
		"md:py-12",
	)
