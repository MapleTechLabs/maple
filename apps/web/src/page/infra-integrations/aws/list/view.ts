import { AWS_INFRA_KINDS, type AwsInfraKindId } from "@maple/domain/aws-infra"
import { countLabel, pluralize } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import { AppRoute, hrefOf } from "../../../../route"
import { button, linkButton } from "../../../../ui/button"
import { heroFieldChip } from "../../../infra/kit/hero-chip"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { dataTableEmpty } from "../../../infra/kit/data-table"
import { FLEET_BAND_BOXED, fleetBand, fleetBandLoading } from "../../../infra/kit/fleet-band"
import { pageHeroParts, searchToolbar } from "../../../infra/kit/page-parts"
import { viewTabStrip } from "../../../infra/kit/view-tabs"
import { integrationNotConnected } from "../../kit/empty-states"
import { integrationConnectCta } from "../../kit/integration-empty"
import { AWS_ACCENT } from "../../../integrations/catalog"
import { pageTime } from "../../kit/page-time"
import type { AwsStatus, FleetRead } from "../data"
import {
	BAND_CELLS,
	filterViews,
	type Health,
	regionsOf,
	type ResourceView,
	resourceViews,
	sparkIndex,
	summaryOf,
} from "../derive"
import { Message } from "./message"
import type { Model } from "./model"
import { activeKind, DEFAULT_PRESET, searchHref } from "./update"
import { awsTable, awsTableLoading, type TableContext } from "./view-table"

// `/infra/aws`: every streamed resource of the connected accounts, problems first.

type H = HtmlBuilder<Message>

const MANAGE_HREF = hrefOf(AppRoute.Integrations({ search: { integration: "aws" } }))

const SEGMENT = {
	ok: "bg-success",
	warn: "bg-severity-warn",
	crit: "bg-severity-error",
	idle: "bg-muted-foreground/50",
} satisfies Record<Health, string>

const TONE = { crit: "crit", warn: "warn", idle: "neutral", ok: "ok" } as const

const loading = (h: H): Html =>
	h.div(
		[h.Class("space-y-4")],
		[fleetBandLoading(h, 2, FLEET_BAND_BOXED), awsTableLoading(h, "ecs", "Service")],
	)

const nameLabel = (kind: AwsInfraKindId) => AWS_INFRA_KINDS[kind].identity[0]?.[0] ?? "Resource"

const tabs = (h: H, model: Model, reads: ReadonlyArray<FleetRead>, active: AwsInfraKindId): Html =>
	viewTabStrip(
		h,
		"AWS resource kinds",
		reads.map((read) => ({
			id: read.kind,
			title: `${AWS_INFRA_KINDS[read.kind].title} ${resourceViews(read).length}`,
			href: searchHref({ ...model.search, tab: read.kind, scope: undefined }),
		})),
		active,
	)

const band = (h: H, model: Model, kind: AwsInfraKindId, views: ReadonlyArray<ResourceView>): Html => {
	const summary = summaryOf(views)
	const noun = AWS_INFRA_KINDS[kind].noun
	return fleetBand(h, {
		className: FLEET_BAND_BOXED,
		total: summary.total,
		noun,
		caption:
			summary.needsLook === 0
				? `Every ${noun} is healthy`
				: `${summary.healthy} healthy · ${summary.needsLook} need a look`,
		segments: (["ok", "warn", "crit", "idle"] as const).map((health) => ({
			key: health,
			count: summary.counts[health],
			className: SEGMENT[health],
		})),
		cells: BAND_CELLS[kind].map((cell) => ({
			scope: cell.scope,
			label: cell.label,
			hint: cell.hint,
			value: summary.byScope[cell.scope] ?? 0,
			tone: TONE[cell.tone],
		})),
		activeScope: model.search.scope,
		onScopeChange: (scope) => Message.ClickedScope({ scope }),
	})
}

const regionButtons = (h: H, model: Model, regions: ReadonlyArray<string>): ReadonlyArray<Html> =>
	regions.length < 2
		? []
		: [undefined, ...regions].map((region) =>
				button(
					h,
					{
						size: "sm",
						variant: model.search.region === region ? "secondary" : "outline",
						attributes: [
							h.OnClick(Message.ClickedRegion({ region })),
							h.AriaPressed(String(model.search.region === region)),
						],
					},
					[region ?? "All regions"],
				),
			)

