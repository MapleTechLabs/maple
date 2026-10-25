import { Metric } from "effect"

/** Per (org, account, dataset): how far the slowest enabled zone's watermark trails now. */
export const datasetLagSeconds = Metric.gauge("cloudflare_analytics.dataset_lag_seconds", {
	description: "Seconds the oldest watermark of a Cloudflare analytics dataset trails now, set each poll",
})
