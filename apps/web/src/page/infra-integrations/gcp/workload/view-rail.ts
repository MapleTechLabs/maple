import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpResource } from "@maple/domain/http"
import type { GcpConsoleLinks } from "../../../../components/infra/gcp/inventory"
import { gcpStateLabel } from "../../../../components/infra/gcp/tabs"
import type { GcpRailFact } from "../../../../components/infra/gcp/workload-signals"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { detailRailField, detailRailGroup, detailRailMetaRow } from "../../../../ui/detail-rail"
import { icon, type IconName } from "../../../../ui/icon"
import { inlineCode } from "../../../../ui/inline-code"
import { serviceDot } from "../../../../ui/values"
import type { Message } from "./model"

// `GcpWorkloadRail`.

type H = HtmlBuilder<Message>
type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

const RAIL_TITLE = {
	cloudRun: "Cloud Run service",
	cloudFunctions: "Cloud Function",
	gke: "GKE container",
	computeEngine: "VM instance",
	cloudSql: "Cloud SQL instance",
	pubsub: "Pub/Sub subscription",
	loadBalancing: "Load balancer",
} as const satisfies Record<GcpInfraServiceId, string>

const FACT_TONE = {
	ok: "text-severity-info",
	warn: "text-severity-warn",
	crit: "text-severity-error",
} as const

const RAIL_LINK =
	"group -mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-xs text-foreground-soft hover:bg-surface-sunken active:bg-surface-sunken hover:text-foreground active:text-foreground"

const label = (h: H, text: string): Html => h.span([h.Class("min-w-0 flex-1 truncate")], [text])

const chevron = (h: H): Html =>
	icon(h, "ChevronRightIcon", {
		size: 12,
		className: "shrink-0 text-foreground-faint transition-colors group-hover:text-foreground",
	})

const linkBody = (h: H, name: IconName, text: string): ReadonlyArray<Html> => [
	icon(h, name, { size: 14, className: "shrink-0 text-muted-foreground group-hover:text-foreground" }),
	label(h, text),
	chevron(h),
]

const externalLink = (h: H, href: string, name: IconName, text: string): Html =>
	h.a(
		[h.Class(RAIL_LINK), h.Href(href), h.Rel("noreferrer"), h.Target("_blank")],
		[
			icon(h, name, {
				size: 14,
				className: "shrink-0 text-muted-foreground group-hover:text-foreground",
			}),
			label(h, text),
			icon(h, "ExternalLinkIcon", {
				size: 12,
				className: "shrink-0 text-foreground-faint transition-colors group-hover:text-foreground",
			}),
		],
	)

/** Rail keys in sentence case; the signal modules keep lowercase keys for their own prose. */
const railKey = (label: string): string => {
	const [first = "", ...rest] = label.split(" ")
	const lead = first === "cpu" ? "CPU" : first.charAt(0).toUpperCase() + first.slice(1)
	return [lead, ...rest].join(" ")
}

const factRow = (h: H, fact: GcpRailFact): Html | null =>
	detailRailMetaRow(h, {
		label: railKey(fact.label),
		value: fact.value,
		valueClassName: fact.tone === undefined ? undefined : FACT_TONE[fact.tone],
	})

const present = (nodes: ReadonlyArray<Html | null>): ReadonlyArray<Html> =>
	nodes.filter((node): node is Html => node !== null)

export type RailOptions = Readonly<{
	service: GcpInfraServiceId
	project: string | undefined
	location: string | undefined
	resource: GcpResource | undefined
	facts: ReadonlyArray<GcpRailFact>
	health: ReadonlyArray<GcpRailFact>
	traced: Readonly<{ name: string; service: string | null }> | undefined
	logs: Readonly<{ service: string; attrs: ReadonlyArray<string> }>
	serviceMap: Readonly<{ focusService: string | undefined }> | undefined
	consoleLinks: GcpConsoleLinks
	timeSearch: TimeSearch
}>

