import {
	type CloudflareIngestPhase,
	cloudflareIngestPhase,
	describeCloudflareIngestPhase,
} from "../../../components/infra/cloudflare/ingest-phase"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { spinner } from "../../../ui/spinner"
import { integrationLinkActions, integrationNotConnected } from "../kit/empty-states"
import type { Status, Usage } from "./data"

// `CloudflareIngestBanner`, `CloudflareIngestEmpty`, `CloudflareStalledAction`
// and the missing-permissions empty state.

/** `useCloudflareIngestPhase`'s phase: null without a usable connection. */
export const ingestPhaseOf = (
	status: Status | null,
	usage: Usage | null,
	nowMs: number,
): CloudflareIngestPhase | null =>
	status !== null && status.connected ? cloudflareIngestPhase(status, usage, nowMs) : null

const isWorking = (phase: CloudflareIngestPhase): boolean =>
	phase.kind === "discovering" || phase.kind === "collecting" || phase.kind === "backfilling"

/** Nothing once everything is live. */
export const ingestBanner = <M>(h: HtmlBuilder<M>, phase: CloudflareIngestPhase): Html | null => {
	if (phase.kind === "live") return null
	const { title, description, tone } = describeCloudflareIngestPhase(phase)
	return alert(h, { variant: tone }, [
		isWorking(phase)
			? spinner(h, undefined, 16)
			: icon(h, tone === "warn" ? "CircleWarningIcon" : "CircleInfoIcon", { size: 16 }),
		alertTitle(h, [title]),
		alertDescription(h, [description]),
	])
}

export const ingestEmpty = <M>(h: HtmlBuilder<M>, phase: CloudflareIngestPhase): Html => {
	const { title, description } = describeCloudflareIngestPhase(phase)
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [
					isWorking(phase)
						? spinner(h, undefined, 16)
						: icon(h, "CloudflareBrandIcon", { size: 16 }),
				]),
				emptyTitle(h, [title]),
				emptyDescription(h, [description]),
			]),
			...(phase.kind === "stalled"
				? [
						emptyContent(h, [
							integrationLinkActions(h, {
								integration: "cloudflare",
								actionLabel: "Check the connection",
								actionVariant: "outline",
								docsPage: "cloudflare",
							}),
						]),
					]
				: []),
		],
		"py-16",
	)
}

/** Connected without the analytics scopes: reconnecting re-grants them. */
export const needsPermissions = <M>(h: HtmlBuilder<M>): Html =>
	integrationNotConnected(h, {
		icon: icon(h, "CloudflareBrandIcon", { size: 16 }),
		title: "Update Cloudflare permissions",
		description:
			"Your Cloudflare connection is missing the analytics read scopes. Reconnect to grant them and analytics polling will start automatically.",
		integration: "cloudflare",
		actionLabel: "Reconnect Cloudflare",
		docsPage: "cloudflare",
	})
