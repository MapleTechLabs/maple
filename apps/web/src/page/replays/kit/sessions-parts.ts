import type { SessionTag } from "@maple/domain/query-engine"
import { countLabel } from "@maple/ui/lib/format"
import { TONE_BORDER, TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import type { IconName } from "../../../ui/icon"
import { statusDot } from "../../../ui/status-dot"
import type { SessionListItem, SessionRow } from "./session-row"

// Shared parts of the sessions list and its pills.
// TODO(tooltip): the org and tag pills' hover tooltips.

// The icon for a browser, OS or device name.
export const browserIconFor = (name: string): IconName => {
	const n = name.toLowerCase()
	if (n.includes("edg")) return "EdgeIcon"
	if (n.includes("opera") || n.includes("opr")) return "OperaIcon"
	if (n.includes("chrome")) return "ChromeIcon"
	if (n.includes("firefox")) return "FirefoxIcon"
	if (n.includes("safari")) return "SafariIcon"
	return "GlobeIcon"
}

export const deviceIconFor = (type: string): IconName => {
	const t = type.toLowerCase()
	if (t === "mobile" || t === "phone") return "MobileIcon"
	if (t === "tablet") return "TabletIcon"
	return "ComputerIcon"
}

export const COLUMNS = {
	org: "hidden w-36 shrink-0 @3xl:flex",
	tags: "hidden w-44 shrink-0 @2xl:flex",
	activity: "hidden w-[12.5rem] shrink-0 @5xl:flex",
	device: "hidden w-[6.5rem] shrink-0 @6xl:flex",
	signals: "hidden w-[10rem] shrink-0 @2xl:flex",
	time: "hidden w-24 shrink-0 justify-end @2xl:flex",
} as const

export type SessionsListOptions<M> = Readonly<{
	items: ReadonlyArray<SessionListItem>
	nowMs: number
	timeZone: string
	durationP95?: number | undefined
	onOpen: (session: SessionRow) => M
	onToggleRun: (key: string) => M
	onFilterTag?: (tag: SessionTag) => M
	onFilterGroup?: (group: string) => M
}>

export const columnHeader = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[
			h.Class(
				"hidden items-center gap-4 border-b border-border px-3 py-1.5 text-2xs font-medium text-muted-foreground @2xl:flex",
			),
		],
		[
			h.span([h.Class("min-w-0 flex-1")], ["User"]),
			h.span([h.Class(COLUMNS.org)], ["Org"]),
			h.span([h.Class(COLUMNS.tags)], ["Tags"]),
			h.span([h.Class(COLUMNS.activity)], ["Activity"]),
			h.span([h.Class(COLUMNS.device)], ["Device"]),
			h.span([h.Class(COLUMNS.signals)], ["Signals"]),
			h.span([h.Class(COLUMNS.time)], ["Started"]),
		],
	)

/** `LivePill`. */
export const livePill = <M>(h: HtmlBuilder<M>, isCompact: boolean): Html =>
	badge(
		h,
		{
			variant: "ok",
			pill: true,
			size: isCompact ? "xs" : "default",
			className: isCompact ? "tracking-wide" : "gap-1.5",
		},
		[statusDot(h, { tone: "ok" }), isCompact ? "LIVE" : "Live"],
	)

/** `ErrorCountPill`. */
export const errorCountPill = <M>(h: HtmlBuilder<M>, count: number): Html =>
	badge(
		h,
		{ pill: true, size: "xs", mono: true, className: cn("gap-1.5", TONE_SOFT.crit, TONE_BORDER.crit) },
		[statusDot(h, { tone: "crit", size: "sm" }), countLabel(count, "error")],
	)
