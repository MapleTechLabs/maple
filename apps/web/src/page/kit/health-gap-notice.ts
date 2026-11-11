import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"

// Service health is the overview joined with firing alerts and baseline anomalies. A failed one of
// the two reads as none, so the page is not held back; this says which one is missing.

/** The health input that failed to load: firing alerts, baseline anomalies, or both. */
export type HealthGap = "alerts" | "anomalies" | "both"

/** Which of health's two inputs failed with nothing to show; `null` while both are known or loading. */
export const healthGapOf = (
	incidents: AsyncData.AsyncData<unknown, unknown>,
	anomalies: AsyncData.AsyncData<unknown, unknown>,
): HealthGap | null => {
	const noAlerts = AsyncData.isFailure(incidents)
	const noAnomalies = AsyncData.isFailure(anomalies)
	return noAlerts && noAnomalies ? "both" : noAlerts ? "alerts" : noAnomalies ? "anomalies" : null
}

const COPY = {
	alerts: {
		title: "Couldn't load alert status",
		description: "Service health leaves out firing alerts.",
	},
	anomalies: {
		title: "Couldn't load anomalies",
		description: "Service health leaves out baseline anomalies.",
	},
	both: {
		title: "Couldn't load alert status or anomalies",
		description: "Service health is not known. Every service reads as healthy.",
	},
} satisfies Record<HealthGap, Readonly<{ title: string; description: string }>>

/** The warning above a health summary computed without its alerts or anomalies. */
export const healthGapNotice = <M>(h: HtmlBuilder<M>, gap: HealthGap, className?: string): Html =>
	alert(h, { variant: "warn", size: "sm", role: "status", className }, [
		alertTitle(h, [COPY[gap].title]),
		alertDescription(h, [COPY[gap].description]),
	])
