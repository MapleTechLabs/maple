import {
	countLabel,
	EMPTY_VALUE,
	formatDuration,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { columnClass } from "@maple/views/ui/column"
import { detailRailGroup, detailRailRow } from "@maple/views/ui/detail-rail"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyMessage,
	emptyTitle,
} from "@maple/views/ui/empty"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon, type IconName } from "@maple/views/ui/icon"
import { severityBadge } from "@maple/views/ui/logs/severity-badge"
import { pageDescription, pageTitle } from "@maple/views/ui/page-layout"
import { pressable } from "@maple/views/ui/pressable"
import { selectableRow } from "@maple/views/ui/selectable-row"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { serviceDot } from "@maple/views/ui/values"
import { Array as Arr, Option, Order } from "effect"
import { th, toolTable, toolTableBody, toolTableHead, toolTableRow } from "../agent-sessions/tools-kit/table"
import { listRelativeTime } from "../kit/relative-time"
import { clientIcon, kindTag } from "../mcp/view-kit"
import { statRail, statRailItem } from "../kit/stat-rail"
import { type LinkTab, linkTabStrip } from "../kit/underline-tabs"
import type { ActivityItem, ActivityKind, UserDetail, UserProfile, UserTab } from "./data"
import { ERRORS_ATTRIBUTED_FROM, namespacesOf, USER_TABS, userLabel } from "./data"
import { WORKFLOW_LABEL, workflowRingIcon } from "../errors/kit/workflow"
import { userAvatar } from "./view-kit"

// `/users/$userId`: one end user's identity, then everything Maple holds for them, by tab.

/** The namespace the page is scoped to: the org pin, or one picked on this page. */
export type UserNamespaceScope<M> = Readonly<{
	active: string | null
	isPinned: boolean
	/** Scope to a namespace, or back to all of them; ignored while the pin is on. */
	onSelect: (namespace: string | null) => M
	/** Ends the org-global pin (`RequestedNamespacePin` with none). */
	onClearPin: M
}>

export type UserDetailOptions<M> = Readonly<{
	tab: UserTab
	namespace: UserNamespaceScope<M>
	nowMs: number
	timeZone: string
	hrefOf: (tab: UserTab) => string
	onSelectTab: (tab: UserTab) => M
	/** Drawn in place of the tab's rows while they load or after their read failed. */
	tabContent?: Html | undefined
}>

type Clock = Readonly<{ nowMs: number; timeZone: string }>

