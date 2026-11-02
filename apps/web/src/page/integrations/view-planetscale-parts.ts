import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import {
	metricsAuthOf,
	metricsHealthState,
	metricsLastCollectedAt,
	metricsLastError,
} from "../../components/integrations/planetscale-setup-steps"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button } from "@maple/views/ui/button"
import { statusDot } from "@maple/views/ui/status-dot"
import { relativeTime } from "../kit/relative-time"
import { Message } from "./message"
import type { Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { strip } from "@maple/views/ui/rule"

// `PlanetScaleMetricsHealth`.

type H = HtmlBuilder<Message>

export const QUIET_LINK =
	"text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground active:text-foreground"

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
	return strip(h, { kind: "block" },
		[
			hstack(h, { gap: "2", wrap: true, className: typographyClass({ size: "xs" }) }, [
				statusDot(h, {
					tone: state === "healthy" ? "ok" : state === "waiting" ? "neutral" : "warn",
				}),
				typography(h, { tone: "foreground", weight: "medium" }, [HEADLINE.get(state) ?? ""]),
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
				hstack(h, { gap: "2", className: "ml-auto" }, [
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
				]),
			]),
			...(state === "degraded" && isOpen
				? [
						h.p(
							[
								h.Class(
									"mt-2 break-all rounded-md bg-surface-sunken p-2 font-mono text-xs text-muted-foreground",
								),
							],
							[metricsLastError(status) ?? ""],
						),
					]
				: []),
		],
	)
}
