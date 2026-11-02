import type { GcpInfraNotice } from "../../../../components/infra/gcp/tabs"
import type { Html } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { alert, alertAction, alertDescription, alertTitle } from "../../../../ui/alert"
import { linkButton } from "../../../../ui/button"
import { icon } from "../../../../ui/icon"
import { spinner } from "../../../../ui/spinner"
import { gcpMessage } from "../gcp-message"
import type { H } from "./view-rows"

// `GcpNotice`: what the connections say, above the lists.

const integration = (h: H, label: string): Html =>
	alertAction(h, [
		linkButton(
			h,
			{
				size: "sm",
				variant: "outline",
				href: hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } })),
			},
			[label],
		),
	])

export const gcpNotice = (h: H, notice: GcpInfraNotice): Html => {
	switch (notice.kind) {
		case "failing":
			return alert(h, { variant: "warn" }, [
				icon(h, "CircleWarningIcon", { size: 16 }),
				alertTitle(h, ["Maple can't read Google Cloud metrics"]),
				alertDescription(h, [gcpMessage(h, notice.error)]),
				integration(h, "Check the connection"),
			])
		case "incomplete":
			return alert(h, { variant: "warn" }, [
				icon(h, "CircleWarningIcon", { size: 16 }),
				alertTitle(h, ["Some Google Cloud metrics are missing"]),
				alertDescription(h, [gcpMessage(h, notice.error)]),
			])
		case "stalled":
			return alert(h, { variant: "warn" }, [
				icon(h, "CircleWarningIcon", { size: 16 }),
				alertTitle(h, ["Google Cloud metrics have stalled"]),
				alertDescription(h, [
					"Maple has not read Cloud Monitoring for over 30 minutes. It retries on its own.",
				]),
			])
		case "waiting":
			return alert(h, { variant: "info", role: "status" }, [
				spinner(h, undefined, 16),
				alertTitle(h, ["Collecting your first Google Cloud metrics"]),
				alertDescription(h, [
					"Maple reads Cloud Monitoring every 5 minutes, about 5 minutes behind, so the first numbers land within about 10 minutes of the setup script. This page updates on its own.",
				]),
			])
		case "off":
			return alert(h, { role: "status" }, [
				icon(h, "CircleInfoIcon", { size: 16 }),
				alertTitle(h, ["Google Cloud metrics are off"]),
				alertDescription(h, [
					"These tables show what Maple collected before they were turned off. To collect again, turn on Metrics and resources under Configure in the Google Cloud integration, then run the setup script.",
				]),
				integration(h, "Open the integration"),
			])
		case "quiet":
			return alert(h, { variant: "info", role: "status" }, [
				icon(h, "CircleInfoIcon", { size: 16 }),
				alertTitle(h, ["No Google Cloud metrics in this window"]),
				alertDescription(h, ["Widen the time range, or reload to include the latest read."]),
			])
	}
}
