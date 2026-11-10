import type { VercelDeploymentSummary } from "@maple/domain/http"
import { formatLatency, formatPercent } from "@maple/ui/lib/format"
import { Array as Arr, Order, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { deployLabel } from "../../../../components/infra/vercel/deploy-signals"
import { buildDurationMs } from "../../../../components/infra/vercel/list-model"
import { drainState, VERCEL_DRAINS } from "../../../../components/integrations/vercel-model"
import { AppRoute, hrefOf } from "../../../../route"
import { detailRailGroup, detailRailRow } from "@maple/views/ui/detail-rail"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { relativeTime } from "../../../kit/relative-time"
import { type Clock, dataOf } from "../view-parts"
import type { Overview } from "./derive"
import type { Message, Model } from "./model"

// `VercelOverviewRail`: the team, its drains, the deploys in the window and the team's activity.

type H = HtmlBuilder<Message>

const RAIL_DEPLOYS = 5
const RAIL_EVENTS = 3

const settingsHref = () => hrefOf(AppRoute.Integrations({ search: { integration: "vercel" } }))

const value = (h: H, text: string): Html =>
	typography(h, { size: "xs", tone: "foreground", mono: true, truncate: true }, [text])

const teamGroup = (h: H, o: Overview, clock: Clock): Html => {
	const { status } = o
	const forwarded = Arr.filter(status.projects, (project) => project.forwarded).length
	return detailRailGroup(h, "Team", [
		detailRailRow(h, { label: "Team" }, [value(h, status.team?.name ?? "")]),
		...(status.team?.plan === undefined || status.team.plan === null
			? []
			: [detailRailRow(h, { label: "Plan" }, [value(h, Str.capitalize(status.team.plan))])]),
		detailRailRow(h, { label: "Scope" }, [
			value(h, `${forwarded} of ${status.projects.length} projects`),
		]),
		detailRailRow(h, { label: "Sampling" }, [value(h, formatPercent(status.samplingRate))]),
		...(status.lastSuccessAt === null
			? []
			: [
					detailRailRow(h, { label: "Last sync" }, [
						relativeTime(h, {
							value: status.lastSuccessAt,
							...clock,
							mono: true,
							className: "text-xs",
						}),
					]),
				]),
	])
}

const drainsGroup = (h: H, o: Overview): Html =>
	detailRailGroup(h, "Drains", [
		...Arr.map(VERCEL_DRAINS, (drain) => {
			const state = drainState(o.status[drain.flag], o.status.drains[drain.key])
			return hstack(h, { gap: "2", justify: "between", className: "py-1" }, [
				hstack(h, { gap: "2", className: "shrink-0" }, [
					statusDot(h, { tone: state.tone }),
					typography(h, { size: "xs", tone: "foreground" }, [Str.capitalize(drain.name)]),
				]),
				typography(
					h,
					{
						size: "2xs",
						tone: state.tone === "crit" ? "error" : state.tone === "warn" ? "warning" : "muted",
						mono: true,
						truncate: true,
						attributes: [h.Title(state.label)],
					},
					[state.label],
				),
			])
		}),
		typography(h, { size: "2xs", className: "self-start" }, [
			textLink(h, { href: settingsHref() }, ["Edit drains"]),
		]),
	])

const deployMeta = (
	deployment: VercelDeploymentSummary,
	regressed: boolean,
): Readonly<{ text: string; warn: boolean }> => {
	const state = Str.toUpperCase(deployment.state)
	if (state === "ERROR")
		return {
			text: `build error · ${deployment.errorMessage ?? deployment.errorCode ?? "no reason given"}`,
			warn: true,
		}
	const build = buildDurationMs(deployment)
	const parts = [
		Str.toLowerCase(deployment.state),
		...(build === null ? [] : [`${formatLatency(build)} build`]),
		...(regressed ? ["5xx after deploy"] : []),
	]
	return { text: Arr.join(parts, " · "), warn: regressed }
}

const deploysGroup = (h: H, model: Model, o: Overview, clock: Clock): Html | null => {
	const deployments = dataOf(model.deployments.data)
	if (deployments === null) return null
	const regressed = new Set(Arr.map(o.regressions, (r) => r.deployment.id))
	const inWindow = Arr.take(
		Arr.sort(
			Arr.filter(deployments, (d) => d.createdAt >= o.window.startMs && d.createdAt <= o.window.endMs),
			Order.mapInput(Order.flip(Order.Number), (d: VercelDeploymentSummary) => d.createdAt),
		),
		RAIL_DEPLOYS,
	)
	return detailRailGroup(
		h,
		"Deploys in this window",
		inWindow.length === 0
			? [typography(h, { size: "2xs", tone: "muted", as: "p" }, ["No deploys in this window"])]
			: Arr.map(inWindow, (deployment) => {
					const meta = deployMeta(deployment, regressed.has(deployment.id))
					return vstack(h, { gap: "0.5", className: "py-1" }, [
						hstack(h, { gap: "2" }, [
							statusDot(h, { tone: meta.warn ? "warn" : "ok" }),
							typography(
								h,
								{ size: "xs", tone: "foreground", weight: "medium", truncate: true },
								[o.projectName(deployment.projectId)],
							),
							typography(h, { size: "3xs", tone: "muted", mono: true, className: "shrink-0" }, [
								deployLabel(deployment),
							]),
						]),
						...(deployment.commitMessage === null
							? []
							: [
									typography(
										h,
										{
											size: "2xs",
											tone: "soft",
											truncate: true,
											as: "p",
											className: "pl-3.5",
										},
										[deployment.commitMessage],
									),
								]),
						hstack(h, { gap: "1", className: "pl-3.5" }, [
							typography(
								h,
								{
									size: "3xs",
									tone: meta.warn ? "warning" : "muted",
									mono: true,
									truncate: true,
								},
								[`${meta.text} ·`],
							),
							relativeTime(h, {
								value: deployment.createdAt,
								...clock,
								variant: "short",
								mono: true,
								className: "shrink-0 text-3xs text-muted-foreground",
							}),
						]),
					])
				}),
	)
}

const activityGroup = (h: H, model: Model, o: Overview, clock: Clock): Html | null => {
	const events = dataOf(model.auditLog.data)
	if (!o.status.auditLogEnabled || events === null) return null
	const newest = Arr.take(
		Arr.sort(
			events,
			Order.mapInput(Order.flip(Order.String), (e: (typeof events)[number]) => e.timestamp),
		),
		RAIL_EVENTS,
	)
	return detailRailGroup(
		h,
		"Team activity",
		newest.length === 0
			? [typography(h, { size: "2xs", tone: "muted", as: "p" }, ["No team activity in this window"])]
			: Arr.map(newest, (event) =>
					vstack(h, { gap: "0.5", className: "py-1" }, [
						typography(h, { size: "xs", tone: "foreground", mono: true, truncate: true }, [
							event.action,
						]),
						hstack(h, { gap: "1" }, [
							typography(h, { size: "3xs", tone: "muted", truncate: true }, [
								`${event.actor} · ${event.projectId === "" ? "team" : o.projectName(event.projectId)} ·`,
							]),
							relativeTime(h, {
								value: event.timestamp,
								...clock,
								variant: "short",
								mono: true,
								className: "shrink-0 text-3xs text-muted-foreground",
							}),
						]),
					]),
				),
	)
}

export const overviewRail = (h: H, model: Model, o: Overview, clock: Clock): Html =>
	vstack(
		h,
		{},
		Arr.filter(
			[
				teamGroup(h, o, clock),
				drainsGroup(h, o),
				deploysGroup(h, model, o, clock),
				activityGroup(h, model, o, clock),
			],
			(group): group is Html => group !== null,
		),
	)
