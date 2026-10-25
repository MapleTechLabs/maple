import type { ScrapeAuthType } from "@maple/domain/http"
import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { docsUrl } from "../../lib/docs"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../ui/alert"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { badge } from "../../ui/display"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import * as Menu from "../../ui/menu"
import { panel } from "../../ui/panel"
import { rowActionsMenu } from "../../ui/row-actions-menu"
import { skeletonList } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { switchControl } from "../../ui/switch"
import { docsLink } from "../kit/signal-empty-state"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../infra-integrations/kit/integration-empty"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"
import type { ScrapeIntegration } from "./flow-prometheus"
import { hostnameOf } from "./prometheus"
import { prometheusTargets } from "./update-prometheus"
import { targetDetails } from "./view-prometheus-details"
import { targetDialogs } from "./view-prometheus-form"

// `ScrapeTargetsSection` and `ScrapeTargetRow`, with the Prometheus and WarpStream intro alerts.
// TODO(tooltip): the last-error line renders its trigger; the raw-error popup is the overlay port's.

type H = HtmlBuilder<Message>

export const AUTH_TYPE_LABELS = {
	none: "None",
	bearer: "Bearer Token",
	basic: "Basic Auth",
	token: "Service Token",
	planetscale_oauth: "PlanetScale OAuth",
	supabase_oauth: "Supabase OAuth",
} satisfies { readonly [K in ScrapeAuthType]: string }

export interface ScheduledStatus {
	readonly label: string
	readonly detail: string
	readonly tone: Tone
}

/** `scheduledStatusFromRollup`, with the page's clock. */
export const statusFromRollup = (target: V2ScrapeTarget, nowMs: number): ScheduledStatus => {
	if (!target.enabled) return { label: "Disabled", detail: "Collector skips this target", tone: "neutral" }
	if (target.last_scrape_error !== null)
		return {
			label: "Down",
			detail:
				target.last_scrape_at === null
					? "No successful scheduled scrape"
					: `Last success ${formatRelativeTime(target.last_scrape_at, nowMs)}`,
			tone: "crit",
		}
	if (target.last_scrape_at === null)
		return { label: "No checks", detail: "No scheduled scrape observed", tone: "warn" }
	return {
		label: "Up",
		detail: `Scheduled ${formatRelativeTime(target.last_scrape_at, nowMs)}`,
		tone: "ok",
	}
}

export const toneBadge = (tone: Tone) => (tone === "neutral" ? "outline" : tone)

/** The Prometheus or WarpStream intro alert above the section. */
export const scrapeIntro = (h: H, integration: ScrapeIntegration): Html =>
	alert(h, { variant: "info" }, [
		icon(h, "CircleInfoIcon"),
		alertDescription(
			h,
			integration === "prometheus"
				? [
						"Maple scrapes any public Prometheus ",
						inlineCode(h, {}, ["/metrics"]),
						" endpoint you add as a target below and stores the samples as OpenTelemetry metrics.",
						" ",
						setupGuide(h, "prometheus"),
					]
				: [
						"WarpStream clusters are scraped as Prometheus targets. Point a target at an agent's ",
						inlineCode(h, {}, [":8080/metrics"]),
						" endpoint or the hosted Prometheus endpoint with Basic auth.",
						" ",
						setupGuide(h, "warpstream"),
					],
		),
	])

const COPY = {
	description: "Scrape Prometheus exporters and inspect scheduled scrape health.",
	emptyHint: "Targets you add will appear here with per-run scrape health.",
	emptyFooter: "Any Prometheus-compatible endpoint · scraped on your schedule",
	features: [
		{
			label: "Metrics explorer",
			title: "Scraped metrics, ready to chart",
			description: "Scraped metrics land alongside your OTel metrics in the explorer.",
		},
		{
			label: "Dashboards & alerts",
			title: "Widgets and thresholds",
			description: "Build dashboard widgets and threshold alerts on any scraped metric.",
		},
		{
			label: "Scrape health",
			title: "Every run checked",
			description: "Scheduled probes with per-target history and error diagnosis.",
		},
	],
} as const

