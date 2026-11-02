import type { V2ScrapeTarget } from "@maple/domain/http/v2"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "../../ui/heading"
import { diagnoseScrapeError } from "../../lib/scrape-error-diagnosis"
import { button } from "../../ui/button"
import { inlineCode } from "../../ui/inline-code"
import {
	type CheckRow,
	flowColumns,
	flowRail,
	liveChecklist,
	type RailItem,
	savedBanner,
	statusRow,
	stepCard,
	whereToFind,
} from "../kit/connect-flow"
import { relativeTime } from "../kit/relative-time"
import { catalogEntry } from "./catalog"
import type { FlowStage } from "./flow"
import {
	flowTarget,
	isChoiceSaved,
	latestCheck,
	type ProbeState,
	probeStateOf,
	type ScrapeIntegration,
	scrapeLiveHealth,
} from "./flow-prometheus"
import { Message } from "./message"
import type { Model } from "./model"
import { hostnameOf } from "./prometheus"
import { isFormValid, parsedInterval } from "./update-prometheus"
import { authField, credentialFields, textField } from "./view-prometheus-form"

// Prometheus and WarpStream in the connect flow: save and probe an endpoint, name it, then watch
// the first scheduled scrape land.

type H = HtmlBuilder<Message>

const COPY = {
	prometheus: {
		label: "Prometheus",
		title: "Point Maple at your metrics endpoint",
		intro: "Any exporter that serves the Prometheus text format or OpenMetrics works: node_exporter, a /metrics route in your app, or a federated Prometheus. Maple scrapes it over the public internet.",
		placeholder: "https://metrics.example.com:9100/metrics",
		urlHint: "Include the path. http and https both work.",
		reads: [
			{
				icon: "GlobeIcon",
				title: "One HTTP GET per scrape interval",
				detail: "Against the URL you enter, with the auth you pick",
			},
			{
				icon: "ChartLineIcon",
				title: "Samples, stored as OpenTelemetry metrics",
				detail: "Under the service name you choose next",
			},
			{ icon: "ClockIcon", title: "Every 5 to 300 seconds", detail: "15 seconds unless you change it" },
		],
		trust: "Read-only: nothing is written back. Remove the source or rotate the token to stop scrapes at any time.",
		timeNote: "Takes about 1 minute",
	},
	warpstream: {
		label: "WarpStream",
		title: "Scrape your cluster's metrics endpoint",
		intro: "WarpStream serves Prometheus metrics in two places: a hosted endpoint per virtual cluster, and each Agent's own /metrics. Maple scrapes either one as a Prometheus target.",
		placeholder: "https://api.warpstream.com/api/v1/monitoring/prometheus/virtual_clusters/vci_...",
		urlHint:
			"The hosted endpoint needs Basic auth with the username prometheus and an Agent key as the password.",
		reads: [
			{
				icon: "ChartLineIcon",
				title: "Every warpstream_ metric the endpoint serves",
				detail: "Consumer lag, request latency, object-store health",
			},
			{
				icon: "ClockIcon",
				title: "Every 30 to 60 seconds is enough",
				detail: "Set the interval on the next step",
			},
		],
		trust: "A read-only Agent key can only read metrics. Revoke it in WarpStream to stop scrapes at any time.",
		timeNote: "Takes about 2 minutes",
	},
} satisfies Record<
	ScrapeIntegration,
	Readonly<{
		label: string
		title: string
		intro: string
		placeholder: string
		urlHint: string
		reads: ReadonlyArray<RailItem>
		trust: string
		timeNote: string
	}>
>

const docsOf = (integration: ScrapeIntegration) => {
	const href = catalogEntry(integration).docsUrl
	return href === undefined ? null : { label: `${COPY[integration].label} docs`, href }
}

const readsRail = (h: H, integration: ScrapeIntegration): Html =>
	flowRail(h, {
		eyebrow: "What Maple reads",
		items: COPY[integration].reads,
		trust: COPY[integration].trust,
		timeNote: COPY[integration].timeNote,
		docs: docsOf(integration),
	})

const showsUpRail = (h: H, integration: ScrapeIntegration): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			{
				icon: "ChartLineIcon",
				title: "Metrics explorer",
				detail: "Next to your OpenTelemetry metrics",
			},
			{
				icon: "GridIcon",
				title: "Dashboards and alerts",
				detail: "Chart any scraped metric or alert when a scrape fails",
			},
			{
				icon: "GearIcon",
				title: "Source page",
				detail: "Sync now, Edit data, Disconnect",
			},
		],
		docs: docsOf(integration),
	})

