import type { AlertIncidentDocument } from "@maple/domain/http"
import { pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { formatAlertDuration } from "@maple/web-data/alerts/form-utils"
import { incidentSubline, incidentTitle } from "@maple/web-data/alerts/overview-derive"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { presenceOf } from "@maple/views/data/signal-presence"
import { errorState } from "@maple/views/ui/error-state"
import { grid } from "@maple/views/ui/grid"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { pageDescription, pageTitle } from "@maple/views/ui/page-layout"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { refreshButton } from "@maple/views/ui/refresh-button"
import { strip } from "@maple/views/ui/rule"
import { skeleton, skeletonLine, skeletonList } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import { severityBadge } from "../../alerts/shared/badges"
import { sloHref, slosTabHref } from "../../alerts/shared/slo-commands"
import { scopeLine } from "../../alerts/shared/slo-derive"
import { budgetBar } from "../../alerts/shared/slo-view"
import type { PageViewInputs } from "../../contract"
import { alertsHref, incidentHref } from "../../kit/alert-links"
import { msIso } from "../../kit/alert-time"
import { dashboardPage } from "../../kit/dashboard-page"
import { severityIcon } from "../../kit/issue-severity"
import { monitorHref, uptimeTabHref } from "../../kit/uptime/commands"
import { targetLine, type UptimeMonitor } from "../../kit/uptime/derive"
import { uptimeStatusChip, uptimeStatusSquare } from "../../kit/uptime/view"
import { MountObserverHome } from "./command"
import {
	incidentsOf,
	SECTION_ROWS,
	type SloTrouble,
	slosOf,
	uptimeOf,
	type Verdict,
	verdictOf,
} from "./derive"
import { Message, type RetryTarget } from "./message"
import type { Model, TopError } from "./model"

type H = HtmlBuilder<Message>

/** What an observer cannot do themselves, said once per empty section. */
const ASK_AN_ENGINEER = "An engineer on your team can set them up."

const SKELETON_WIDTHS = ["48", "40", "44"] as const

/** The status line: the verdict as the page's `<h1>`, then the counts that back it. */
const statusLine = (h: H, verdict: Verdict): Html =>
	verdict._tag === "Loading"
		? vstack(h, { gap: "2.5", attributes: [h.AriaBusy(true), h.AriaLabel("Checking the status")] }, [
				skeleton(h, "h-7 w-64 max-w-full"),
				skeleton(h, "h-3.5 w-96 max-w-full"),
			])
		: vstack(h, { gap: "1" }, [
				hstack(h, { gap: "2.5", align: "start" }, [
					statusDot(h, { tone: verdict.tone, size: "lg", className: "mt-3" }),
					pageTitle(h, { wrap: true }, [verdict.sentence]),
				]),
				...(verdict.support.length === 0
					? []
					: [pageDescription(h, [Arr.join(verdict.support, " · ")], "pl-4.5 text-sm")]),
			])

type SectionOptions = Readonly<{
	title: string
	/** The header's right side: the count that sums the section up. */
	summary?: string
	footer: Readonly<{ label: string; href: string }>
}>

/** One panel per question: a quiet title and count, its rows or one line, then the way to the full page. */
const section = (h: H, options: SectionOptions, body: ReadonlyArray<Html>): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: options.title,
			action:
				options.summary === undefined
					? null
					: typography(h, { size: "2xs", tone: "muted", numeric: true }, [options.summary]),
		}),
		// Grows, so two panels side by side keep their footers on one line.
		vstack(h, { grow: true }, body),
		strip(h, { kind: "foot" }, [
			typography(h, { size: "xs", as: "div" }, [
				textLink(h, { href: options.footer.href, tone: "muted" }, [
					options.footer.label,
					icon(h, "ArrowRightIcon", { size: 12 }),
				]),
			]),
		]),
	])

/** A section's single line: nothing to list, or nothing set up. */
const note = (h: H, text: string): Html =>
	strip(h, { kind: "row" }, [typography(h, { size: "sm", tone: "muted", as: "p" }, [text])])

const loadingRows = (h: H, label: string): Html =>
	skeletonList(h, {
		rows: 3,
		gap: "0",
		label,
		renderRow: (index) =>
			strip(h, { kind: "row", attributes: [h.Key(String(index))] }, [
				vstack(h, { gap: "2", className: "py-1" }, [
					skeletonLine(h, { width: SKELETON_WIDTHS[index % 3] ?? "44" }),
					skeletonLine(h, { width: "28" }),
				]),
			]),
	})