/** New targets are added in `/sources/new`'s connect flow, not a dialog. */
const addButton = (h: H, integration: ScrapeIntegration, className?: string): Html =>
	linkButton(
		h,
		{
			size: className === undefined ? undefined : "sm",
			className,
			href: hrefOf(AppRoute.SourcesNew({ search: { integration } })),
		},
		[
			icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
			"Add another target",
		],
	)

const targetRow = (h: H, model: Model, target: V2ScrapeTarget, timeZone: string): Html => {
	const card = model.prometheusCard
	const status = statusFromRollup(target, model.nowMs)
	const isSelected = target.id === card.selectedId
	const menuId = `scrape-target-menu-${target.id}`
	const isManaged = target.managed_by !== null
	return h.div(
		[
			h.Role("button"),
			h.Tabindex(0),
			h.AriaPressed(String(isSelected)),
			h.OnClick(Message.ClickedTarget({ id: target.id })),
			h.OnKeyDownPreventDefault((key) =>
				key === "Enter" || key === " "
					? Option.some(Message.ClickedTarget({ id: target.id }))
					: Option.none(),
			),
			h.Class(
				cn(
					"flex cursor-pointer items-center gap-3 px-3 py-3 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50",
					isSelected && "bg-muted/60",
				),
			),
		],
		[
			statusDot(h, { tone: status.tone, size: "lg" }),
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							h.span(
								[h.Class("min-w-16 truncate text-sm font-medium"), h.Title(target.name)],
								[target.name],
							),
							badge(h, { variant: toneBadge(status.tone), className: "shrink-0" }, [
								status.label,
							]),
							...(target.service_name !== null && target.service_name !== ""
								? [
										badge(
											h,
											{
												variant: "outline",
												className: "min-w-0 max-w-40",
												attributes: [h.Title(target.service_name)],
											},
											[h.span([h.Class("truncate")], [target.service_name])],
										),
									]
								: []),
							...(target.auth_type !== "none"
								? [
										badge(h, { variant: "outline", className: "shrink-0" }, [
											AUTH_TYPE_LABELS[target.auth_type],
										]),
									]
								: []),
						],
					),
					h.div(
						[
							h.Class(
								"text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs",
							),
						],
						[
							h.span(
								[h.Class("max-w-[280px] truncate font-mono"), h.Title(target.url)],
								[hostnameOf(target.url)],
							),
							h.span([], [String(target.scrape_interval_seconds), "s interval"]),
							h.span([], [status.detail]),
							...(target.last_scrape_at !== null
								? [
										relativeTime(h, {
											value: target.last_scrape_at,
											nowMs: model.nowMs,
											timeZone,
											prefix: "Last scrape",
											tooltip: "title",
										}),
									]
								: []),
						],
					),
					...(target.last_scrape_error !== null && target.last_scrape_error !== ""
						? [
								h.div(
									[
										h.DataAttribute("base-ui-tooltip-trigger", ""),
										h.Class(
											"mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground",
										),
										h.DataAttribute("slot", "tooltip-trigger"),
									],
									[
										icon(h, "CircleInfoIcon", { size: 12, className: "shrink-0" }),
										h.span(
											[h.Class("truncate")],
											["Last scrape: ", target.last_scrape_error],
										),
									],
								),
							]
						: []),
				],
			),
			h.div(
				[h.OnClick(Message.ClickedTargetControls(), { propagation: "Stop" })],
				switchControl(h, {
					id: `scrape-target-switch-${target.id}`,
					inputId: `scrape-target-switch-input-${target.id}`,
					isChecked: target.enabled,
					isDisabled: card.toggling.includes(target.id),
					onToggle: Message.ClickedToggleTarget({ id: target.id }),
				}),
			),
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					isLoading: card.probing.includes(target.id),
					attributes: [h.OnClick(Message.ClickedProbe({ id: target.id }), { propagation: "Stop" })],
				},
				[icon(h, "ArrowRotateClockwiseIcon"), "Sync now"],
			),
			h.div(
				[h.OnClick(Message.ClickedTargetControls(), { propagation: "Stop" })],
				[
					rowActionsMenu(h, {
						slotId: menuId,
						model: card.menus[menuId] ?? Menu.init(menuId),
						label: `Actions for ${target.name}`,
						className: "text-muted-foreground hover:text-foreground shrink-0",
						entries: [
							{
								_tag: "Item",
								value: "edit",
								label: "Edit data",
								icon: "PencilIcon",
								isDisabled: isManaged,
							},
							{ _tag: "Separator" },
							{
								_tag: "Item",
								value: "delete",
								label: "Disconnect",
								icon: "TrashIcon",
								variant: "destructive",
								isDisabled: isManaged,
							},
						],
						toParentMessage: (message) =>
							Message.GotTargetMenuMessage({ id: target.id, message }),
					}),
				],
			),
		],
	)
}