const timeFormat = (timeZone: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-GB", { timeZone, ...options })

const clockOf = (atMs: number, timeZone: string): string =>
	timeFormat(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(atMs)

const dayKey = (atMs: number, timeZone: string): string =>
	timeFormat(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(atMs)

/** The local calendar day as a day count, so "yesterday" is one less even across a DST change. */
const dayNumber = (atMs: number, timeZone: string): number => {
	const parts = timeFormat(timeZone, { year: "numeric", month: "numeric", day: "numeric" }).formatToParts(
		atMs,
	)
	const part = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(
			Option.getOrElse(
				Option.map(
					Arr.findFirst(parts, (entry) => entry.type === type),
					(entry) => entry.value,
				),
				() => "0",
			),
		)
	return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000
}

/** "Today", "Yesterday", else "Mon 2 Nov". */
export const dayLabel = (atMs: number, clock: Clock): string => {
	const day = dayNumber(atMs, clock.timeZone)
	const today = dayNumber(clock.nowMs, clock.timeZone)
	if (day === today) return "Today"
	if (day === today - 1) return "Yesterday"
	return timeFormat(clock.timeZone, { weekday: "short", day: "numeric", month: "short" }).format(atMs)
}

// --- header -------------------------------------------------------------------------------------

/** The page title block: avatar, name, then the ids and when they were last active. */
export const userTitle = <M>(h: HtmlBuilder<M>, profile: UserProfile, clock: Clock): Html =>
	hstack(h, { gap: "3", align: "start" }, [
		userAvatar(h, profile, "lg"),
		vstack(h, { gap: "0.5", className: "min-w-0" }, [
			pageTitle(h, { title: userLabel(profile), className: "leading-8" }, [userLabel(profile)]),
			pageDescription(
				h,
				[
					hstack(h, { gap: "3", wrap: true, as: "span" }, [
						...(profile.email === null || profile.email === userLabel(profile)
							? []
							: [typography(h, { as: "span" }, [profile.email])]),
						typography(h, { mono: true, as: "span" }, [`user.id ${profile.userId}`]),
						...(profile.groupId === null
							? []
							: [typography(h, { mono: true, as: "span" }, [profile.groupId])]),
						hstack(h, { gap: "1.5", as: "span" }, [
							statusDot(h, { tone: "ok" }),
							listRelativeTime(h, {
								value: profile.lastSeenMs,
								nowMs: clock.nowMs,
								timeZone: clock.timeZone,
								className: "text-foreground-soft",
							}),
						]),
					]),
				],
				"text-sm",
			),
		]),
	])

// --- tabs ---------------------------------------------------------------------------------------

const TAB_LABEL = {
	activity: "Activity",
	sessions: "Sessions",
	errors: "Errors",
	traces: "Traces",
	logs: "Logs",
	events: "Events",
	mcp: "MCP",
} satisfies { readonly [K in UserTab]: string }

const TAB_ICON = {
	activity: "UnorderedListIcon",
	sessions: "MediaPlayIcon",
	errors: "CircleWarningIcon",
	traces: "LayersIcon",
	logs: "FileIcon",
	events: "CursorPointerIcon",
	mcp: "PlugIcon",
} satisfies { readonly [K in UserTab]: IconName }

export const tabCount = (tab: UserTab, detail: UserDetail): number | undefined => {
	const { profile } = detail
	switch (tab) {
		case "activity":
			return undefined
		case "sessions":
			return profile.sessions
		case "errors":
			return profile.issues ?? undefined
		case "traces":
			// The tab lists entry-point requests, so its badge counts them, not distinct traces.
			return profile.requests ?? undefined
		case "logs":
			return profile.logs ?? undefined
		case "events":
			return profile.events
		case "mcp":
			return detail.activityPending === true ? undefined : detail.mcpSessions.length
	}
}

/** Activity, Sessions, Errors, Traces, Logs and Events, each a route with its count. */
export const userTabs = <M>(h: HtmlBuilder<M>, detail: UserDetail, options: UserDetailOptions<M>): Html =>
	linkTabStrip(
		h,
		"User sections",
		Arr.map(USER_TABS, (tab): LinkTab<M> => {
			const count = tabCount(tab, detail)
			return {
				key: tab,
				href: options.hrefOf(tab),
				label: TAB_LABEL[tab],
				icon: TAB_ICON[tab],
				count: count === undefined ? undefined : formatNumber(count),
				countTone: tab === "errors" && count !== undefined && count > 0 ? "error" : "muted",
				onClick: options.onSelectTab(tab),
				isCurrent: tab === options.tab,
				isRouteActive: tab === options.tab,
			}
		}),
	)

// --- stats --------------------------------------------------------------------------------------

/** A request figure the org's warehouse cannot answer: a dash, never a fake zero. */
const UNKNOWN = EMPTY_VALUE

/** Error hits that named the user across their issues; replay errors where errors carry no user. */
const errorsStat = <M>(h: HtmlBuilder<M>, profile: UserProfile): Html => {
	const hits = profile.issueHits ?? profile.errors
	return statRailItem(h, {
		eyebrow: "Errors",
		value: formatNumber(hits),
		tone: hits > 0 ? "crit" : "neutral",
		subline:
			profile.issues === null
				? "in recorded sessions"
				: profile.issues === 0
					? `tracked since ${ERRORS_ATTRIBUTED_FROM}`
					: `across ${countLabel(profile.issues, "issue")}`,
		compact: true,
	})
}

const userStats = <M>(h: HtmlBuilder<M>, profile: UserProfile): Html =>
	statRail(h, { columns: 5, isFlush: true }, [
		statRailItem(h, {
			eyebrow: "Sessions",
			value: formatNumber(profile.sessions),
			subline:
				profile.sessions === 0
					? "no recorded sessions"
					: `${formatDuration(profile.recordedMs)} recorded`,
			compact: true,
		}),
		errorsStat(h, profile),
		statRailItem(h, {
			eyebrow: "Requests",
			value: profile.requests === null ? UNKNOWN : formatNumber(profile.requests),
			subline:
				profile.requests === null
					? "no per-user request data"
					: profile.requests === 0
						? "no requests in the window"
						: profile.failedRate === null
							? "failure rate not available"
							: `${formatPercent(profile.failedRate)} failed`,
			tone: profile.failedRate !== null && profile.failedRate > 0 ? "warn" : "neutral",
			spark: Arr.some(profile.activity, (count) => count > 0) ? profile.activity : undefined,
			compact: true,
		}),
		profile.p95Ms === null
			? statRailItem(h, {
					eyebrow: "MCP calls",
					value: formatNumber(profile.mcpCalls),
					subline: profile.mcpCalls === 0 ? "no MCP tool calls" : "tool calls on MCP servers",
					compact: true,
				})
			: statRailItem(h, {
					eyebrow: "P95 latency",
					value: formatLatency(profile.p95Ms),
					subline:
						profile.topRoute === null ? "over every request" : `top route ${profile.topRoute}`,
					compact: true,
				}),
		statRailItem(h, {
			eyebrow: "Events",
			value: formatNumber(profile.events),
			subline: `${formatNumber(profile.distinctEvents)} distinct`,
			compact: true,
		}),
	])

// --- rail ---------------------------------------------------------------------------------------

const railValue = <M>(h: HtmlBuilder<M>, value: string, mono = true): Html =>
	typography(h, { size: "xs", mono, tone: "soft", truncate: true, as: "span" }, [value])

/** The right rail: identity, traits, the services the user's requests touched, and their devices. */
export const userRail = <M>(
	h: HtmlBuilder<M>,
	profile: UserProfile,
	clock: Clock,
	scope: UserNamespaceScope<M>,
): Html =>
	h.aside(
		[h.AriaLabel("User details"), h.Class("flex flex-col")],
		[
			namespacesGroup(h, profile, scope),
			detailRailGroup(h, "Identity", [
				detailRailRow(h, { label: "user.id" }, [railValue(h, profile.userId)]),
				...(profile.email === null
					? []
					: [detailRailRow(h, { label: "Email" }, [railValue(h, profile.email, false)])]),
				...(profile.groupId === null
					? []
					: [detailRailRow(h, { label: "Group" }, [railValue(h, profile.groupId)])]),
				detailRailRow(h, { label: "First seen" }, [
					listRelativeTime(h, {
						value: profile.firstSeenMs,
						nowMs: clock.nowMs,
						timeZone: clock.timeZone,
						mono: true,
						className: "text-xs text-foreground-soft",
					}),
				]),
				detailRailRow(h, { label: "Visitor ids", hint: "linked before sign-in" }, [
					railValue(h, `${profile.visitorIds.length}`),
				]),
				...(profile.location === null
					? []
					: [detailRailRow(h, { label: "Location" }, [railValue(h, profile.location, false)])]),
			]),
			detailRailGroup(
				h,
				"Traits",
				Arr.isReadonlyArrayEmpty(profile.traits)
					? [typography(h, { size: "xs", tone: "subtle" }, ["No traits recorded for this user"])]
					: Arr.map(profile.traits, ([key, value]) =>
							detailRailRow(h, { label: key }, [railValue(h, value)]),
						),
			),
			detailRailGroup(
				h,
				"Services touched",
				Arr.isReadonlyArrayEmpty(profile.services)
					? [typography(h, { size: "xs", tone: "subtle" }, ["no service named in the window"])]
					: Arr.map(profile.services, (service) =>
							hstack(h, { gap: "2", className: "min-h-7 min-w-0" }, [
								serviceDot(h, { serviceName: service.service }),
								typography(
									h,
									{ size: "xs", mono: true, truncate: true, className: "min-w-0 flex-1" },
									[service.service],
								),
								typography(
									h,
									{
										size: "2xs",
										mono: true,
										tone: "subtle",
										as: "span",
										truncate: true,
										className: "min-w-0 max-w-24",
									},
									[service.namespace],
								),
								typography(
									h,
									{
										size: "2xs",
										mono: true,
										tone: "muted",
										numeric: true,
										className: "shrink-0",
									},
									[formatNumber(service.signals)],
								),
							]),
						),
			),
			detailRailGroup(
				h,
				"Devices",
				Arr.isReadonlyArrayEmpty(profile.devices)
					? [typography(h, { size: "xs", tone: "subtle" }, ["no recorded sessions"])]
					: Arr.map(profile.devices, (device) =>
							detailRailRow(h, { label: device.browser, hint: device.os }, [
								railValue(h, countLabel(device.sessions, "session"), false),
							]),
						),
			),
		],
	)

// --- namespaces ---------------------------------------------------------------------------------

/** The rail's Namespaces group: where this user's activity lives; a row scopes the page to it. */
const namespacesGroup = <M>(h: HtmlBuilder<M>, profile: UserProfile, scope: UserNamespaceScope<M>): Html => {
	const namespaces = namespacesOf(profile)
	const total = Arr.reduce(namespaces, 0, (sum, namespace) => sum + namespace.signals)
	if (namespaces.length === 0)
		return detailRailGroup(h, "Namespaces", [
			typography(h, { size: "xs", tone: "subtle" }, ["No namespace recorded in the window"]),
		])
	return detailRailGroup(
		h,
		"Namespaces",
		Arr.map(namespaces, (namespace) => {
			const isActive = namespace.name === scope.active
			const share = total === 0 ? 0 : namespace.signals / total
			const row = [
				icon(h, "LayersIcon", { size: 12, className: "shrink-0 text-foreground-subtle" }),
				typography(h, { size: "xs", mono: true, truncate: true, className: "flex-1 text-left" }, [
					namespace.name,
				]),
				typography(h, { size: "2xs", mono: true, tone: "muted", numeric: true, as: "span" }, [
					formatPercent(share),
				]),
			]
			return scope.isPinned
				? hstack(h, { gap: "2", className: "min-h-7 px-1.5" }, row)
				: pressable(
						h,
						{
							onClick: scope.onSelect(isActive ? null : namespace.name),
							isSelected: isActive,
							selectedLane: isActive,
							className: "flex min-h-7 w-full items-center gap-2 rounded-sm px-1.5",
						},
						row,
					)
		}),
	)
}

/** Above the tab: which namespace the page shows, what that hides, and the way back to all. */
const namespaceScopeBar = <M>(
	h: HtmlBuilder<M>,
	profile: UserProfile,
	scope: UserNamespaceScope<M>,
): Html | null => {
	const all = Arr.map(namespacesOf(profile), (namespace) => namespace.name)
	if (scope.active === null) {
		if (all.length < 2) return null
		return hstack(h, { gap: "2", wrap: true, className: "border-b border-border-subtle px-6 py-2.5" }, [
			icon(h, "LayersIcon", { size: 14, className: "text-foreground-subtle" }),
			typography(h, { size: "xs", tone: "muted", as: "span" }, [
				`Across ${all.length} namespaces: ${Arr.join(all, ", ")}`,
			]),
		])
	}
	const hidden = Arr.filter(all, (name) => name !== scope.active)
	return hstack(
		h,
		{ gap: "2", wrap: true, className: "border-b border-border-subtle bg-surface-faint px-6 py-2.5" },
		[
			icon(h, "LayersIcon", { size: 14, className: "text-foreground-subtle" }),
			typography(h, { size: "xs", as: "span" }, ["Namespace"]),
			typography(h, { size: "xs", mono: true, weight: "medium", as: "span" }, [scope.active]),
			...(scope.isPinned
				? [
						badge(
							h,
							{
								variant: "tag",
								attributes: [h.Title("Pinned for the whole app in the org menu")],
							},
							["Pinned"],
						),
					]
				: []),
			...(hidden.length === 0
				? []
				: [
						typography(h, { size: "xs", tone: "muted", as: "span" }, [
							`· ${hidden.length} more ${hidden.length === 1 ? "namespace" : "namespaces"} hidden (${Arr.join(hidden, ", ")})`,
						]),
					]),
			button(
				h,
				{
					variant: "link",
					size: "xs",
					className: "ml-auto h-auto p-0",
					attributes: [h.OnClick(scope.isPinned ? scope.onClearPin : scope.onSelect(null))],
				},
				[scope.isPinned ? "Clear pin" : "Show all namespaces"],
			),
		],
	)
}

// --- activity -----------------------------------------------------------------------------------

const KIND_ICON = {
	error: "CircleWarningIcon",
	request: "LayersIcon",
	event: "CursorPointerIcon",
	session: "MediaPlayIcon",
	log: "FileIcon",
	mcp: "PlugIcon",
} satisfies { readonly [K in ActivityKind]: IconName }

const KIND_ACTION = {
	error: "Issue",
	request: "Trace",
	event: "Event",
	session: "Watch replay",
	log: "Trace",
	mcp: "Open session",
} satisfies { readonly [K in ActivityKind]: string }

const ACTIVITY_ROW_CLASS = "grid grid-cols-[3rem_1rem_minmax(0,1fr)_auto] items-start gap-3 px-2.5 py-2"

/** One timeline row; a row with a page (a replay, an MCP session, a trace) is a link to it. */
const activityRow = <M>(h: HtmlBuilder<M>, item: ActivityItem, timeZone: string): Html =>
	selectableRow(
		h,
		{
			isSelected: false,
			href: item.href ?? undefined,
			className:
				item.href === null
					? ACTIVITY_ROW_CLASS
					: `${ACTIVITY_ROW_CLASS} hover:bg-surface-faint active:bg-surface-faint`,
		},
		[
			typography(h, { size: "xs", mono: true, numeric: true, tone: "muted", className: "pt-px" }, [
				clockOf(item.atMs, timeZone),
			]),
			icon(h, KIND_ICON[item.kind], {
				size: 14,
				className:
					item.tone === "crit"
						? "mt-0.5 text-severity-error"
						: item.tone === "warn"
							? "mt-0.5 text-severity-warn"
							: "mt-0.5 text-muted-foreground",
			}),
			vstack(h, { gap: "0.5", className: "min-w-0" }, [
				typography(
					h,
					{ size: "xs", tone: item.tone === "crit" ? "error" : "foreground", truncate: true },
					[item.title],
				),
				typography(h, { size: "2xs", tone: "muted", mono: true, truncate: true }, [item.detail]),
			]),
			item.href === null
				? h.span([h.AriaHidden(true)], [])
				: typography(h, { size: "xs", tone: "primary", className: "pt-px" }, [
						KIND_ACTION[item.kind],
					]),
		],
	)

/** One timeline across every signal, newest first, grouped by day. */
const activityBody = <M>(h: HtmlBuilder<M>, items: ReadonlyArray<ActivityItem>, clock: Clock): Html => {
	if (Arr.isReadonlyArrayEmpty(items)) return noRows(h, "No activity from this user in the window.")
	const sorted = Arr.sort(
		items,
		Order.flip(Order.mapInput(Order.Number, (item: ActivityItem) => item.atMs)),
	)
	const days = Arr.groupBy(sorted, (item) => dayKey(item.atMs, clock.timeZone))
	const order = Arr.dedupe(Arr.map(sorted, (item) => dayKey(item.atMs, clock.timeZone)))
	return vstack(
		h,
		{ gap: "4" },
		Arr.map(order, (key) => {
			const dayItems = days[key] ?? []
			const first = dayItems[0]
			return h.section(
				[h.Class("flex flex-col")],
				[
					eyebrow(h, { variant: "mono", className: "px-2.5 pb-1" }, [
						first === undefined ? key : dayLabel(first.atMs, clock),
					]),
					h.div(
						[
							h.Class(
								"flex flex-col divide-y divide-border-subtle rounded-md border border-border",
							),
						],
						Arr.map(dayItems, (item) => activityRow(h, item, clock.timeZone)),
					),
				],
			)
		}),
	)
}

// --- tables -------------------------------------------------------------------------------------

/** A tab with no rows in the window. */
const noRows = <M>(h: HtmlBuilder<M>, text: string): Html => emptyMessage(h, { dashed: true }, [text])

/** A tab the org's warehouse cannot answer: said plainly, never demo rows. */
const unavailableTab = <M>(h: HtmlBuilder<M>, iconName: IconName, title: string, description: string): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, iconName)]),
			emptyTitle(h, [title]),
			emptyDescription(h, [description]),
		]),
	])

