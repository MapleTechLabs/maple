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
import type { Message } from "./message"

// The service panel's Infrastructure tab: `ServiceWorkloadRow` and `ServiceInfraEmptyState`.
// TODO(gcp): `GcpServiceWorkloads` renders only while a GCP connection collects metrics; the page
// has no GCP status yet, so the tab shows what it shows without one (the Kubernetes rows).

type H = HtmlBuilder<Message>

type KnownKind = "deployment" | "statefulset" | "daemonset"
const knownKindOf = (kind: string): KnownKind | null =>
	kind === "deployment" || kind === "statefulset" || kind === "daemonset" ? kind : null

const LINK = "inline-flex items-center gap-1 text-3xs text-primary hover:text-primary/80 transition-colors"

const podsHref = (workload: ServiceWorkload, kind: KnownKind | null): string => {
	const namespaces = workload.namespace ? [workload.namespace] : undefined
	const byKind =
		kind === "deployment"
			? { deployments: [workload.workloadName] }
			: kind === "statefulset"
				? { statefulsets: [workload.workloadName] }
				: kind === "daemonset"
					? { daemonsets: [workload.workloadName] }
					: {}
	const href = hrefOf(AppRoute.InfraKubernetesPods({ search: { ...byKind, namespaces } }))
	// Orders the search keys: the kind filter, then namespaces.
	const [path, query] = href.split("?")
	if (query === undefined) return href
	const pairs = query.split("&")
	const isNamespaces = (pair: string) => pair.startsWith("namespaces=")
	return `${path}?${[...pairs.filter((pair) => !isNamespaces(pair)), ...pairs.filter(isNamespaces)].join("&")}`
}

const utilization = (value: number | null): string => (value == null ? EMPTY_VALUE : formatPercent(value))

const workloadRow = (h: H, workload: ServiceWorkload): Html => {
	const kind = knownKindOf(workload.workloadKind)
	return panel(h, { padded: "sm", className: "space-y-2.5" }, [
		h.div(
			[h.Class("flex items-start justify-between gap-2")],
			[
				h.div(
					[h.Class("min-w-0 flex-1")],
					[
						eyebrow(h, { as: "div", className: "flex items-center gap-1.5" }, [
							icon(h, "CubeIcon", { size: 11 }),
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
			keyValue(h, { label: "CPU", mono: true, className: "rounded bg-muted/30 px-2 py-1" }, [
				utilization(workload.avgCpuLimitUtilization),
			]),
			keyValue(h, { label: "Memory", mono: true, className: "rounded bg-muted/30 px-2 py-1" }, [
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
								[
									h.Class(LINK),
									h.Href(
										hrefOf(
											AppRoute.InfraKubernetesWorkload({
												kind,
												workloadName: workload.workloadName,
												search: {},
											}),
										),
									),
								],
								["View workload ", icon(h, "ArrowRightIcon", { size: 10 })],
							),
						]),
				h.a(
					[h.Class(LINK), h.Href(podsHref(workload, kind))],
					["View pods ", icon(h, "ArrowRightIcon", { size: 10 })],
				),
			],
		),
	])
}

/** `ServiceInfraEmptyState`: how to get Kubernetes context onto the service. */
const infraEmptyState = (h: H): Html =>
	h.div(
		[h.Class("rounded-md border border-dashed bg-muted/20 p-4 space-y-3")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					icon(h, "CubeIcon", { size: 14, className: "text-muted-foreground/50" }),
					h.p([h.Class("text-xs font-medium text-foreground")], ["No Kubernetes workloads found"]),
				],
			),
			h.p(
				[h.Class("text-2xs text-muted-foreground leading-relaxed")],
				[
					"This service has no spans tagged with ",
					inlineCode(h, {}, ["k8s.deployment.name"]),
					" in the selected window. Install the maple-k8s-infra Helm chart and label your namespace to enable infrastructure context:",
				],
			),
			h.pre(
				[h.Class("text-3xs bg-muted px-2 py-1.5 rounded font-mono text-foreground overflow-x-auto")],
				["kubectl label namespace <ns> maple.io/instrument=true"],
			),
			docsLink(h, "kubernetes"),
		],
	)

export const infrastructureTab = (h: H, workloads: ReadonlyArray<ServiceWorkload>): ReadonlyArray<Html> => [
	scrollArea(h, { idPrefix: "service-map-infra-scroll", className: "h-full" }, [
		h.div(
			[h.Class("p-4 space-y-4")],
			workloads.length === 0
				? [infraEmptyState(h)]
				: [
						h.div(
							[h.Class("space-y-2")],
							[
								eyebrow(h, { as: "h4" }, ["Kubernetes workloads"]),
								h.div(
									[h.Class("space-y-2")],
									workloads.map((workload) => workloadRow(h, workload)),
								),
							],
						),
					],
		),
	]),
]
