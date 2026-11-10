import type { VercelIntegrationStatus } from "@maple/domain/http"
import { formatErrorRate, formatLatency, formatPercent } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { detailRailGroup, detailRailMetaRow } from "@maple/views/ui/detail-rail"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { type ToneBar, toneBars } from "@maple/views/ui/tone-bars"
import { typography } from "@maple/views/ui/typography"
import { deployLabel } from "../../../../components/infra/vercel/deploy-signals"
import {
	type BuildOutcome,
	buildTimes,
	slowestFunctions,
	topDependencies,
} from "../../../../components/infra/vercel/project-rail"
import { percentOf } from "../../../../components/integrations/vercel-model"
import { relativeTime } from "../../../kit/relative-time"
import { type Clock, dataOf } from "../view-parts"
import type { Message, Model } from "./model"

// `VercelProjectRail`: the project's facts, its slowest functions, the hosts it calls and its
// recent build times, on every tab.

type H = HtmlBuilder<Message>

const note = (h: H, text: string): Html =>
	typography(h, { size: "2xs", tone: "muted", as: "p", className: "leading-relaxed" }, [text])

const railLoading = (h: H): ReadonlyArray<Html> => [skeleton(h, "h-4 w-full"), skeleton(h, "h-4 w-2/3")]

/**
 * A group over one read: a skeleton while it loads, nothing when it failed (the tab that owns the
 * read says so) or its drain is off.
 */
const readGroup = <A>(
	h: H,
	label: string,
	data: AsyncData.AsyncData<A, LoadFailure>,
	body: (value: A) => ReadonlyArray<Html>,
): ReadonlyArray<Html> =>
	AsyncData.match(data, {
		onIdle: () => [],
		onLoading: () => [detailRailGroup(h, label, railLoading(h))],
		onFailure: () => [],
		onStale: () => [],
		onSuccess: (value) => [detailRailGroup(h, label, body(value))],
		onRefreshing: (value) => [detailRailGroup(h, label, body(value))],
	})

/** A route or host, then its figures: the rail's three-column row. */
const figureRow = (h: H, key: string, figures: ReadonlyArray<Html>): Html =>
	hstack(h, { gap: "3", align: "baseline", className: "py-1", attributes: [h.Key(key)] }, [
		typography(
			h,
			{
				size: "2xs",
				tone: "foreground",
				mono: true,
				truncate: true,
				className: "min-w-0 flex-1",
				attributes: [h.Title(key)],
			},
			[key],
		),
		...figures,
	])

const figure = (h: H, text: string, tone: "soft" | "muted" | "warning" = "soft"): Html =>
	typography(h, { size: "2xs", tone, mono: true, numeric: true, className: "shrink-0" }, [text])

const forwarding = (status: VercelIntegrationStatus): string => {
	const drains = Arr.filter(
		[
			["logs", status.logsEnabled],
			["traces", status.tracesEnabled],
			["AI Gateway", status.aiGatewayEnabled],
			["vitals", status.speedInsightsEnabled],
			["analytics", status.webAnalyticsEnabled],
		] as const,
		([, on]) => on,
	)
	return drains.length === 0
		? "nothing"
		: Arr.join(
				Arr.map(drains, ([name]) => name),
				", ",
			)
}

const projectGroup = (h: H, model: Model, clock: Clock): Html => {
	const status = dataOf(model.status.data)
	if (status === null) return detailRailGroup(h, "Project", railLoading(h))
	const project = Arr.findFirst(status.projects, (p) => p.id === model.projectId)
	const framework = project._tag === "Some" ? project.value.framework : null
	const production = project._tag === "Some" ? project.value.productionDeployment : null
	return detailRailGroup(
		h,
		"Project",
		Arr.filter(
			[
				detailRailMetaRow(h, { label: "framework", value: framework }),
				detailRailMetaRow(h, {
					label: "production",
					value: production?.url,
					display:
						production === null
							? undefined
							: textLink(
									h,
									{
										href: `https://${production.url}`,
										tone: "inherit",
										attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
									},
									[production.url],
								),
				}),
				detailRailMetaRow(h, {
					label: "deployed",
					value: production === null ? null : deployLabel(production),
					display:
						production === null
							? undefined
							: relativeTime(h, { value: production.createdAt, ...clock, variant: "short" }),
				}),
				detailRailMetaRow(h, { label: "forwarding", value: forwarding(status) }),
			],
			(row): row is Html => row !== null,
		),
	)
}

const BAR_TONE = { ready: "ok", failed: "crit", canceled: "neutral" } as const satisfies Record<
	BuildOutcome,
	ToneBar["tone"]
>

const buildGroup = (h: H, model: Model): ReadonlyArray<Html> =>
	readGroup(h, "Build time", model.deployments.data, (deployments) => {
		const times = buildTimes(deployments)
		if (times.bars.length === 0) return [note(h, "No finished builds yet")]
		const caption = [
			times.medianMs === null ? null : `median ${formatLatency(times.medianMs)}`,
			times.failed === 0 ? null : `${times.failed} failed`,
			times.canceled === 0 ? null : `${times.canceled} canceled`,
		]
		return [
			toneBars(h, {
				label: `Build times of the last ${times.bars.length} builds`,
				bars: Arr.map(times.bars, (bar) => ({
					key: bar.deployment.id,
					value: bar.durationMs ?? 0,
					tone: BAR_TONE[bar.outcome],
					title: `${deployLabel(bar.deployment)} · ${bar.outcome} · ${bar.durationMs === null ? "no time" : formatLatency(bar.durationMs)}`,
				})),
			}),
			typography(h, { size: "3xs", tone: "muted", mono: true }, [
				Arr.join(
					Arr.filter(caption, (part): part is string => part !== null),
					" · ",
				),
			]),
		]
	})

/** `VercelProjectRail`. */
export const projectRail = (h: H, model: Model, clock: Clock, serviceMapHref: string): Html => {
	const tracesOff = dataOf(model.status.data)?.tracesEnabled === false
	return vstack(h, {}, [
		projectGroup(h, model, clock),
		...(tracesOff
			? []
			: [
					...readGroup(h, "Slowest functions", model.functions.data, (functions) =>
						functions.length === 0
							? [note(h, "No function invocations in this window")]
							: Arr.map(slowestFunctions(functions), (fn) => {
									const cold = percentOf(fn.coldStarts, fn.invocations)
									return figureRow(h, fn.route === "" ? "(no route)" : fn.route, [
										figure(h, formatLatency(fn.p95DurationMs)),
										figure(h, cold === null ? "0%" : formatPercent(cold / 100), "muted"),
									])
								}),
					),
					...readGroup(h, "Calls out to", model.dependencies.data, (dependencies) => [
						...(dependencies.length === 0
							? [note(h, "No outbound calls in this window")]
							: Arr.map(topDependencies(dependencies), (dependency) => {
									const rate =
										dependency.calls > 0 ? dependency.errors / dependency.calls : 0
									return figureRow(h, dependency.host, [
										figure(h, formatLatency(dependency.p95DurationMs)),
										figure(h, formatErrorRate(rate), rate >= 0.01 ? "warning" : "muted"),
									])
								})),
						typography(h, { size: "2xs", className: "pt-1" }, [
							textLink(h, { href: serviceMapHref, tone: "muted" }, ["Service map"]),
						]),
					]),
				]),
		...buildGroup(h, model),
	])
}