/** Errors carry the user that hit them only from the release that added it; earlier ones never do. */
const ATTRIBUTION_NOTE = `Errors are linked to users from ${ERRORS_ATTRIBUTED_FROM} on. Earlier errors have no user.`

/** Where this warehouse has no per-user rollup (it has not applied migration 0056): no count to show. */
const UNINDEXED_DESCRIPTION =
	"This warehouse does not index requests and logs per user yet. Apply the latest ClickHouse migration to see them here."

/** A rollup-backed tab: no count means the warehouse cannot answer, which is not "no rows". */
export const indexedTabState = (
	count: number | null,
	rows: ReadonlyArray<unknown>,
): "unindexed" | "empty" | "rows" => (count === null ? "unindexed" : rows.length === 0 ? "empty" : "rows")

const cellText = <M>(
	h: HtmlBuilder<M>,
	value: string,
	className: string,
	options: Readonly<{
		tone?: "foreground" | "soft" | "muted" | "error" | "warning"
		mono?: boolean
		right?: boolean
	}> = {},
): Html =>
	typography(
		h,
		{
			size: "xs",
			mono: options.mono ?? true,
			numeric: true,
			truncate: true,
			tone: options.tone ?? "foreground",
			as: "span",
			className: `${className}${options.right === true ? " text-right" : ""}`,
		},
		[value],
	)