const tableContext = (model: Model): TableContext => {
	const window = model.window
	const startMs = window === null ? 0 : toEpochMs(window.startTime)
	const endMs = window === null ? 0 : toEpochMs(window.endTime)
	return {
		sparks: sparkIndex(AsyncData.isSuccess(model.sparks.data) ? model.sparks.data.data : []),
		traced: AsyncData.isSuccess(model.traced.data) ? model.traced.data.data : null,
		window: {
			startMs,
			endMs,
			bucketMs: window === null ? 0 : chartBucketSeconds(window.startTime, window.endTime) * 1000,
		},
		windowMs: endMs - startMs,
	}
}

const kindView = (h: H, model: Model, read: FleetRead, isWaiting: boolean): Html => {
	if (read.failed)
		return dataTableEmpty(h, [
			`Couldn't load the ${AWS_INFRA_KINDS[read.kind].title} metrics. `,
			button(
				h,
				{ size: "sm", variant: "outline", attributes: [h.OnClick(Message.ClickedRetryFleet())] },
				["Retry"],
			),
		])
	const views = resourceViews(read)
	const shown = filterViews(views, model.search)
	const noun = AWS_INFRA_KINDS[read.kind].noun
	return h.div(
		[h.Class("space-y-4")],
		[
			band(h, model, read.kind, views),
			searchToolbar(h, {
				id: "aws-search",
				value: model.search.q ?? "",
				placeholder: `Filter ${pluralize(2, noun)}`,
				onInput: (value) => Message.ChangedSearch({ value }),
				onClear: Message.ClickedClearSearch(),
				children: regionButtons(h, model, regionsOf(views)),
				trailing:
					shown.length === views.length
						? `${countLabel(views.length, noun)} · problems first`
						: `${shown.length} of ${countLabel(views.length, noun)}`,
			}),
			shown.length === 0
				? dataTableEmpty(h, [`No ${pluralize(2, noun)} match. Clear the filters to see them all.`])
				: awsTable(h, {
						kind: read.kind,
						nameLabel: nameLabel(read.kind),
						views: shown,
						allViews: views,
						context: tableContext(model),
						isWaiting,
					}),
		],
	)
}

const FEATURES = [
	{
		label: "Access",
		title: "One read-only role",
		description: "A CloudFormation stack creates it. Maple reads metadata, never your data.",
	},
	{
		label: "Security",
		title: "No stored secret",
		description: "The role trusts only short-lived tokens Maple signs for this connection.",
	},
	{
		label: "Metrics",
		title: "Streamed from CloudWatch",
		description: "ECS, EC2, load balancers, RDS, Lambda and SQS, matched to your traces.",
	},
]

const awsConnectCta = (h: H): Html =>
	integrationConnectCta(h, {
		brand: { icon: "AwsIcon", accent: AWS_ACCENT, iconClassName: "text-foreground" },
		features: FEATURES,
		hint: "Deploy a read-only role, pick regions and services, then Maple streams their CloudWatch metrics.",
		label: "Connect AWS",
		href: hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } })),
	})

/** Connected, but nothing streamed yet: say which step is missing, never show placeholders. */
// Metrics that arrive win over the connection state: a stream set up outside Maple still reads.
const noMetrics = (h: H, status: AwsStatus): Html => {
	if (status.connections.length === 0)
		return status.available
			? awsConnectCta(h)
			: integrationNotConnected(h, {
					icon: icon(h, "AwsIcon", { size: 16 }),
					title: "AWS can't be connected here yet",
					description:
						"Maple streams CloudWatch metrics for ECS, EC2, load balancers, RDS, Lambda and SQS, and matches them to your traces.",
					integration: "aws",
					actionLabel: "Connect AWS",
				})
	const streaming = status.connections.filter((connection) => connection.metric_stream !== null)
	if (streaming.length === 0)
		return integrationNotConnected(h, {
			icon: icon(h, "AwsIcon", { size: 16 }),
			title: "Metrics are off",
			description:
				"The connected accounts have no metric stream, so AWS sends Maple nothing. Add one and deploy the stack again.",
			integration: "aws",
			actionLabel: "Stream metrics",
		})
	const error = streaming.find((connection) => connection.metrics_last_error !== null)?.metrics_last_error
	const regions = [...new Set(streaming.flatMap((connection) => connection.metric_stream?.regions ?? []))]
	return integrationNotConnected(h, {
		icon: icon(h, "AwsIcon", { size: 16 }),
		title: "Waiting for the first metrics",
		description:
			error ??
			`CloudWatch streams ${regions.join(", ")} once the stack is deployed again. Metrics land a few minutes after that.`,
		integration: "aws",
		actionLabel: "Check the connection",
		actionVariant: "outline",
	})
}