/** WarpStream's two endpoints and where each one's URL and key come from. */
const warpstreamGuide = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-2 rounded-md bg-surface-sunken p-4")],
		[
			heading(h, { level: 3, variant: "subsection" }, ["Where to find it in WarpStream"]),
			h.ul(
				[h.Class("flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted-foreground")],
				[
					h.li(
						[],
						[
							"Hosted endpoint (recommended): copy the virtual cluster ID (",
							inlineCode(h, {}, ["vci_..."]),
							") from the WarpStream console and put it at the end of the URL. No network changes.",
						],
					),
					h.li(
						[],
						[
							"Under Agent Keys, create a read-only key for the cluster. Pick Basic auth with the username ",
							inlineCode(h, {}, ["prometheus"]),
							" and the key as the password.",
						],
					),
					h.li(
						[],
						[
							"Agent /metrics: each Agent serves ",
							inlineCode(h, {}, [":8080/metrics"]),
							" in your VPC. It only works if Maple can reach it from the internet.",
						],
					),
				],
			),
		],
	)

const probeRow = (h: H, integration: ScrapeIntegration, target: V2ScrapeTarget | null, probe: ProbeState) => {
	switch (probe._tag) {
		case "Idle":
			return statusRow(h, {
				tone: "idle",
				text: "Waiting for an endpoint URL. Maple probes it as soon as you save.",
			})
		case "Saving":
			return statusRow(h, { tone: "working", text: "Saving the target." })
		case "Probing":
			return statusRow(h, {
				tone: "working",
				text: `Probing ${target === null ? "the endpoint" : hostnameOf(target.url)}.`,
				meta: target === null || target.auth_type === "none" ? "GET" : "GET with auth",
			})
		case "Ok":
			return statusRow(h, {
				tone: "ok",
				text: `Endpoint works. ${target === null ? "It" : hostnameOf(target.url)} answered the probe.`,
			})
		case "Failed":
			return failedRow(h, integration, target, probe.error)
	}
}

const failedRow = (
	h: H,
	integration: ScrapeIntegration,
	target: V2ScrapeTarget | null,
	error: string,
): Html => {
	const diagnosis = diagnoseScrapeError(error, "prometheus")
	return statusRow(
		h,
		{
			tone: "error",
			text: diagnosis === null ? "The probe failed." : `${diagnosis.title}. ${diagnosis.summary}`,
		},
		[
			h.pre(
				[
					h.Class(
						"overflow-x-auto rounded-md bg-surface-sunken p-3 font-mono text-xs text-severity-error whitespace-pre-wrap [overflow-wrap:anywhere]",
					),
				],
				[error],
			),
			...(diagnosis === null || diagnosis.fixes.length === 0
				? []
				: [
						h.div(
							[h.Class("flex flex-col gap-1.5")],
							[
								h.span([h.Class("text-xs font-medium")], ["How to fix it"]),
								h.ul(
									[
										h.Class(
											"flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground",
										),
									],
									diagnosis.fixes.map((fix) => h.li([], [fix])),
								),
							],
						),
					]),
			...(integration === "prometheus"
				? []
				: [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Agents only reachable inside your VPC? Run an OpenTelemetry Collector next to them and send to Maple instead.",
							],
						),
					]),
			...(target === null
				? []
				: [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								className: "w-fit",
								attributes: [h.OnClick(Message.ClickedProbe({ id: target.id }))],
							},
							["Probe again"],
						),
					]),
		],
	)
}

const connectStep = (h: H, model: Model, integration: ScrapeIntegration): Html => {
	const card = model.prometheusCard
	const target = flowTarget(model)
	const copy = COPY[integration]
	const docs = docsOf(integration)
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "LinkIcon", title: copy.title, note: "Credentials encrypted at rest" }, [
				h.p([h.Class("text-xs text-muted-foreground")], [copy.intro]),
				...(integration === "warpstream" ? [warpstreamGuide(h)] : []),
				h.form(
					[h.Class("flex flex-col gap-4"), h.OnSubmit(Message.SubmittedTargetForm())],
					[
						textField(h, model, {
							field: "url",
							id: "scrape-url",
							label: "Endpoint URL",
							placeholder: copy.placeholder,
							description: copy.urlHint,
							aside:
								docs === null ? undefined : whereToFind(h, "Where to find this", docs.href),
						}),
						authField(h, model),
						...credentialFields(h, model),
						button(
							h,
							{
								type: "submit",
								size: "sm",
								className: "w-fit",
								isLoading: card.isSaving,
								isDisabled: card.isSaving || card.form.url.value.trim() === "",
							},
							[target === null ? "Save and probe" : "Save and probe again"],
						),
					],
				),
			]),
			probeRow(h, integration, target, probeStateOf(model, target)),
		],
		readsRail(h, integration),
	)
}

