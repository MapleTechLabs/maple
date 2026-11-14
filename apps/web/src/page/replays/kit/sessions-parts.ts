import type { SessionTag } from "@maple/domain/query-engine"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import type { IconName } from "@maple/views/ui/icon"
import { statusDot } from "@maple/views/ui/status-dot"
import type { SessionListItem, SessionRow } from "./session-row"
import { String as Str } from "effect"

// Shared parts of the sessions list and its pills.

// The icon for a browser, OS or device name.
export const browserIconFor = (name: string): IconName => {
	const n = Str.toLowerCase(name)
	if (Str.includes("edg")(n)) return "EdgeIcon"
	if (Str.includes("opera")(n) || Str.includes("opr")(n)) return "OperaIcon"
	if (Str.includes("chrome")(n)) return "ChromeIcon"
	if (Str.includes("firefox")(n)) return "FirefoxIcon"
	if (Str.includes("safari")(n)) return "SafariIcon"
	return "GlobeIcon"
}

export const deviceIconFor = (type: string): IconName => {
	const t = Str.toLowerCase(type)
	if (t === "mobile" || t === "phone") return "MobileIcon"
	if (t === "tablet") return "TabletIcon"
	return "MonitorIcon"
}

export const COLUMNS = {
	org: "hidden w-44 shrink-0 @3xl:flex",
	tags: "hidden w-40 shrink-0 @2xl:flex",
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
	eyebrow(
		h,
		{ as: "div", className: "hidden items-center gap-4 border-b border-border px-3 py-1.5 @2xl:flex" },
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

export const livePill = <M>(h: HtmlBuilder<M>, isCompact: boolean): Html =>
	badge(
		h,
		{
			variant: "ok",
			pill: true,
			size: isCompact ? "xs" : "default",
			className: isCompact ? "tracking-caption" : "gap-1.5",
		},
		[statusDot(h, { tone: "ok" }), isCompact ? "LIVE" : "Live"],
	)
