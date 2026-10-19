import { LOCAL_ORG_ID } from "@maple/query-engine/local"
import type { FixtureArea } from "../areas.ts"
import type { Dataset } from "../dataset.ts"
import { FROZEN_NOW, FROZEN_NOW_MS } from "../identity.ts"
import { acmeShopTelemetry } from "../telemetry/acme-shop.ts"
import { emptyTelemetry, formatMicros, formatSeconds } from "../telemetry/rows.ts"

/**
 * Local mode (`maple start` + apps/local-ui): no sign-in, every row under OrgId `local`, served by
 * `src/backend/local.ts`. The cloud warehouse and HttpApis are never called.
 */
const localDataset = (name: string, local: Dataset["local"]): Dataset => ({
	name,
	now: FROZEN_NOW,
	identity: null,
	auth: "self_hosted",
	endpoints: {},
	synced: {},
	telemetry: emptyTelemetry,
	local,
})

/** Acme Shop's last 24 h; the last batch arrived 20 s ago, so the pill reads "Receiving". */
export const localDefaultDataset = localDataset("local", {
	database: "parity_local_default",
	rows: acmeShopTelemetry({
		orgId: LOCAL_ORG_ID,
		now: new Date(FROZEN_NOW),
		hours: 24,
		peakTracesPerMinute: 6,
		seed: 7,
	}),
	lastIngestAt: new Date(FROZEN_NOW_MS - 20_000).toISOString(),
})

/** A server that just started: nothing ingested yet. */
export const localEmptyDataset = localDataset("local-empty", {
	database: "parity_local_empty",
	rows: emptyTelemetry,
	lastIngestAt: null,
})

const jsonLogMicros = (FROZEN_NOW_MS - 60_000) * 1000

/** One log whose attribute holds JSON, for the chip card's collapsible JSON view. */
export const localJsonDataset = localDataset("local-json", {
	database: "parity_local_json",
	rows: {
		...emptyTelemetry,
		logs: [
			{
				OrgId: LOCAL_ORG_ID,
				Timestamp: formatMicros(jsonLogMicros),
				TimestampTime: formatSeconds(jsonLogMicros),
				TraceId: "",
				SpanId: "",
				TraceFlags: 0,
				SeverityText: "INFO",
				SeverityNumber: 9,
				ServiceName: "checkout-api",
				Body: "order placed",
				ResourceSchemaUrl: "",
				ResourceAttributes: { "service.name": "checkout-api" },
				ScopeSchemaUrl: "",
				ScopeName: "maple-seed-demo",
				ScopeVersion: "1.0.0",
				ScopeAttributes: {},
				LogAttributes: { "order.payload": '{"orderId":"ord_1042","items":[{"sku":"tea-01","qty":2}],"total":18.5}' },
			},
		],
	},
	lastIngestAt: new Date(FROZEN_NOW_MS - 20_000).toISOString(),
})

export const fixtureArea: FixtureArea = {
	area: "local",
	datasets: [localDefaultDataset, localEmptyDataset, localJsonDataset],
}