const emptyState = (h: H, integration: ScrapeIntegration): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, COPY.features),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, { icon: "PrometheusIcon", accent: "#E6522C" }),
			integrationEmptyHint(h, [COPY.emptyHint]),
			addButton(h, integration),
			docsLink(h, "prometheus"),
			integrationEmptyFooter(h, [COPY.emptyFooter]),
		]),
	])

const placeholder = (h: H): Html =>
	panel(h, { padded: true, className: "hidden lg:flex" }, [
		h.div(
			[
				h.Class(
					"text-muted-foreground flex h-full min-h-[260px] flex-col items-center justify-center gap-2 text-center text-xs",
				),
			],
			[
				icon(h, "CircleInfoIcon", { size: 18 }),
				h.span([], ["Click a target to inspect scheduled checks."]),
			],
		),
	])

/** `ScrapeTargetsSection`: the list, the selected target's details, and its dialogs. */
/** `focusId`: a source's own target (`/sources/$id`), shown alone instead of the whole list. */
export const scrapeTargetsSection = (
	h: H,
	model: Model,
	timeZone: string,
	focusId: string | null = null,
	integration: ScrapeIntegration = "prometheus",
): ReadonlyArray<Html> => {
	const data = model.statuses.scrapeTargets.data
	const all = prometheusTargets(model)
	const targets = focusId === null ? all : all.filter((target) => target.id === focusId)
	const isLoaded = AsyncData.isSuccess(data) || AsyncData.isRefreshing(data)
	const isEmpty = isLoaded && targets.length === 0
	const selected = targets.find((target) => target.id === model.prometheusCard.selectedId)
	const body = AsyncData.match(data, {
		onIdle: () => skeletonList(h, { rows: 3, rowClassName: "h-[60px]", gap: "2" }),
		onLoading: () => skeletonList(h, { rows: 3, rowClassName: "h-[60px]", gap: "2" }),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load scrape targets",
				onRetry: Message.ClickedRetryStatus({ name: "scrapeTargets" }),
			}),
		onStale: ({ error }) =>
			errorState(h, {
				failure: error,
				title: "Failed to load scrape targets",
				onRetry: Message.ClickedRetryStatus({ name: "scrapeTargets" }),
			}),
		onRefreshing: () => list(),
		onSuccess: () => list(),
	})
	function list(): Html {
		return targets.length === 0
			? focusId === null
				? emptyState(h, integration)
				: h.p([h.Class("text-muted-foreground text-sm")], ["This scrape target no longer exists."])
			: h.div(
					[h.Class("grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]")],
					[
						panel(
							h,
							{ className: "divide-y" },
							targets.map((target) => targetRow(h, model, target, timeZone)),
						),
						selected === undefined ? placeholder(h) : targetDetails(h, model, selected, timeZone),
					],
				)
	}
	return [
		h.div(
			[h.Class("space-y-4")],
			[
				...(isEmpty
					? []
					: [
							h.div(
								[h.Class("flex items-center justify-between gap-3")],
								[
									h.p([h.Class("text-muted-foreground text-sm")], [COPY.description]),
									addButton(h, integration, "shrink-0"),
								],
							),
						]),
				body,
			],
		),
		...targetDialogs(h, model),
	]
}

const setupGuide = (h: H, page: "prometheus" | "warpstream"): Html =>
	h.a(
		[
			h.Href(docsUrl(page)),
			h.Target("_blank"),
			h.Rel("noreferrer"),
			h.Class("text-foreground underline underline-offset-2 hover:no-underline"),
		],
		["Setup guide"],
	)
