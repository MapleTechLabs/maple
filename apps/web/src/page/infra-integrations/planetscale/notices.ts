import type { SetupStep } from "../../../components/integrations/planetscale-setup-steps"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { spinner } from "../../../ui/spinner"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../kit/integration-empty"
import { relativeTime } from "../../kit/relative-time"

// PlanetScale absence notices, setup state and the setup checklist.

export const METRICS_PAUSED_MESSAGE = "Branch metrics are paused. Add a metrics token to collect them."
export const METRICS_PAUSED_SHORT = "metrics paused"
export const PLANETSCALE_COLOR = "oklch(0.62 0.02 270)"
export const BRANCH_ABSENCE_COPY = {
	excluded: "Excluded from metrics collection by this connection's branch filters.",
	"no-data": "No metrics for this branch in the selected window.",
} as const

const INTEGRATION_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "planetscale" } }))

export const metricsNotice = <M>(h: HtmlBuilder<M>): Html =>
	alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, ["Branch metrics aren't being collected"]),
		alertDescription(h, [
			"Databases and branches are up to date, and query insights still work. Connections, CPU, memory, storage, and replica lag need a PlanetScale service token with the read_metrics_endpoints permission.",
		]),
		alertAction(h, [
			linkButton(h, { size: "sm", variant: "outline", href: INTEGRATION_HREF }, [
				"Add a metrics token",
			]),
		]),
	])

export const revokedNotice = <M>(h: HtmlBuilder<M>): Html =>
	alert(h, { variant: "crit" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["PlanetScale authorization revoked"]),
		alertDescription(h, [
			"Maple can no longer read this organization, so databases, branches, and metrics are frozen at their last known state. Reconnecting restores them.",
		]),
		alertAction(h, [linkButton(h, { size: "sm", href: INTEGRATION_HREF }, ["Reconnect PlanetScale"])]),
	])

export const inventoryNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		lastInventoryAt: string | null
		lastInventoryError: string | null
		nowMs: number
		timeZone: string
	}>,
): Html => {
	const failing = options.lastInventoryError !== null
	return alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, [failing ? "Inventory refresh is failing" : "Inventory hasn't refreshed recently"]),
		alertDescription(
			h,
			failing
				? ["The database and branch list may be out of date. Metrics are unaffected."]
				: [
						"The database and branch list may be out of date. Last refreshed",
						" ",
						options.lastInventoryAt === null
							? "never"
							: relativeTime(h, {
									tooltip: "title",
									value: options.lastInventoryAt,
									nowMs: options.nowMs,
									timeZone: options.timeZone,
								}),
						".",
					],
		),
	])
}

const INVENTORY_STALE_MS = 90 * 60 * 1000

export const inventoryIsStale = (lastInventoryAt: string | null, nowMs: number): boolean =>
	lastInventoryAt !== null && nowMs - toEpochMs(lastInventoryAt) > INVENTORY_STALE_MS

const stepMarker = <M>(h: HtmlBuilder<M>, step: SetupStep, number: number): Html => {
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
	if (step.state === "current" && step.waitingOnMaple)
		return spinner(h, "mt-0.5 shrink-0 text-muted-foreground")
	return h.span(
		[
			h.AriaHidden(true),
			h.Class(
				step.state === "current"
					? "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-4xs font-medium text-primary-foreground"
					: "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-border text-4xs font-medium text-muted-foreground",
			),
		],
		[String(number)],
	)
}

const setupChecklist = <M>(h: HtmlBuilder<M>, steps: ReadonlyArray<SetupStep>, className: string): Html =>
	h.ol(
		[h.Class(cn("flex flex-col", className))],
		steps.map((step, index) =>
			h.li(
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
						],
					),
				],
			),
		),
	)

const BRAND = { icon: "PlanetScaleIcon", accent: PLANETSCALE_COLOR } as const

/** `PlanetScaleSetupState`: metrics have never arrived for this connection. */
export const setupState = <M>(h: HtmlBuilder<M>, steps: ReadonlyArray<SetupStep>): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Utilization",
				title: "CPU, memory, connections",
				description: "Per branch, scraped from PlanetScale on a schedule.",
			},
			{
				label: "Storage",
				title: "Disk headroom over time",
				description: "The slow-moving number nothing else in Maple reveals.",
			},
			{
				label: "Replication",
				title: "Replica lag per branch",
				description: "Catch a replica falling behind before your reads go stale.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, [
				"Branch metrics need one more step. PlanetScale only serves them to service tokens, so the OAuth authorization alone can't collect them.",
			]),
			setupChecklist(h, steps, "w-full max-w-md text-left"),
			linkButton(h, { href: INTEGRATION_HREF }, ["Finish setup"]),
			integrationEmptyFooter(h, [
				"One read-only permission · takes about a minute · your databases below are already live.",
			]),
		]),
	])