const timeCell = <M>(h: HtmlBuilder<M>, atMs: number, clock: Clock, className = "w-28 shrink-0"): Html =>
	h.span(
		[h.Class(className)],
		[
			listRelativeTime(h, {
				value: atMs,
				nowMs: clock.nowMs,
				timeZone: clock.timeZone,
				mono: true,
				className: "text-xs text-muted-foreground",
			}),
		],
	)

const sessionsBody = <M>(h: HtmlBuilder<M>, detail: UserDetail, clock: Clock): Html =>
	Arr.isReadonlyArrayEmpty(detail.sessions)
		? noRows(h, "No recorded sessions from this user in the window.")
		: toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Started", width: "w-28 shrink-0" }),
					th(h, { label: "Duration", width: "w-20 shrink-0", align: "right" }),
					th(h, { label: "Pages", width: "w-14 shrink-0", align: "right" }),
					th(h, { label: "Errors", width: "w-14 shrink-0", align: "right" }),
					th(h, { label: "Entry → exit", width: `${columnClass({ min: "0" })} pl-4` }),
					th(h, { label: "Device", width: "w-36 shrink-0" }),
					h.span([h.AriaHidden(true), h.Class("w-24 shrink-0")], []),
				]),
				toolTableBody(
					h,
					Arr.map(detail.sessions, (session) =>
						toolTableRow(h, { href: `/replays/${encodeURIComponent(session.sessionId)}` }, [
							timeCell(h, session.startedMs, clock),
							cellText(h, formatDuration(session.durationMs), "w-20 shrink-0", { right: true }),
							cellText(h, String(session.pages), "w-14 shrink-0", { right: true }),
							cellText(h, String(session.errors), "w-14 shrink-0", {
								right: true,
								tone: session.errors > 0 ? "error" : "muted",
							}),
							cellText(
								h,
								session.exit === null ? session.entry : `${session.entry} → ${session.exit}`,
								"w-0 flex-1 pl-4",
								{ tone: "soft" },
							),
							cellText(h, session.device, "w-36 shrink-0", { tone: "muted", mono: false }),
							hstack(
								h,
								{ gap: "1.5", justify: "end", as: "span", className: "w-24 shrink-0" },
								[
									icon(h, "MediaPlayIcon", { size: 12, className: "text-primary" }),
									typography(h, { size: "xs", tone: "primary", as: "span" }, ["Watch"]),
								],
							),
						]),
					),
				),
			])

