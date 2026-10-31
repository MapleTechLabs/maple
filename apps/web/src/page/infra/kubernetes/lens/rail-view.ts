import { severityLevel } from "../../../../components/infra/format"
import { BAR_VALUE_TONE } from "../../../../components/infra/severity-tokens"
import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { eyebrow } from "../../../../ui/eyebrow"
import { skeletonList } from "../../../../ui/skeleton"
import { serviceDot } from "../../../../ui/values"
import type { TimeSearch } from "../../kit/view-tabs"
import type { Model } from "./rail"

// `ServiceLensRail` and the rail rows `useServiceLensRail` folds out of the join.

export type RailService = Readonly<{ serviceName: string; podCount: number; avgCpuLimitUtilization: number | null }>

const maxOrNull = (left: number | null, right: number | null): number | null =>
	left === null ? right : right === null ? left : Math.max(left, right)

const byUtilizationThenName = (left: RailService, right: RailService): number => {
	const delta = (right.avgCpuLimitUtilization ?? -1) - (left.avgCpuLimitUtilization ?? -1)
	return delta !== 0 ? delta : left.serviceName.localeCompare(right.serviceName)
}

/** One row per service (pods add up, utilization takes the worst); kind "unknown" is unlinked. */
export const railState = (model: Model) => {
	const workloads = AsyncData.getOrElse(model.workloads.data, () => [])
	const services = [
		...workloads
			.filter((workload) => workload.workloadKind !== "unknown")
			.reduce((byService, workload) => {
				const existing = byService.get(workload.serviceName)
				return byService.set(
					workload.serviceName,
					existing === undefined
						? {
								serviceName: workload.serviceName,
								podCount: workload.podCount,
								avgCpuLimitUtilization: workload.avgCpuLimitUtilization,
							}
						: {
								serviceName: existing.serviceName,
								podCount: existing.podCount + workload.podCount,
								avgCpuLimitUtilization: maxOrNull(existing.avgCpuLimitUtilization, workload.avgCpuLimitUtilization),
							},
				)
			}, new Map<string, RailService>())
			.values(),
	].sort(byUtilizationThenName)
	const names = AsyncData.getOrElse(model.names.data, () => [])
	const isInitial = (data: AsyncData.AsyncData<unknown, unknown>) => AsyncData.isIdle(data) || AsyncData.isLoading(data)
	return {
		services,
		unlinkedCount:
			AsyncData.isSuccess(model.workloads.data) || AsyncData.isRefreshing(model.workloads.data)
				? Math.max(names.length - services.length, 0)
				: 0,
		isLoading: isInitial(model.names.data) || isInitial(model.workloads.data),
		isWaiting: AsyncData.isRefreshing(model.names.data) || AsyncData.isRefreshing(model.workloads.data),
	}
}

/** `ServiceLensRail`. */
export const lensRail = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	activeService: string | undefined,
	timeSearch: TimeSearch,
): Html => {
	const state = railState(model)
	return h.div(
		[
			h.Class(cn("flex h-full flex-col gap-0.5 p-3", refreshingClass(state.isWaiting))),
			...(state.isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			eyebrow(h, { as: "div", className: "px-2 pb-2.5" }, ["Services on this cluster"]),
			...(state.isLoading
				? [skeletonList(h, { rows: 6, rowClassName: "h-[22px]", className: "gap-1.5 px-2 pt-1" })]
				: state.services.length === 0
					? [
							h.p([h.Class("px-2 text-2xs leading-relaxed text-muted-foreground")], [
								"No service resolves to a Kubernetes workload in this window.",
							]),
						]
					: state.services.map((service) => railRow(h, service, service.serviceName === activeService, timeSearch))),
			...(state.unlinkedCount > 0
				? [
						h.div(
							[h.Class("mt-auto space-y-1.5 border-t px-2 pb-1 pt-3.5")],
							[
								h.div([h.Class("text-2xs text-foreground")], [
									String(state.unlinkedCount),
									" ",
									state.unlinkedCount === 1 ? "service" : "services",
									" not linked",
								]),
								h.p([h.Class("text-2xs leading-relaxed text-muted-foreground")], [
									"Their spans carry no workload identity, so the lens can't reach their pods.",
									" ",
									h.a(
										[
											h.Href(hrefOf(AppRoute.InfraKubernetesPods({ search: timeSearch }))),
											h.Class("text-primary hover:underline active:underline"),
										],
										["Browse pods directly"],
									),
									".",
								]),
							],
						),
					]
				: []),
		],
	)
}

const railRow = <M>(h: HtmlBuilder<M>, service: RailService, isActive: boolean, timeSearch: TimeSearch): Html => {
	const utilization = service.avgCpuLimitUtilization
	return h.a(
		[
			h.Key(service.serviceName),
			h.Href(hrefOf(AppRoute.InfraKubernetesService({ serviceName: service.serviceName, search: timeSearch }))),
			h.Class(
				cn(
					"flex h-[34px] items-center gap-2.5 rounded-md px-2 transition-colors",
					rowSelectedClass(isActive),
					!isActive && "hover:bg-surface-sunken active:bg-surface-sunken",
				),
			),
		],
		[
			serviceDot(h, { serviceName: service.serviceName, size: "sm" }),
			h.span(
				[
					h.Class(cn("min-w-0 flex-1 truncate font-mono text-xs", isActive ? "text-foreground" : "text-muted-foreground")),
					h.Title(service.serviceName),
				],
				[service.serviceName],
			),
			h.span(
				[
					h.Class(
						cn(
							"w-[38px] shrink-0 text-right font-mono text-2xs tabular-nums",
							utilization === null ? undefined : BAR_VALUE_TONE[severityLevel(utilization)],
						),
					),
				],
				[utilization === null ? EMPTY_VALUE : formatPercent(utilization)],
			),
			h.span([h.Class("w-[22px] shrink-0 text-right font-mono text-2xs tabular-nums text-muted-foreground")], [
				String(service.podCount),
			]),
		],
	)
}