/** A read that failed says so in its own section, with a way to ask again when there is one. */
const failed = (h: H, title: string, failure: LoadFailure, target: RetryTarget): Html =>
	errorState(h, {
		failure,
		title,
		variant: "inline",
		onRetry: Message.ClickedRetry({ target }),
		className: "px-4",
	})

const rowsOr = <A>(
	rows: ReadonlyArray<A>,
	toRow: (row: A) => Html,
	whenEmpty: () => Html,
): ReadonlyArray<Html> => (rows.length === 0 ? [whenEmpty()] : Arr.map(Arr.take(rows, SECTION_ROWS), toRow))

/** "5 of 8 shown" once a section lists fewer rows than it has. */
const shownOf = (count: number): string | undefined =>
	count > SECTION_ROWS ? `${SECTION_ROWS} of ${count} shown` : undefined

const trailingText = (h: H, text: string, className?: string): Html =>
	typography(
		h,
		{ size: "xs", tone: "muted", numeric: true, className: cn("whitespace-nowrap", className) },
		[text],
	)

const incidentRow = (h: H, incident: AlertIncidentDocument, nowMs: number): Html => {
	const openFor = `Open ${formatAlertDuration(incident.firstTriggeredAt, msIso(nowMs))}`
	return listRow(h, {
		href: incidentHref(incident.id),
		divided: true,
		leading: severityBadge(h, incident.severity, "w-18 justify-center"),
		title:
			incident.holdReason === null ? incidentTitle(incident) : `${incident.ruleName}: waiting on data`,
		// A narrow page has no room for the trailing lane: the duration leads the second line instead.
		meta: h.span(
			[],
			[h.span([h.Class("@md/page:hidden")], [`${openFor} · `]), incidentSubline(incident)],
		),
		trailing: trailingText(h, openFor, "hidden @md/page:inline"),
	})
}

const incidentsSection = (h: H, model: Model, nowMs: number | null): Html => {
	const part = incidentsOf(model)
	const body = (): ReadonlyArray<Html> => {
		if (part._tag === "Failed") return [note(h, "Couldn't check incidents")]
		if (part._tag === "Loading" || nowMs === null) return [loadingRows(h, "Loading incidents")]
		const { open, isSetUp } = part.value
		return rowsOr(
			open,
			(incident) => incidentRow(h, incident, nowMs),
			() => note(h, isSetUp ? "No open incidents" : `No alert rules yet. ${ASK_AN_ENGINEER}`),
		)
	}
	return section(
		h,
		{
			title: "Open incidents",
			summary: part._tag === "Ready" ? shownOf(part.value.open.length) : undefined,
			footer: { label: "All incidents", href: alertsHref({}) },
		},
		body(),
	)
}

const monitorRow = (h: H, monitor: UptimeMonitor, nowMs: number): Html =>
	listRow(h, {
		href: monitorHref(monitor.id),
		divided: true,
		leading: uptimeStatusSquare(h, monitor),
		title: monitor.name,
		meta: targetLine(monitor, nowMs),
		trailing: uptimeStatusChip(h, monitor, nowMs),
	})

const allPassing = (total: number): string =>
	total === 0
		? "No uptime checks are running"
		: total === 1
			? "The 1 check is passing"
			: `All ${total} checks are passing`

const uptimeSection = (h: H, model: Model, nowMs: number | null): Html => {
	const part = uptimeOf(model)
	const body = (): ReadonlyArray<Html> => {
		if (part._tag === "Failed")
			return Option.match(AsyncData.getError(model.monitors.data), {
				onNone: () => [note(h, "Couldn't check uptime")],
				onSome: (failure) => [failed(h, "Couldn't load uptime checks", failure, "Monitors")],
			})
		if (part._tag === "Loading" || nowMs === null) return [loadingRows(h, "Loading uptime checks")]
		const { failing, total, isSetUp } = part.value
		return rowsOr(
			failing,
			(monitor) => monitorRow(h, monitor, nowMs),
			() => note(h, isSetUp ? allPassing(total) : `No uptime checks yet. ${ASK_AN_ENGINEER}`),
		)
	}
	return section(
		h,
		{
			title: "Uptime",
			// With nothing failing the body's one line already gives the count.
			summary:
				part._tag === "Ready" && part.value.failing.length > 0
					? `${part.value.passing} of ${part.value.total} passing`
					: undefined,
			footer: { label: "All uptime checks", href: uptimeTabHref() },
		},
		body(),
	)
}

const SLO_STATE = {
	burning: "Burning",
	spent: "Out of budget",
} as const satisfies Record<SloTrouble["state"], string>

