import { Effect } from "effect"
import { defaultHandlers } from "../../backend/defaults.ts"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { defaultDataset } from "../datasets/default.ts"
import { acmeAdmin, FROZEN_NOW } from "../identity.ts"
import { emptyTelemetry } from "../telemetry/rows.ts"
import { alertWriteEndpoints } from "./ops/alert-writes.ts"
import { alertEndpoints } from "./ops/alerts.ts"
import { anomalyDatasetEndpoints } from "./ops/anomalies.ts"
import { dashboardEndpoints, opsDashboards } from "./ops/dashboards.ts"
import { investigationDatasetEndpoints, investigationRows } from "./ops/investigations.ts"
import { miscDatasetEndpoints, miscEndpoints } from "./ops/misc.ts"
import { releaseEndpoints } from "./ops/releases.ts"
import { replayEndpoints } from "./ops/replays.ts"
import { webAnalyticsEndpoints } from "./ops/web-analytics.ts"
import { seedWebSessions } from "./ops/web-seed.ts"
import { ACME_WEB_ORG } from "./ops/web-sessions.ts"

/**
 * Operations areas (alerts, dashboards, anomalies, releases, investigations, recommendations,
 * analytics, replays, share). Their extra Postgres rows and Postgres-backed answers live on
 * `acme-ops`, a copy of `default` (same org, so the same warehouse), so routes captured on
 * `default` keep their pixels.
 */

export const ACME_OPS_DATASET = "acme-ops"

const acmeOps: Dataset = {
	...defaultDataset,
	name: ACME_OPS_DATASET,
	synced: {
		...defaultDataset.synced,
		dashboards: [...(defaultDataset.synced.dashboards ?? []), ...opsDashboards],
		investigation_v2: investigationRows,
	},
}

export const ACME_WEB_DATASET = "acme-web"

/**
 * Acme's storefront browser sessions (web analytics, session replays). Its own org, so the
 * session tables never reach the signal presence or pages of the `default` org.
 */
const acmeWeb: Dataset = {
	name: ACME_WEB_DATASET,
	now: FROZEN_NOW,
	identity: { ...acmeAdmin, orgId: ACME_WEB_ORG },
	auth: "self_hosted",
	endpoints: {},
	synced: {},
	telemetry: emptyTelemetry,
}

/**
 * Seeded rows on `acme-ops`; other datasets keep the generic default where one exists, so this
 * area never changes what another dataset's routes see (reads with no default answer as seeded).
 */
const onAcmeOps = (
	handlers: Readonly<Record<string, EndpointHandler>>,
): Readonly<Record<string, EndpointHandler>> =>
	Object.fromEntries(
		Object.entries(handlers).map(([tag, handler]): [string, EndpointHandler] => [
			tag,
			(request) => {
				if (request.dataset.name === ACME_OPS_DATASET) return handler(request)
				const fallback = defaultHandlers.get(tag)
				return fallback === undefined ? handler(request) : fallback(request)
			},
		]),
	)

export const fixtureArea: FixtureArea = {
	area: "ops",
	endpoints: (warehouse) => {
		Effect.runSync(seedWebSessions)
		return {
			...alertEndpoints,
			...alertWriteEndpoints,
			...webAnalyticsEndpoints(warehouse),
			...replayEndpoints(warehouse),
			...dashboardEndpoints(warehouse),
			...releaseEndpoints(warehouse),
			...miscEndpoints,
			...onAcmeOps({
				...anomalyDatasetEndpoints(warehouse),
				...investigationDatasetEndpoints,
				...miscDatasetEndpoints,
			}),
		}
	},
	datasets: [acmeOps, acmeWeb],
}