/** The issue's workflow state as the errors hub draws it; a fingerprint not yet an issue says so. */
const issueStatus = <M>(h: HtmlBuilder<M>, status: UserDetail["issues"][number]["status"]): Html =>
	status === null
		? typography(h, { size: "xs", tone: "muted", as: "span" }, ["Not an issue yet"])
		: hstack(h, { gap: "1.5", as: "span" }, [
				// The label beside it says the state; the ring's own aria-label would say it twice.
				h.span([h.AriaHidden(true), h.Class("inline-flex")], [workflowRingIcon(h, status, 12)]),
				typography(h, { size: "xs", tone: "soft", truncate: true, as: "span" }, [
					WORKFLOW_LABEL[status],
				]),
			])

/** The issues the user hit, most hits first; each opens its issue page. */
const errorsBody = <M>(h: HtmlBuilder<M>, detail: UserDetail, clock: Clock): Html => {
	if (detail.profile.issues === null)
		return unavailableTab(
			h,
			"CircleWarningIcon",
			"Errors are not linked to users here",
			"This warehouse's schema predates per-user errors. Apply the latest schema, and new errors name the user that hit them.",
		)
	if (Arr.isReadonlyArrayEmpty(detail.issues))
		return noRows(h, `This user hit no errors in the window. ${ATTRIBUTION_NOTE}`)
	return vstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted" }, [ATTRIBUTION_NOTE]),
		toolTable(h, [
			toolTableHead(h, [
				th(h, { label: "Issue", width: columnClass({ min: "0" }) }),
				th(h, { label: "Service", width: "w-28 shrink-0" }),
				th(h, { label: "This user", width: "w-20 shrink-0", align: "right" }),
				th(h, { label: "Last seen", width: "w-28 shrink-0 pl-4" }),
				th(h, { label: "Status", width: "w-32 shrink-0" }),
			]),
			toolTableBody(
				h,
				Arr.map(detail.issues, (issue) =>
					toolTableRow(
						h,
						issue.href === null ? { className: "h-12" } : { href: issue.href, className: "h-12" },
						[
							vstack(h, { gap: "0", className: "w-0 min-w-0 flex-1" }, [
								typography(h, { size: "xs", mono: true, tone: "error", truncate: true }, [
									issue.type,
								]),
								typography(h, { size: "2xs", tone: "muted", truncate: true }, [
									issue.message,
								]),
							]),
							hstack(h, { gap: "1.5", as: "span", className: "w-28 shrink-0" }, [
								serviceDot(h, { serviceName: issue.service }),
								typography(h, { size: "xs", mono: true, truncate: true, as: "span" }, [
									issue.service,
								]),
							]),
							cellText(h, formatNumber(issue.hits), "w-20 shrink-0", { right: true }),
							timeCell(h, issue.lastSeenMs, clock, "w-28 shrink-0 pl-4"),
							h.span([h.Class("w-32 shrink-0")], [issueStatus(h, issue.status)]),
						],
					),
				),
			),
		]),
	])
}