const sloRow = (h: H, { slo, state, budgetRemaining }: SloTrouble): Html =>
	listRow(h, {
		href: sloHref(slo.id),
		divided: true,
		leading: statusDot(h, { tone: "crit", size: "lg" }),
		title: slo.name,
		meta: `${SLO_STATE[state]} · ${scopeLine(slo)}`,
		trailing: budgetBar(h, budgetRemaining),
	})

const slosSection = (h: H, model: Model): Html => {
	const part = slosOf(model)
	const body = (): ReadonlyArray<Html> => {
		if (part._tag === "Failed")
			return Option.match(AsyncData.getError(model.slos.data), {
				// The list loaded but none of its figures did: nothing here can say how an SLO is doing.
				onNone: () => [note(h, "Couldn't check the SLOs' current figures. Reload to try again.")],
				onSome: (failure) => [failed(h, "Couldn't load SLOs", failure, "Slos")],
			})
		if (part._tag === "Loading") return [loadingRows(h, "Loading SLOs")]
		const { troubled, total, isSetUp } = part.value
		return rowsOr(
			troubled,
			(trouble) => sloRow(h, trouble),
			() =>
				note(
					h,
					!isSetUp
						? `No SLOs yet. ${ASK_AN_ENGINEER}`
						: total === 1
							? "The 1 SLO is within budget"
							: `All ${total} SLOs are within budget`,
				),
		)
	}
	return section(
		h,
		{
			title: "SLOs",
			summary:
				part._tag === "Ready" && part.value.troubled.length > 0
					? `${part.value.within} of ${part.value.total} within budget`
					: undefined,
			footer: { label: "All SLOs", href: slosTabHref() },
		},
		body(),
	)
}

const errorRow = (h: H, error: TopError, nowMs: number): Html =>
	listRow(h, {
		href: hrefOf(AppRoute.ErrorIssue({ issueId: error.id, search: {} })),
		divided: true,
		leading: severityIcon(h, error.severity, 16),
		title: error.title,
		meta: `${error.serviceName} · last seen ${formatRelativeTime(error.lastSeenAt, nowMs)}`,
		// The noun gives way on a narrow page, so the title keeps its room; a screen reader still gets it.
		trailing: typography(
			h,
			{ size: "xs", tone: "muted", numeric: true, className: "whitespace-nowrap" },
			[
				error.count.toLocaleString(),
				h.span([h.Class("sr-only @md/page:not-sr-only")], [` ${pluralize(error.count, "event")}`]),
			],
		),
	})

/** An empty list only means a clean window when the app is known to be sending data. */
const errorsNote = (presence: ReturnType<typeof presenceOf>["status"]): string => {
	if (presence === "present") return "No open errors in the last 24 hours"
	return presence === "absent"
		? "No error data yet. An engineer on your team can connect your app."
		: "No open errors found"
}

const errorsSection = (h: H, model: Model, nowMs: number | null): Html => {
	const data = model.errors.data
	const body = (): ReadonlyArray<Html> => {
		if (AsyncData.isFailure(data)) return [failed(h, "Couldn't load errors", data.error, "Errors")]
		return Option.match(nowMs === null ? Option.none() : AsyncData.getData(data), {
			onNone: () => [loadingRows(h, "Loading errors")],
			onSome: (errors) =>
				rowsOr(
					errors,
					(error) => errorRow(h, error, nowMs ?? 0),
					() => note(h, errorsNote(presenceOf(model.presence, "traces").status)),
				),
		})
	}
	return section(
		h,
		{
			title: "Top errors",
			summary: "Last 24 hours",
			footer: { label: "All errors", href: hrefOf(AppRoute.Errors({ search: {} })) },
		},
		body(),
	)
}

/** The quiet last row: where the weekly digests are turned on. */
const weeklySummary = (h: H): Html =>
	typography(h, { size: "xs", tone: "muted", as: "div", className: "px-4" }, [
		textLink(
			h,
			{ href: hrefOf(AppRoute.Account({ search: { tab: "email-preferences" } })), tone: "muted" },
			[icon(h, "EnvelopeIcon", { size: 14 }), "Get a weekly summary by email"],
		),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(MountObserverHome())],
		[
			dashboardPage(
				h,
				{
					titleContent: statusLine(h, verdictOf(model)),
					actions: refreshButton(h, {
						onRefresh: Message.ClickedReload(),
						isPending: model.isReloading,
						isIconOnly: true,
						label: "Reload",
					}),
					width: "settings",
					gap: "md",
				},
				[
					incidentsSection(h, model, model.nowMs),
					grid(h, { lg: 2, gap: "4" }, [
						uptimeSection(h, model, model.nowMs),
						slosSection(h, model),
					]),
					errorsSection(h, model, model.nowMs),
					weeklySummary(h),
				],
			),
		],
	),
)
