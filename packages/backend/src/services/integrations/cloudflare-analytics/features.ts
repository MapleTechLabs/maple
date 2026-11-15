import { CloudflareFeatureSwitches } from "@maple/domain/http"
import type { IntegrationFeatureId } from "@maple/domain/integration-features"
import { Array as Arr, Record as Rec } from "effect"
import {
	DNS_DATASET,
	DO_DATASET,
	FIREWALL_DATASET,
	HTTP_DATASET,
	HTTP_DIMENSIONS_DATASET,
	HTTP_PATHS_DATASET,
	QUEUE_BACKLOG_DATASET,
	QUEUE_CONSUMERS_DATASET,
	WORKERS_DATASET,
} from "./queries"

/** The GraphQL analytics datasets each Cloudflare feature switch collects. */
export const CLOUDFLARE_FEATURE_DATASETS = {
	httpTraffic: [HTTP_DATASET, HTTP_PATHS_DATASET, HTTP_DIMENSIONS_DATASET],
	firewall: [FIREWALL_DATASET],
	dns: [DNS_DATASET],
	workers: [WORKERS_DATASET],
	queues: [QUEUE_BACKLOG_DATASET, QUEUE_CONSUMERS_DATASET],
	durableObjects: [DO_DATASET],
} as const satisfies Record<IntegrationFeatureId<"cloudflare">, ReadonlyArray<string>>

/** Every feature on: an org that never changed a switch. */
export const ALL_CLOUDFLARE_FEATURES = new CloudflareFeatureSwitches({
	httpTrafficEnabled: true,
	firewallEnabled: true,
	dnsEnabled: true,
	workersEnabled: true,
	queuesEnabled: true,
	durableObjectsEnabled: true,
})

/** The datasets the poller leaves alone: those of every switched-off feature. */
export const disabledDatasets = (switches: CloudflareFeatureSwitches): ReadonlySet<string> =>
	new Set(
		Arr.flatMap(Rec.toEntries(CLOUDFLARE_FEATURE_DATASETS), ([id, datasets]) =>
			switches[`${id}Enabled`] ? [] : datasets,
		),
	)

/** Whether any feature is still on, so the account is worth a call. */
export const anyFeatureOn = (switches: CloudflareFeatureSwitches): boolean =>
	Arr.some(Rec.keys(CLOUDFLARE_FEATURE_DATASETS), (id) => switches[`${id}Enabled`])
