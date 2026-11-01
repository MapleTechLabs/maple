import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import type { ServiceWorkload } from "@maple/web-data/warehouse/service-infra"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import { keyValue, keyValueList } from "../../ui/key-value"
import { panel } from "../../ui/panel"
import { scrollArea } from "../../ui/scroll-area"
import { docsLink } from "../kit/signal-empty-state"
import { type RuntimeLink, runtimeLink, type ServiceRuntime, workloadLink } from "../kit/service-runtimes"
import type { TimeSearch } from "../kit/time-controls"
import type { Message } from "./message"

// The service panel's Infrastructure tab: the platform resources the service runs as, its
// Kubernetes workloads, and how to link either when neither matched.

type H = HtmlBuilder<Message>

type KnownKind = "deployment" | "statefulset" | "daemonset"
const knownKindOf = (kind: string): KnownKind | null =>
	kind === "deployment" || kind === "statefulset" || kind === "daemonset" ? kind : null

const LINK = "inline-flex items-center gap-1 text-3xs text-primary hover:text-primary/80 active:text-primary/80"

const podsHref = (workload: ServiceWorkload, kind: KnownKind | null, time: TimeSearch): string => {
	const namespaces = workload.namespace ? [workload.namespace] : undefined
	const byKind =
		kind === "deployment"
			? { deployments: [workload.workloadName] }
			: kind === "statefulset"
				? { statefulsets: [workload.workloadName] }
				: kind === "daemonset"
					? { daemonsets: [workload.workloadName] }
					: {}
	const href = hrefOf(AppRoute.InfraKubernetesPods({ search: { ...time, ...byKind, namespaces } }))
	// Orders the search keys: the kind filter, then namespaces.
	const [path, query] = href.split("?")
	if (query === undefined) return href
	const pairs = query.split("&")
	const isNamespaces = (pair: string) => pair.startsWith("namespaces=")
	return `${path}?${[...pairs.filter((pair) => !isNamespaces(pair)), ...pairs.filter(isNamespaces)].join("&")}`
}

const utilization = (value: number | null): string => (value == null ? EMPTY_VALUE : formatPercent(value))

const workloadRow = (h: H, workload: ServiceWorkload, time: TimeSearch): Html => {
	const kind = knownKindOf(workload.workloadKind)
	return panel(h, { padded: "sm", className: "space-y-2.5" }, [
		h.div(
			[h.Class("flex items-start justify-between gap-2")],
			[
				h.div(
					[h.Class("min-w-0 flex-1")],
					[
						eyebrow(h, { as: "div", className: "flex items-center gap-1.5" }, [
							icon(h, "CubeIcon", { size: 12 }),
							h.span([], [workload.workloadKind]),
						]),
						h.p(
							[h.Class("text-xs font-medium text-foreground truncate mt-0.5")],
							[workload.workloadName],
						),
						h.p(
							[h.Class("text-3xs text-muted-foreground mt-0.5 truncate")],
							[
								workload.namespace || "default",
								workload.clusterName ? ` · ${workload.clusterName}` : "",
							],
						),
					],
				),
				h.div(
					[h.Class("flex flex-col items-end gap-px shrink-0")],
					[
						eyebrow(h, {}, ["pods"]),
						h.span(
							[h.Class("text-sm font-semibold text-foreground tabular-nums font-mono")],
							[String(workload.podCount)],
						),
					],
				),
			],
		),
		keyValueList(h, { className: "grid grid-cols-2 gap-2 text-3xs" }, [
			keyValue(h, { label: "CPU", mono: true, className: "rounded-sm bg-surface-sunken px-2 py-1" }, [
				utilization(workload.avgCpuLimitUtilization),
			]),
			keyValue(h, { label: "Memory", mono: true, className: "rounded-sm bg-surface-sunken px-2 py-1" }, [
				utilization(workload.avgMemoryLimitUtilization),
			]),
		]),
		h.div(
			[h.Class("flex items-center gap-3 pt-0.5")],
			[
				...(kind === null
					? []
					: [
							h.a(
								[h.Class(LINK), h.Href(workloadLink(workload, time).href)],
								["View workload ", icon(h, "ArrowRightIcon", { size: 10 })],
							),
						]),
				h.a(
					[h.Class(LINK), h.Href(podsHref(workload, kind, time))],
					["View pods ", icon(h, "ArrowRightIcon", { size: 10 })],
				),
			],
		),
	])
}

