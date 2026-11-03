import { cn } from "@maple/ui/lib/utils"
import { badge } from "@maple/views/ui/display"
import { heading } from "@maple/views/ui/heading"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import type { Html, HtmlBuilder } from "foldkit/html"

// The small pieces of `SessionDetailView`: status badge, stat tiles and cards.

export const statusBadge = <M>(h: HtmlBuilder<M>, isActive: boolean): Html =>
	isActive
		? badge(h, { variant: "ok", pill: true, className: "gap-1.5" }, [statusDot(h, { tone: "ok" }), "Active"])
		: badge(h, { variant: "muted", pill: true }, ["Ended"])

export const statTile = <M>(h: HtmlBuilder<M>, label: string, value: string, isDanger = false): Html =>
	h.div(
		[h.Class("rounded-xl border bg-card px-3 py-2.5")],
		[
			typography(h, { as: "p", size: "xs", tone: "muted" }, [label]),
			h.p(
				[h.Class(cn("mt-1 text-2xl font-semibold tabular-nums tracking-tight", isDanger && "text-severity-error"))],
				[value],
			),
		],
	)

export const card = <M>(h: HtmlBuilder<M>, title: string, children: ReadonlyArray<Html>): Html =>
	h.section([h.Class("rounded-xl border bg-card p-4")], [heading(h, { level: 2, variant: "subsection", className: "mb-3" }, [title]), ...children])
