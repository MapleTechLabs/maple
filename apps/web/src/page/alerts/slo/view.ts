import type { AlertSeverity } from "@maple/domain/http"
import { SLO_MIN_TIER_BAD_EVENTS, SLO_MIN_TIER_EVENTS, windowLabel } from "@maple/domain/slo"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailActions, detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { resourceNotFound } from "../../kit/resource-not-found"
import { severityBadge } from "../shared/badges"
import { incidentHref } from "../../kit/alert-links"
import { editSloHref, SLO_NOT_FOUND_CODE, slosTabHref } from "../shared/slo-commands"
import {
	budgetNotice,
	burnOf,
	factorOf,
	firingTier,
	formatBurn,
	formatFactor,
	formatTarget,
	formatWindow,
	hasNoData,
	holdReason,
	holdingLine,
	holdingTier,
	isSpent,
	openBudgetIncident,
	openBurnIncident,
	scopeLine,
	sliDescription,
	sliLabel,
	type Slo,
	type SloStatus,
} from "../shared/slo-derive"
import { Message } from "./message"
import { type Model } from "./model"
import { sloOf } from "./update"
import {
	alertingPanel,
	budgetPanel,
	burnPanel,
	CHART_TOKENS,
	type ChartContext,
	figures,
	incidentsPanel,
	sliPanel,
} from "./view-panels"
import { textLink } from "@maple/views/ui/text-link"
import { gatedControl } from "../../kit/session-grants"

type H = HtmlBuilder<Message>

const headerActions = (h: H, model: Model, slo: Slo): Html =>
	detailActions(h, [
		gatedControl(h, model, "alerts:manage", (isDisabled) => {
			const children = [icon(h, "PencilIcon"), "Edit"]
			return isDisabled
				? button(h, { size: "sm", variant: "outline", isDisabled }, children)
				: linkButton(h, { size: "sm", variant: "outline", href: editSloHref(slo.id) }, children)
		}),
		gatedControl(h, model, "alerts:manage", (isDisabled) =>
			button(
				h,
				{
					size: "sm",
					variant: "destructive-outline",
					isDisabled,
					attributes: [h.OnClick(Message.ClickedDelete())],
				},
				[icon(h, "TrashIcon"), "Delete"],
			),
		),
	])

const statusOf = (model: Model): Option.Option<SloStatus> => AsyncData.getData(model.status.data)

const incidentAction = (
	h: H,
	incident: Option.Option<AlertIncidentRow>,
	label: string,
): ReadonlyArray<Html> =>
	Option.match(incident, {
		onNone: () => [],
		onSome: (row) => [
			alertAction(h, [
				linkButton(h, { size: "sm", variant: "outline", href: incidentHref(row.id) }, [label]),
			]),
		],
	})

/** A firing tier leads the page: what burns, at which rates, and the incident it opened. */
const burnCallout = (h: H, model: Model, slo: Slo, status: SloStatus): Option.Option<Html> => {
	const incident = openBurnIncident(slo, model.incidents ?? [])
	const action = incidentAction(h, incident, "Open incident")
	const firing = Option.map(firingTier(slo, status), (tier) =>
		alert(h, { variant: tier.severity === "critical" ? "crit" : "warn" }, [
			icon(h, "FireIcon"),
			alertTitle(h, [
				`Burning the error budget at ${formatBurn(burnOf(status, tier.longWindowMinutes))} over ${windowLabel(tier.longWindowMinutes)}`,
			]),
			alertDescription(h, [
				`At this rate the ${slo.window_days}-day budget runs out early. The ${tier.severity} tier fires at ${formatFactor(factorOf(slo, tier))} over both ${windowLabel(tier.longWindowMinutes)} and ${windowLabel(tier.shortWindowMinutes)}.`,
			]),
			...action,
		]),
	)
	// An outage empties the short window: the tier holds, so the open incident leads the page.
	const holding = Option.flatMap(holdingTier(slo, status), (tier) =>
		Option.map(incident, (row) => {
			const reason = holdReason(status, tier)
			return alert(h, { variant: row.severity === "critical" ? "crit" : "warn" }, [
				icon(h, "FireIcon"),
				alertTitle(h, [holdingLine(tier, reason)]),
				alertDescription(h, [
					reason === "no-events"
						? `The ${tier.severity} tier cannot judge the burn without events, so it neither fires nor resolves. Check whether ${slo.service_name} is down or has stopped reporting.`
						: `The ${tier.severity} tier needs ${SLO_MIN_TIER_EVENTS} events and ${SLO_MIN_TIER_BAD_EVENTS} bad ones in ${windowLabel(tier.longWindowMinutes)} to judge the burn. On fewer it neither fires nor resolves.`,
				]),
				...action,
			])
		}),
	)
	return Option.orElse(firing, () => holding)
}

/** A spent budget is a standing warning of its own beside any burn: calmer, with its own incident. */
const budgetCallout = (h: H, model: Model, slo: Slo, status: SloStatus): Option.Option<Html> => {
	const incident = openBudgetIncident(slo, model.incidents ?? [])
	if (Option.isNone(incident) && !isSpent(slo, status)) return Option.none()
	const notice = budgetNotice(slo, status)
	return Option.some(
		alert(h, { variant: "warn" }, [
			icon(h, "AlertWarningIcon"),
			alertTitle(h, [notice.title]),
			alertDescription(h, [notice.description]),
			...incidentAction(h, incident, "Open budget incident"),
		]),
	)
}