/** A request this slow reads as a warning. */
const SLOW_MS = 2000

/** The user's requests, one row per entry span; each opens its trace. */
const tracesBody = <M>(h: HtmlBuilder<M>, detail: UserDetail, clock: Clock): Html =>
	indexedTabState(detail.profile.requests, detail.traces) === "unindexed"
		? unavailableTab(h, "LayersIcon", "Requests are not indexed per user here", UNINDEXED_DESCRIPTION)
		: Arr.isReadonlyArrayEmpty(detail.traces)
			? noRows(h, "No requests from this user in the window.")
			: toolTable(h, [
					toolTableHead(h, [
						th(h, { label: "Time", width: "w-28 shrink-0" }),
						th(h, { label: "Root span", width: columnClass({ min: "0" }) }),
						th(h, { label: "Service", width: "w-28 shrink-0" }),
						th(h, { label: "Duration", width: "w-20 shrink-0", align: "right" }),
						th(h, { label: "Status", width: "w-16 shrink-0", align: "right" }),
					]),
					toolTableBody(
						h,
						Arr.map(detail.traces, (trace) =>
							toolTableRow(h, { href: trace.href }, [
								timeCell(h, trace.atMs, clock),
								cellText(h, trace.rootSpan, "w-0 flex-1"),
								hstack(h, { gap: "1.5", as: "span", className: "w-28 shrink-0" }, [
									serviceDot(h, { serviceName: trace.service }),
									typography(h, { size: "xs", mono: true, truncate: true, as: "span" }, [
										trace.service,
									]),
								]),
								cellText(h, formatLatency(trace.durationMs), "w-20 shrink-0", {
									right: true,
									tone: trace.durationMs >= SLOW_MS ? "warning" : "foreground",
								}),
								cellText(h, trace.status, "w-16 shrink-0", {
									right: true,
									tone: trace.isError ? "error" : "muted",
								}),
							]),
						),
					),
				])

