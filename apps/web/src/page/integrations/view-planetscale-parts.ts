import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"
import {
	metricsAuthOf,
	metricsHealthState,
	metricsLastCollectedAt,
	metricsLastError,
	type SetupStep,
} from "../../components/integrations/planetscale-setup-steps"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { spinner } from "../../ui/spinner"
import { statusDot } from "../../ui/status-dot"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"

// `PlanetScaleMetricsHealth`, `PlanetScaleSetupChecklist` and `PlanetScaleOrgPicker`.

type H = HtmlBuilder<Message>

export const QUIET_LINK =
	"text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"

const HEADLINE = new Map([
	["degraded", "Metrics collection degraded"],
	["stalled", "Metrics collection stalled"],
	["waiting", "Waiting for first metrics"],
	["healthy", "Metrics"],
])

export const metricsHealth = (
	h: H,
	model: Model,
	status: V2PlanetScaleIntegration,
	timeZone: string,
): Html => {
	const state = metricsHealthState(status, model.nowMs)
	if (state === "unconfigured") return h.empty
	const viaApi = metricsAuthOf(status) === "api"
	const lastAt = metricsLastCollectedAt(status)
	const excluded = status.scrape_target?.exclude_branches ?? []
	const isOpen = model.planetscaleCard.isDetailsOpen
	return h.div(
		[h.Class("border-t border-border/60 p-4")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2 text-xs")],
				[
					statusDot(h, {
						tone: state === "healthy" ? "ok" : state === "waiting" ? "neutral" : "warn",
					}),
					h.span([h.Class("font-medium text-foreground")], [HEADLINE.get(state) ?? ""]),
					h.span(
						[h.Class("text-muted-foreground")],
						[
							...(viaApi ? ["Polled from PlanetScale's metrics API every 5 minutes."] : []),
							...(state === "waiting"
								? [
										viaApi
											? " The first poll usually lands within 10 minutes."
											: "Branch metrics usually appear within a minute.",
									]
								: lastAt !== null
									? [
											...(viaApi ? [" "] : []),
											relativeTime(h, {
												value: lastAt,
												nowMs: model.nowMs,
												timeZone,
												prefix: state === "healthy" ? "Updated" : "Last data",
											}),
										]
									: []),
							...(state === "healthy" && excluded.length > 0
								? [" · excluding ", excluded.join(", ")]
								: []),
						],
					),
					...(state === "healthy"
						? [
								h.a(
									[
										h.Href(hrefOf(AppRoute.InfraPlanetscale({ search: {} }))),
										h.Class(QUIET_LINK),
									],
									["View databases"],
								),
							]
						: []),
					h.div(
						[h.Class("ml-auto flex items-center gap-2")],
						[
							...(state === "degraded"
								? [
										button(
											h,
											{
												variant: "link",
												size: "xs",
												className: `h-auto p-0 font-normal ${QUIET_LINK}`,
												attributes: [h.OnClick(Message.ClickedMetricsDetails())],
											},
											[isOpen ? "Hide details" : "Show details"],
										),
									]
								: []),
						],
					),
				],
			),
			...(state === "degraded" && isOpen
				? [
						h.p(
							[
								h.Class(
									"mt-2 break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground",
								),
							],
							[metricsLastError(status) ?? ""],
						),
					]
				: []),
		],
	)
}

/** `StepMarker`: done, blocked, current (a spinner while Maple works), else the step number. */
const stepMarker = (h: H, step: SetupStep, number: number): Html => {
	if (step.state === "done")
		return icon(h, "CircleCheckIcon", {
			size: 14,
			className: "mt-0.5 shrink-0 text-severity-info",
			attributes: [h.AriaHidden(true)],
		})
	if (step.state === "blocked")
		return icon(h, "CircleWarningIcon", {
			size: 14,
			className: "mt-0.5 shrink-0 text-severity-error",
			attributes: [h.AriaHidden(true)],
		})
	if (step.state === "current")
		return step.waitingOnMaple
			? spinner(h, "mt-0.5 shrink-0 text-muted-foreground", 14)
			: h.span(
					[
						h.AriaHidden(true),
						h.Class(
							"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-4xs font-medium text-primary-foreground",
						),
					],
					[String(number)],
				)
	return h.span(
		[
			h.AriaHidden(true),
			h.Class(
				"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border text-4xs font-medium text-muted-foreground",
			),
		],
		[String(number)],
	)
}

/** `PlanetScaleSetupChecklist`: the active step carries its action. */
export const setupChecklist = (
	h: H,
	steps: ReadonlyArray<SetupStep>,
	actionOf: (id: SetupStep["id"]) => Html | null,
): Html =>
	h.ol(
		[h.Class("flex flex-col")],
		steps.map((step, index) => {
			const action = step.state === "current" || step.state === "blocked" ? actionOf(step.id) : null
			return h.li(
				[h.Class("flex gap-3 border-b border-border/60 py-2.5 last:border-b-0 last:pb-0 first:pt-0")],
				[
					stepMarker(h, step, index + 1),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							h.div(
								[h.Class("flex flex-wrap items-baseline gap-x-2")],
								[
									h.span(
										[
											h.Class(
												cn(
													"text-xs font-medium",
													step.state === "pending"
														? "text-muted-foreground"
														: "text-foreground",
												),
											),
										],
										[step.title],
									),
									h.span(
										[
											h.Class(
												cn(
													"text-xs",
													step.state === "blocked"
														? "text-severity-error"
														: "text-muted-foreground",
												),
											),
										],
										[step.detail],
									),
								],
							),
							...(action === null ? [] : [h.div([h.Class("mt-2.5")], [action])]),
						],
					),
				],
			)
		}),
	)
