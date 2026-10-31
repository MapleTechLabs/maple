import { Metric } from "effect"

export const scrapesTotal = Metric.frequency("scraper.scrapes_total", {
	description: "Completed Prometheus scrapes by outcome",
})

export const scrapeDurationMs = Metric.histogram("scraper.scrape_duration_ms", {
	description: "End-to-end scrape duration in milliseconds",
	boundaries: Metric.exponentialBoundaries({
		start: 10,
		factor: 2,
		count: 16,
	}),
})

export const activeTargets = Metric.gauge("scraper.active_targets", {
	description: "Currently active scrape target loops",
})

export const bufferedResults = Metric.gauge("scraper.buffered_results", {
	description: "Scrape results waiting to be reported to the API",
})

/** Attributed per check with `kind` (http, tcp, dns) and `ok` ("true" / "false"). */
export const uptimeChecksTotal = Metric.counter("scraper.uptime_checks_total", {
	description: "Completed uptime checks by monitor kind and outcome",
	incremental: true,
})

export const activeMonitors = Metric.gauge("scraper.uptime_active_monitors", {
	description: "Currently active uptime monitor loops",
})

export const bufferedUptimeResults = Metric.gauge("scraper.uptime_buffered_results", {
	description: "Uptime check results waiting to be reported to the API",
})

export const bufferedUptimeSpans = Metric.gauge("scraper.uptime_buffered_spans", {
	description: "Uptime check spans waiting to be exported to the ingest gateway",
})