/** The user's log lines; one inside a trace opens it. */
const logsBody = <M>(h: HtmlBuilder<M>, detail: UserDetail, clock: Clock): Html =>
	indexedTabState(detail.profile.logs, detail.logs) === "unindexed"
		? unavailableTab(h, "FileIcon", "Logs are not indexed per user here", UNINDEXED_DESCRIPTION)
		: Arr.isReadonlyArrayEmpty(detail.logs)
			? noRows(h, "No logs from this user in the window.")
			: toolTable(h, [
					toolTableHead(h, [
						th(h, { label: "Time", width: "w-28 shrink-0" }),
						th(h, { label: "Level", width: "w-16 shrink-0" }),
						th(h, { label: "Service", width: "w-28 shrink-0" }),
						th(h, { label: "Message", width: columnClass({ min: "0" }) }),
					]),
					toolTableBody(
						h,
						Arr.map(detail.logs, (log) =>
							toolTableRow(h, log.href === null ? {} : { href: log.href }, [
								timeCell(h, log.atMs, clock),
								h.span(
									[h.Class("w-16 shrink-0")],
									[severityBadge(h, { severity: log.severity })],
								),
								hstack(h, { gap: "1.5", as: "span", className: "w-28 shrink-0" }, [
									serviceDot(h, { serviceName: log.service }),
									typography(h, { size: "xs", mono: true, truncate: true, as: "span" }, [
										log.service,
									]),
								]),
								cellText(h, log.body, "w-0 flex-1"),
							]),
						),
					),
				])