/** No events at all: say which filter to check, instead of figures that read as healthy. */
const noDataCallout = (h: H, slo: Slo, status: SloStatus): Option.Option<Html> =>
	hasNoData(status)
		? Option.some(
				alert(h, {}, [
					icon(h, "CircleInfoIcon"),
					alertTitle(h, [`No events in the last ${formatWindow(slo.window_days)}`]),
					alertDescription(h, [
						`No entry-point spans from ${scopeLine(slo)} were counted, so there is no SLI or budget to show. Check the service and the environments: environments are free text, so prod does not match production.`,
					]),
				]),
			)
		: Option.none()

/** The notices that lead the page: the burn first, then the spent budget, or that nothing is counted. */
const callouts = (h: H, model: Model, slo: Slo, status: SloStatus): ReadonlyArray<Html> =>
	Arr.getSomes([
		burnCallout(h, model, slo, status),
		budgetCallout(h, model, slo, status),
		noDataCallout(h, slo, status),
	])

/** The header's severity: the firing tier, or the open burn incident's while a tier holds it open. */
const headerSeverity = (model: Model, slo: Slo): Option.Option<AlertSeverity> =>
	Option.flatMap(statusOf(model), (status) =>
		Option.orElse(
			Option.map(firingTier(slo, status), (tier) => tier.severity),
			() =>
				Option.flatMap(holdingTier(slo, status), () =>
					Option.map(openBurnIncident(slo, model.incidents ?? []), (row) =>
						row.severity === "critical" ? "critical" : "warning",
					),
				),
		),
	)

const serviceHref = (slo: Slo): string =>
	hrefOf(AppRoute.Service({ serviceName: slo.service_name, search: {} }))

const body = (h: H, model: Model, slo: Slo, timeZone: string): ReadonlyArray<Html> => {
	const context: ChartContext | null =
		model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
			? { theme: model.themeColors, timeZone, nowMs: model.nowMs ?? 0 }
			: null
	const lead = Option.match(statusOf(model), {
		onNone: () => [],
		onSome: (status) => callouts(h, model, slo, status),
	})
	// The description scrolls with the body: the pinned header stays short on phones.
	return [
		...(slo.description === null || slo.description === ""
			? []
			: [typography(h, { size: "sm", tone: "soft", as: "p" }, [slo.description])]),
		...lead,
		figures(h, model, slo),
		h.div(
			[h.Class("grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]")],
			[
				vstack(h, { gap: "4", shrink: true }, [
					budgetPanel(h, model, slo, context),
					sliPanel(h, model, slo, context),
				]),
				vstack(h, { gap: "4", shrink: true }, [
					burnPanel(h, model, slo),
					alertingPanel(h, model, slo),
					incidentsPanel(h, model, slo, timeZone),
				]),
			],
		),
	]
}

const loadingPage = (h: H): Html =>
	dashboardPage(h, { titleContent: detailTitleSkeleton(h) }, [
		skeleton(h, "h-24 w-full"),
		skeleton(h, "h-64 w-full"),
	])

const notFound = (h: H, model: Model): Html =>
	dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "SLO not found",
			description: ["No SLO has the id ", h.code([h.Class("font-mono")], [model.rawSloId]), "."],
			back: { href: slosTabHref(), label: "Back to SLOs" },
		}),
	])

const deleteDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "slo-delete",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${Option.getOrElse(
			Option.map(sloOf(model), (slo) => slo.name),
			() => "this SLO",
		)}?`,
		description: "Its burn-rate alert rule goes with it and open incidents close. This cannot be undone.",
		confirmLabel: "Delete SLO",
		isPending: model.isDeleting,
		onConfirm: Message.ClickedConfirmDelete(),
	})

const page = (h: H, model: Model, inputs: PageViewInputs): Html => {
	if (model.sloId === null) return notFound(h, model)
	const data = model.slo.data
	if (AsyncData.isFailure(data))
		return data.error.code === SLO_NOT_FOUND_CODE
			? notFound(h, model)
			: dashboardPage(h, {}, [
					errorState(h, {
						failure: data.error,
						title: "Couldn't load the SLO",
						onRetry: Message.ClickedRetry(),
					}),
				])
	return Option.match(sloOf(model), {
		onNone: () => loadingPage(h),
		onSome: (slo) => {
			const severity = headerSeverity(model, slo)
			const title = {
				kind: ["SLO", sliLabel(slo.sli)],
				title: [slo.name],
				meta: [
					typography(h, { size: "xs", tone: "muted", mono: true }, [
						textLink(h, { href: serviceHref(slo), tone: "inherit", className: "inline" }, [
							scopeLine(slo),
						]),
						` · ${formatTarget(slo)} over ${formatWindow(slo.window_days)} · ${sliDescription(slo.sli)}`,
					]),
				],
			}
			return dashboardPage(
				h,
				{
					titleContent: Option.match(severity, {
						onNone: () => detailTitle(h, title),
						onSome: (level) => detailTitle(h, { ...title, adornment: severityBadge(h, level) }),
					}),
					actions: headerActions(h, model, slo),
					gap: "md",
				},
				body(h, model, slo, inputs.context.timeZone),
			)
		},
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS }))],
		[page(h, model, inputs), deleteDialog(h, model)],
	),
)

/** The H1 names the SLO, so the trail stops at the tab. */
export const breadcrumbsOf = () => [
	{ label: "Alerts", href: "/alerts" },
	{ label: "SLOs", href: slosTabHref() },
]