export const workloadRail = (h: H, options: RailOptions): Html => {
	const inventory = options.service === "gke" ? undefined : options.resource
	const labels =
		inventory === undefined
			? []
			: Object.entries(inventory.labels).map(([key, value]) => `${key}=${value}`)
	const tracedService = options.traced?.service ?? null
	const { timeSearch } = options
	return h.div(
		[h.Class("flex flex-col")],
		[
			detailRailGroup(h, RAIL_TITLE[options.service], [
				...present([
					detailRailMetaRow(h, { label: "Location", value: options.location }),
					detailRailMetaRow(h, { label: "Project", value: options.project }),
					detailRailMetaRow(h, {
						label: "State",
						value:
							inventory === undefined || inventory.state === null
								? null
								: gcpStateLabel(inventory.state),
					}),
					...options.facts.map((fact) => factRow(h, fact)),
				]),
				...(labels.length === 0
					? []
					: [
							detailRailField(h, { label: "Labels" }, [
								h.div(
									[h.Class("flex flex-wrap gap-1")],
									labels.map((text) =>
										h.span(
											[h.Class("flex min-w-0 max-w-full"), h.Title(text)],
											[
												inlineCode(h, { className: "truncate text-2xs/[18px]" }, [
													text,
												]),
											],
										),
									),
								),
							]),
						]),
			]),
			...(options.health.length === 0
				? []
				: [detailRailGroup(h, "Health", present(options.health.map((fact) => factRow(h, fact))))]),
			...(options.traced === undefined
				? []
				: [
						detailRailGroup(h, "Traced as", [
							options.traced.service === null
								? h.p(
										[h.Class("text-2xs leading-relaxed text-muted-foreground")],
										[
											`No service named ${options.traced.name} sent spans in this window, so Google Cloud's metrics are all there is.`,
										],
									)
								: h.a(
										[
											h.Class(RAIL_LINK),
											h.Href(
												hrefOf(
													AppRoute.Service({
														serviceName: options.traced.service,
														search: timeSearch,
													}),
												),
											),
										],
										[
											h.span(
												[h.Class("flex w-3.5 shrink-0 justify-center")],
												[serviceDot(h, { serviceName: options.traced.service })],
											),
											label(h, options.traced.service),
											chevron(h),
										],
									),
						]),
					]),
			detailRailGroup(h, "Explore", [
				h.a(
					[
						h.Class(RAIL_LINK),
						h.Href(
							hrefOf(
								AppRoute.Logs({
									search: {
										...timeSearch,
										services: [options.logs.service],
										attrs:
											options.logs.attrs.length > 0
												? [...options.logs.attrs]
												: undefined,
									},
								}),
							),
						),
					],
					linkBody(h, "FileIcon", "Logs"),
				),
				...(tracedService === null
					? []
					: [
							h.a(
								[
									h.Class(RAIL_LINK),
									h.Href(
										hrefOf(
											AppRoute.Traces({
												search: { ...timeSearch, services: [tracedService] },
											}),
										),
									),
								],
								linkBody(h, "PulseIcon", "Traces"),
							),
						]),
				...(options.serviceMap === undefined && tracedService === null
					? []
					: [
							h.a(
								[
									h.Class(RAIL_LINK),
									h.Href(
										hrefOf(
											AppRoute.ServiceMap({
												search: {
													...timeSearch,
													focusService:
														options.serviceMap?.focusService ??
														tracedService ??
														undefined,
												},
											}),
										),
									),
								],
								linkBody(h, "NetworkNodesIcon", "Service map"),
							),
						]),
			]),
			detailRailGroup(h, "Google Cloud console", [
				externalLink(
					h,
					options.consoleLinks.page.href,
					"GoogleCloudMonoIcon",
					options.consoleLinks.page.label,
				),
				externalLink(h, options.consoleLinks.logs, "FileIcon", "Logs Explorer"),
			]),
		],
	)
}