const fleetView = (
	h: H,
	model: Model,
	status: AwsStatus,
	reads: ReadonlyArray<FleetRead>,
	isWaiting: boolean,
) => {
	const active = activeKind(model)
	const read = reads.find((entry) => entry.kind === active)
	if (read === undefined || active === undefined) return noMetrics(h, status)
	return kindView(h, model, read, isWaiting)
}

/** The kind tabs for the header's `tabs` slot, once the status and the fleet have both read. */
const headerTabs = (h: H, model: Model): Html | undefined => {
	const active = activeKind(model)
	const reads = AsyncData.getOrElse(model.fleet.data, () => [])
	if (!AsyncData.hasData(model.status.data) || active === undefined) return undefined
	return reads.some((entry) => entry.kind === active) ? tabs(h, model, reads, active) : undefined
}

const fleet = (h: H, model: Model, status: AwsStatus): Html =>
	AsyncData.match(model.fleet.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load AWS metrics",
				onRetry: Message.ClickedRetryFleet(),
			}),
		onStale: ({ data }) => fleetView(h, model, status, data, true),
		onSuccess: (data) => fleetView(h, model, status, data, false),
		onRefreshing: (data) => fleetView(h, model, status, data, true),
	})

const statusView = (h: H, model: Model): Html =>
	AsyncData.match(model.status.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the AWS integration",
				onRetry: Message.ClickedRetryStatus(),
			}),
		onStale: ({ data }) => fleet(h, model, data),
		onSuccess: (data) => fleet(h, model, data),
		onRefreshing: (data) => fleet(h, model, data),
	})

/** "4417-2213-9045 · us-east-1, eu-central-1 · metrics every minute", ids and regions in mono. */
const description = (h: H, status: AwsStatus | null): Html | string => {
	if (status === null || status.connections.length === 0)
		return "CloudWatch metrics for every ECS service, instance, load balancer, database, function and queue."
	const regions = [
		...new Set(status.connections.flatMap((connection) => connection.metric_stream?.regions ?? [])),
	]
	const mono = (text: string) => h.span([h.Class("font-mono text-xs text-foreground/80")], [text])
	return h.span(
		[],
		[
			mono(status.connections.map((connection) => connection.account_id).join(" · ")),
			...(regions.length === 0 ? [] : [" · ", mono(regions.join(", "))]),
			" · metrics every minute",
		],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const status = AsyncData.isSuccess(model.status.data) ? model.status.data.data : null
	const accounts = status?.connections.length ?? 0
	const heroActions: ReadonlyArray<Html> = [
		linkButton(h, { size: "sm", variant: "outline", href: MANAGE_HREF }, [
			icon(h, "GearIcon"),
			"Manage accounts",
		]),
	]
	const hero = pageHeroParts(h, {
		title: "AWS",
		description: description(h, status),
		trailing:
			accounts === 0
				? []
				: [
						heroFieldChip(h, {
							label: pluralize(accounts, "account"),
							value: accounts.toLocaleString(),
							isValueFirst: true,
						}),
					],
	})
	return dashboardPage(
		h,
		{
			scrollClassName: "gap-6",
			titleContent: hero.title,
			tabs: headerTabs(h, model),
			actions: h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					...heroActions,
					pageTime(h, {
						search: model.search,
						defaultPreset: DEFAULT_PRESET,
						window: model.window,
						picker: model.timePicker,
						toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
						onReset: Message.ClickedResetTimeRange(),
						onReload: Message.ClickedReload(),
						isReloading: model.isReloading,
						isReloadHidden: AsyncData.isFailure(model.status.data),
					}),
				],
			),
		},
		[hero.body, h.div([h.Class(cn("flex flex-col gap-4"))], [statusView(h, model)])],
	)
})
