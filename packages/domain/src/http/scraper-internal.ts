import { Schema } from "effect"
import { ScrapeIntervalSeconds, ScrapeTargetId } from "../primitives"

/**
 * Internal contract between the apps/api scrape-target store and the
 * standalone Prometheus scraper (apps/scraper). Both endpoints are
 * authenticated with the `SD_INTERNAL_TOKEN` bearer.
 */

export class InternalScrapeTarget extends Schema.Class<InternalScrapeTarget>("InternalScrapeTarget")({
	id: ScrapeTargetId,
	orgId: Schema.String,
	name: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	url: Schema.String,
	scrapeIntervalSeconds: ScrapeIntervalSeconds,
	/** Parsed `labelsJson` — extra metric attributes configured on the target. */
	labels: Schema.Record(Schema.String, Schema.String),
}) {}

export const InternalScrapeTargetList = Schema.Array(InternalScrapeTarget)

export class ScrapeResultReport extends Schema.Class<ScrapeResultReport>("ScrapeResultReport")({
	targetId: ScrapeTargetId,
	/** Epoch milliseconds at which the scrape was attempted. */
	scrapedAt: Schema.Number,
	/** Null on success; pretty-printed failure otherwise. */
	error: Schema.NullOr(Schema.String),
}) {}

export const ScrapeResultReportList = Schema.Array(ScrapeResultReport)