/** A platform resource the service runs as, linked to its infra page. */
const runtimeRow = (h: H, link: RuntimeLink): Html =>
	h.a(
		[
			h.Key(link.key),
			h.Href(link.href),
			h.Class(
				"group block rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			),
		],
		[
			panel(h, { padded: "sm", className: "space-y-1 transition-colors group-hover:bg-surface-sunken" }, [
				eyebrow(h, { as: "div", className: "flex items-center gap-1.5" }, [
					icon(h, link.icon, { size: 12 }),
					h.span([], [link.label]),
				]),
				h.div(
					[h.Class("flex items-center justify-between gap-2")],
					[
						h.p(
							[h.Class("min-w-0 truncate font-mono text-xs font-medium text-foreground")],
							[link.name],
						),
						icon(h, "ArrowRightIcon", {
							size: 12,
							className: "shrink-0 text-muted-foreground group-hover:text-primary",
						}),
					],
				),
				...(link.location.length === 0
					? []
					: [
							h.p(
								[h.Class("truncate text-3xs text-muted-foreground")],
								[link.location.join(" · ")],
							),
						]),
			]),
		],
	)

/** No platform resource and no Kubernetes workload matched: how each one gets linked. */
const infraEmptyState = (h: H): Html =>
	h.div(
		[h.Class("rounded-md border border-dashed bg-surface-faint p-4 space-y-3")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					icon(h, "CubeIcon", { size: 14, className: "text-foreground-faint" }),
					h.p(
						[h.Class("text-xs font-medium text-foreground")],
						["Not linked to any infrastructure"],
					),
				],
			),
			h.p(
				[h.Class("text-2xs text-muted-foreground leading-relaxed")],
				[
					"Set ",
					inlineCode(h, {}, ["OTEL_SERVICE_NAME"]),
					" to the name of its Cloud Run service, Lambda function, ECS service, Railway service or Cloudflare Worker, and connect that platform under Infrastructure.",
				],
			),
			h.p(
				[h.Class("text-2xs text-muted-foreground leading-relaxed")],
				[
					"On Kubernetes, install the maple-k8s-infra Helm chart and label the namespace so spans carry ",
					inlineCode(h, {}, ["k8s.deployment.name"]),
					":",
				],
			),
			h.pre(
				[h.Class("text-3xs bg-muted px-2 py-1.5 rounded-sm font-mono text-foreground overflow-x-auto")],
				["kubectl label namespace <ns> maple.io/instrument=true"],
			),
			docsLink(h, "kubernetes"),
		],
	)

const section = (h: H, title: string, rows: ReadonlyArray<Html>): Html =>
	h.div([h.Class("space-y-2")], [eyebrow(h, { as: "h4" }, [title]), h.div([h.Class("space-y-2")], rows)])

export const infrastructureTab = (
	h: H,
	workloads: ReadonlyArray<ServiceWorkload>,
	runtimes: ReadonlyArray<ServiceRuntime>,
	time: TimeSearch,
): ReadonlyArray<Html> => [
	scrollArea(h, { idPrefix: "service-map-infra-scroll", className: "h-full" }, [
		h.div(
			[h.Class("p-4 space-y-4")],
			workloads.length === 0 && runtimes.length === 0
				? [infraEmptyState(h)]
				: [
						...(runtimes.length === 0
							? []
							: [
									section(
										h,
										"Runs on",
										runtimes.map((runtime) => runtimeRow(h, runtimeLink(runtime, time))),
									),
								]),
						...(workloads.length === 0
							? []
							: [
									section(
										h,
										"Kubernetes workloads",
										workloads.map((workload) => workloadRow(h, workload, time)),
									),
								]),
					],
		),
	]),
]