/** Choose data: the name, service name and interval the probe-saved target runs with. */
const chooseStep = (h: H, model: Model, integration: ScrapeIntegration): Html => {
	const card = model.prometheusCard
	const target = flowTarget(model)
	const saved = target !== null && isChoiceSaved(model, target)
	const service = card.form.serviceName.value.trim() || card.form.name.value.trim()
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "TagIcon", title: "Name this target" }, [
				h.p(
					[h.Class("text-xs text-muted-foreground")],
					["How it shows up in Sources and on every metric it sends."],
				),
				h.form(
					[h.Class("flex flex-col gap-4"), h.OnSubmit(Message.SubmittedTargetForm())],
					[
						h.div(
							[h.Class("grid grid-cols-1 gap-4 @2xl/page:grid-cols-3")],
							[
								textField(h, model, {
									field: "name",
									id: "scrape-name",
									label: "Name",
									placeholder: "Node exporter prod",
								}),
								textField(h, model, {
									field: "serviceName",
									id: "scrape-service-name",
									label: "Service name",
									placeholder: card.form.name.value.trim() || "my-api-server",
								}),
								textField(h, model, {
									field: "interval",
									id: "scrape-interval",
									label: "Scrape interval (seconds)",
									placeholder: "15",
									type: "number",
									extra: [h.Attribute("min", "5"), h.Attribute("max", "300")],
									error:
										parsedInterval(card.form) === null
											? "Use a whole number from 5 to 300."
											: undefined,
								}),
							],
						),
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Metrics appear under service.name ",
								inlineCode(h, {}, [service === "" ? "the target name" : service]),
								". Interval is 5 to 300 seconds.",
							],
						),
						button(
							h,
							{
								type: "submit",
								size: "sm",
								className: "w-fit",
								isLoading: card.isSaving,
								isDisabled: card.isSaving || saved || !isFormValid(card.form),
							},
							[saved ? "Saved" : "Save"],
						),
					],
				),
			]),
		],
		readsRail(h, integration),
	)
}

const liveRows = (h: H, model: Model, target: V2ScrapeTarget, timeZone: string): ReadonlyArray<CheckRow> => {
	const probe = probeStateOf(model, target)
	const latest = latestCheck(model)
	const host = hostnameOf(target.url)
	return [
		probe._tag === "Failed"
			? { state: "failed", title: "Access failed", detail: probe.error }
			: probe._tag === "Ok"
				? {
						state: "done",
						title: "Access works",
						detail:
							target.auth_type === "none"
								? `${host} answered`
								: `${host} answered with your credentials`,
					}
				: { state: "working", title: "Checking access", detail: host },
		target.enabled
			? {
					state: "done",
					title: "Scrape scheduled",
					detail: `Every ${target.scrape_interval_seconds} s, as service ${target.service_name ?? target.name}`,
				}
			: {
					state: "failed",
					title: "Scraping is off",
					detail: "This target is disabled. Turn it on from the source page.",
				},
		latest === null
			? {
					state: "waiting",
					title: "First data: metrics",
					detail: `The first scheduled scrape runs within ${target.scrape_interval_seconds} s`,
				}
			: latest.success
				? {
						state: "done",
						title: "First data: metrics",
						detail: [
							latest.samples_scraped === null
								? "Last scrape stored"
								: `Last scrape read ${formatNumber(latest.samples_scraped)} samples`,
							latest.duration_seconds === null
								? ""
								: ` in ${formatDuration(latest.duration_seconds * 1000)}`,
						].join(""),
						meta: relativeTime(h, { value: latest.timestamp, nowMs: model.nowMs, timeZone }),
					}
				: {
						state: "failed",
						title: "Last scrape failed",
						detail: latest.message ?? "The scheduled scrape failed.",
						meta: relativeTime(h, { value: latest.timestamp, nowMs: model.nowMs, timeZone }),
					},
	]
}

const liveStep = (h: H, model: Model, integration: ScrapeIntegration, timeZone: string): Html => {
	const target = flowTarget(model)
	return flowColumns(
		h,
		[
			savedBanner(h, "Saved as a source. Safe to leave; scrapes keep running."),
			liveChecklist(h, {
				title:
					target === null
						? "Going live"
						: scrapeLiveHealth(model, target) === "healthy"
							? `${target.name} is live`
							: `${target.name} is going live`,
				rows:
					target === null
						? [{ state: "waiting", title: "Waiting for the saved target" }]
						: liveRows(h, model, target, timeZone),
			}),
		],
		showsUpRail(h, integration),
	)
}

export const prometheusFlowView = (
	h: H,
	model: Model,
	integration: ScrapeIntegration,
	stage: FlowStage,
	timeZone: string,
): Html =>
	stage === "live"
		? liveStep(h, model, integration, timeZone)
		: stage === "choose"
			? chooseStep(h, model, integration)
			: connectStep(h, model, integration)
