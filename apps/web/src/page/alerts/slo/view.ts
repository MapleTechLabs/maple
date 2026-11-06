import type { AlertSeverity } from "@maple/domain/http"
import { windowLabel } from "@maple/domain/slo"
import { Option } from "effect"
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
import { incidentHref } from "../shared/links"
import { editSloHref, SLO_NOT_FOUND_CODE, slosTabHref } from "../shared/slo-commands"
import {
	burnOf,
	firingTier,
	formatBudget,
	formatBurn,
	formatTarget,
	formatWindow,
	holdingLine,
	holdingTier,
	isBudgetSpent,
	openIncident,
	scopeLine,
	sliDescription,
	sliLabel,
	type Slo,
	type SloStatus,
} from "../shared/slo-derive"
import { Message } from "./message"
import { canManage, type Model } from "./model"
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

// `/alerts/slos/$sloId`: the header, a callout while the budget burns or is spent, then the panels.

type H = HtmlBuilder<Message>

const headerActions = (h: H, model: Model, slo: Slo): Html =>
	detailActions(
		h,
		canManage(model)
			? [
					linkButton(h, { size: "sm", variant: "outline", href: editSloHref(slo.id) }, [
						icon(h, "PencilIcon"),
						"Edit",
					]),
					button(
						h,
						{
							size: "sm",
							variant: "destructive-outline",
							attributes: [h.OnClick(Message.ClickedDelete())],
						},
						[icon(h, "TrashIcon"), "Delete"],
					),
				]
			: [],
	)

const statusOf = (model: Model): Option.Option<SloStatus> => AsyncData.getData(model.status.data)

/** A firing tier leads the page: what burns, at which rates, and the incident it opened. */
const callout = (h: H, model: Model, slo: Slo, status: SloStatus): Html | null => {
	const incident = openIncident(slo, model.incidents ?? [])
	const action = Option.match(incident, {
		onNone: () => [],
		onSome: (row) => [
			alertAction(h, [
				linkButton(h, { size: "sm", variant: "outline", href: incidentHref(row.id) }, [
					"Open incident",
				]),
			]),
		],
	})
	const firing = Option.map(firingTier(status), (tier) =>
		alert(h, { variant: tier.severity === "critical" ? "crit" : "warn" }, [
			icon(h, "FireIcon"),
			alertTitle(h, [
				`Burning the error budget at ${formatBurn(burnOf(status, tier.longWindowMinutes))} over ${windowLabel(tier.longWindowMinutes)}`,
			]),
			alertDescription(h, [
				`At this rate the ${slo.window_days}-day budget runs out early. The ${tier.severity} tier fires at ${tier.factor}x over both ${windowLabel(tier.longWindowMinutes)} and ${windowLabel(tier.shortWindowMinutes)}.`,
			]),
			...action,
		]),
	)
	// An outage empties the short window: the tier holds, so the open incident leads the page.
	const holding = Option.flatMap(holdingTier(status), (tier) =>
		Option.map(incident, (row) =>
			alert(h, { variant: row.severity === "critical" ? "crit" : "warn" }, [
				icon(h, "FireIcon"),
				alertTitle(h, [holdingLine(tier)]),
				alertDescription(h, [
					`The ${tier.severity} tier cannot judge the burn without events, so it neither fires nor resolves. Check whether ${slo.service_name} is down or has stopped reporting.`,
				]),
				...action,
			]),
		),
	)
	const spent = isBudgetSpent(status.budget_remaining)
		? Option.some(
				alert(h, { variant: "crit" }, [
					icon(h, "CircleXmarkIcon"),
					alertTitle(h, ["Error budget spent"]),
					alertDescription(h, [
						`The last ${formatWindow(slo.window_days)} saw more bad events than ${formatTarget(slo)} allows: ${formatBudget(-status.budget_remaining)} over budget. It recovers as bad hours leave the window.`,
					]),
					...action,
				]),
			)
		: Option.none()
	return Option.getOrNull(
		Option.orElse(
			Option.orElse(firing, () => holding),
			() => spent,
		),
	)
}

/** The header's severity: the firing tier, or the open incident's while a tier holds it open. */
const headerSeverity = (model: Model, slo: Slo): Option.Option<AlertSeverity> =>
	Option.flatMap(statusOf(model), (status) =>
		Option.orElse(
			Option.map(firingTier(status), (tier) => tier.severity),
			() =>
				Option.flatMap(holdingTier(status), () =>
					Option.map(openIncident(slo, model.incidents ?? []), (row) =>
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
	const lead = Option.getOrNull(Option.map(statusOf(model), (status) => callout(h, model, slo, status)))
	return [
		...(lead === null ? [] : [lead]),
		figures(h, model, slo),
		h.div(
			[h.Class("grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]")],
			[
				vstack(h, { gap: "4", shrink: true }, [
					budgetPanel(h, model, slo, context),
					sliPanel(h, model, slo, context),
				]),
				vstack(h, { gap: "4", shrink: true }, [
					burnPanel(h, model),
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
						h.a(
							[h.Href(serviceHref(slo)), h.Class("hover:underline active:underline")],
							[scopeLine(slo)],
						),
						` · ${formatTarget(slo)} over ${formatWindow(slo.window_days)} · ${sliDescription(slo.sli)}`,
					]),
					...(slo.description === null || slo.description === ""
						? []
						: [
								typography(
									h,
									{ size: "sm", tone: "soft", as: "p", className: "basis-full" },
									[slo.description],
								),
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