const eventsBody = <M>(h: HtmlBuilder<M>, detail: UserDetail, clock: Clock): Html =>
	Arr.isReadonlyArrayEmpty(detail.events)
		? noRows(h, "No product events from this user in the window.")
		: toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Time", width: "w-28 shrink-0" }),
					th(h, { label: "Event", width: "w-44 shrink-0" }),
					th(h, { label: "Source", width: "w-20 shrink-0" }),
					th(h, { label: "Page / properties", width: columnClass({ min: "0" }) }),
				]),
				toolTableBody(
					h,
					Arr.map(detail.events, (event) =>
						toolTableRow(h, {}, [
							timeCell(h, event.atMs, clock),
							cellText(h, event.name, "w-44 shrink-0"),
							h.span(
								[h.Class("w-20 shrink-0")],
								[badge(h, { variant: "tag" }, [event.source])],
							),
							cellText(h, event.detail, "w-0 flex-1", { tone: "muted" }),
						]),
					),
				),
			])

/** The user's MCP sessions on every MCP server; each row opens that server's session page. */
const mcpBody = <M>(h: HtmlBuilder<M>, detail: UserDetail, clock: Clock): Html =>
	Arr.isReadonlyArrayEmpty(detail.mcpSessions)
		? noRows(h, "No MCP sessions from this user in the window.")
		: toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Started", width: "w-28 shrink-0" }),
					th(h, { label: "Server", width: columnClass({ min: "0" }) }),
					th(h, { label: "Client", width: "w-44 shrink-0" }),
					th(h, { label: "Calls", width: "w-14 shrink-0", align: "right" }),
					th(h, { label: "Failed", width: "w-14 shrink-0", align: "right" }),
					th(h, { label: "Tools", width: "w-14 shrink-0", align: "right" }),
					th(h, { label: "Duration", width: "w-20 shrink-0", align: "right" }),
				]),
				toolTableBody(
					h,
					Arr.map(detail.mcpSessions, (session) =>
						toolTableRow(
							h,
							{
								href: session.href,
								attributes: [h.Key(`${session.service}/${session.sessionId}`)],
							},
							[
								timeCell(h, session.firstSeenMs, clock),
								hstack(h, { gap: "1.5", as: "span", className: "w-0 min-w-0 flex-1" }, [
									serviceDot(h, { serviceName: session.service }),
									typography(h, { size: "xs", mono: true, truncate: true, as: "span" }, [
										session.service,
									]),
								]),
								hstack(h, { gap: "2", as: "span", className: "w-44 shrink-0" }, [
									clientIcon(h, session.client, 12),
									typography(h, { size: "xs", mono: true, truncate: true, as: "span" }, [
										session.client,
									]),
									...kindTag(h, session.kind),
								]),
								cellText(h, formatNumber(session.calls), "w-14 shrink-0", { right: true }),
								cellText(h, formatNumber(session.errors), "w-14 shrink-0", {
									right: true,
									tone: session.errors > 0 ? "error" : "muted",
								}),
								cellText(h, formatNumber(session.tools), "w-14 shrink-0", {
									right: true,
									tone: "muted",
								}),
								cellText(
									h,
									formatLatency(session.lastSeenMs - session.firstSeenMs),
									"w-20 shrink-0",
									{
										right: true,
										tone: "muted",
									},
								),
							],
						),
					),
				),
			])

const tabBody = <M>(h: HtmlBuilder<M>, detail: UserDetail, tab: UserTab, clock: Clock): Html => {
	switch (tab) {
		case "activity":
			return activityBody(h, detail.activity, clock)
		case "sessions":
			return sessionsBody(h, detail, clock)
		case "errors":
			return errorsBody(h, detail, clock)
		case "traces":
			return tracesBody(h, detail, clock)
		case "logs":
			return logsBody(h, detail, clock)
		case "events":
			return eventsBody(h, detail, clock)
		case "mcp":
			return mcpBody(h, detail, clock)
	}
}

/** The page body below the tabs: the stats strip, then the picked tab. */
export const userDetailBody = <M>(
	h: HtmlBuilder<M>,
	detail: UserDetail,
	options: UserDetailOptions<M>,
): Html => {
	const clock = { nowMs: options.nowMs, timeZone: options.timeZone }
	return h.div(
		[h.Class("@container/panel flex min-w-0 flex-col")],
		[
			userStats(h, detail.profile),
			namespaceScopeBar(h, detail.profile, options.namespace),
			h.div(
				[h.Class("min-w-0 px-6 py-5")],
				[options.tabContent ?? tabBody(h, detail, options.tab, clock)],
			),
		],
	)
}
