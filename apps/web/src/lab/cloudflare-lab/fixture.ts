import { OrgId } from "@maple/domain"
import {
	CloudflareAnalyticsZoneStatus,
	CloudflareConnectedAccountStatus,
	CloudflareIntegrationStatus,
} from "@maple/domain/http"
import { cloudflareAccounts } from "../../components/infra/cloudflare/accounts"
import { mergeWorkerRows } from "../../components/infra/cloudflare/list-model"
import {
	DEMO_ACCOUNT_STATUSES,
	DEMO_DURABLE_OBJECTS,
	DEMO_NOW,
	DEMO_WORKERS,
	MAKI_ACCOUNT_ID,
	MAKI_DURABLE_OBJECTS,
	MAKI_QUEUES,
	MAKI_WORKERS,
	MAKI_ZONE_SPARKS,
	MAKI_ZONES,
	MAPLE_API_DETAIL,
	MAPLE_API_RELEASES,
	MAPLE_DEV_CACHE,
	MAPLE_DEV_PATHS,
	MAPLE_DEV_ROW,
	MAPLE_DEV_STATUS,
} from "../cloudflare-fixture"
import { Schema } from "effect"
import { AsyncData, type Command } from "foldkit"
import type { Keyed } from "../../data/keyed"
import type { PageContext } from "../../page/contract"
import type { Resources } from "../../platform/resources"
import type { ListFrame } from "../../page/infra-integrations/cloudflare/list/view"
import type { Model as WorkerModel } from "../../page/infra-integrations/cloudflare/worker/model"
import type { Model as ZoneModel } from "../../page/infra-integrations/cloudflare/zone/model"

// The Cloudflare fixture as the Cloudflare pages' slots: a copy of production data.

/** The pages run against a fixture org; their fetch Commands are dropped, so it is never asked. */
export const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_cloudflare"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

export const ACCOUNT_NAME = "Maki Account"

/** The window the fixtures cover (the breakdown's `startTime`/`endTime`). */
const WINDOW = { startTime: "2026-10-14 00:00:00", endTime: "2026-10-14 12:00:00" }

const loaded = <A, E>(data: A): Keyed<A, E> => ({ key: null, data: AsyncData.Success({ data }) })

/** `ListPage`'s props: one account, or the three-account demo split. */
export const listFrame = (multiAccount: boolean): ListFrame => ({
	data: {
		zones: MAKI_ZONES,
		sparks: MAKI_ZONE_SPARKS,
		workerRows: multiAccount
			? mergeWorkerRows(DEMO_WORKERS, DEMO_DURABLE_OBJECTS)
			: mergeWorkerRows(MAKI_WORKERS, MAKI_DURABLE_OBJECTS),
		platform: {
			queues: multiAccount ? MAKI_QUEUES.map((q) => ({ ...q, accountId: "acct-maple" })) : MAKI_QUEUES,
			durableObjects: [],
		},
	},
	accounts: multiAccount ? cloudflareAccounts(DEMO_ACCOUNT_STATUSES, DEMO_NOW) : [],
	singleAccountName: ACCOUNT_NAME,
	banner: null,
	inPlaceViews: true,
})

/** One account holding maple.dev: the zone page's plain "account" chip and rail name. */
const ZONE_STATUS = new CloudflareIntegrationStatus({
	connected: true,
	accountId: MAKI_ACCOUNT_ID,
	accountName: ACCOUNT_NAME,
	connectedByUserId: null,
	scope: "analytics",
	analyticsCapable: true,
	accounts: [
		new CloudflareConnectedAccountStatus({
			accountId: MAKI_ACCOUNT_ID,
			accountName: ACCOUNT_NAME,
			connectedByUserId: null,
			scope: "analytics",
			analyticsCapable: true,
			revoked: false,
			zones: [
				new CloudflareAnalyticsZoneStatus({
					id: MAPLE_DEV_ROW.zoneName,
					name: MAPLE_DEV_ROW.zoneName,
					enabled: true,
					lastSyncedAt: DEMO_NOW,
					lastError: null,
					watermarkAt: DEMO_NOW,
				}),
			],
			workers: null,
		}),
	],
	zones: [],
	workers: null,
})

const WORKER_STATUS = new CloudflareIntegrationStatus({
	connected: true,
	accountId: MAKI_ACCOUNT_ID,
	accountName: ACCOUNT_NAME,
	connectedByUserId: null,
	scope: "analytics",
	analyticsCapable: true,
	accounts: [],
	zones: [],
	workers: null,
})

/** The rail's DNS: 4.4M queries, 4 names that only NXDOMAIN. */
const MAPLE_DEV_DNS = {
	buckets: [{ bucket: "2026-10-14 00:00:00", responseCode: "NOERROR", queries: 4_400_000 }],
	names: ["a", "b", "c", "d"].map((name) => ({
		queryName: `${name}.maple.dev`,
		queries: 1,
		nxdomain: 1,
	})),
	ignoredFilters: [],
}

/** `ZonePage`'s reads, held whatever the page asked for. */
export const pinZone = (model: ZoneModel): ZoneModel => ({
	...model,
	window: WINDOW,
	nowMs: DEMO_NOW,
	status: loaded(ZONE_STATUS),
	usage: { key: null, data: AsyncData.Idle() },
	detail: loaded({
		statusBuckets: MAPLE_DEV_STATUS,
		cacheBuckets: MAPLE_DEV_CACHE,
		latencyBuckets: [],
		ignoredFilters: [],
		latencyIgnoredFilters: [],
	}),
	dns: loaded(MAPLE_DEV_DNS),
	security: loaded({ buckets: [], top: [], ignoredFilters: [] }),
	zones: loaded([MAPLE_DEV_ROW]),
	breakdown: loaded(MAPLE_DEV_PATHS),
})

/** `WorkerPage`'s reads: maple-api's rollup, outcomes and releases. */
export const pinWorker = (model: WorkerModel): WorkerModel => ({
	...model,
	// Deploys snap to 30-minute buckets from 00:00; a 48h window is what buckets so.
	window: { startTime: WINDOW.startTime, endTime: "2026-10-16 00:00:00" },
	nowMs: DEMO_NOW,
	status: loaded(WORKER_STATUS),
	usage: { key: null, data: AsyncData.Idle() },
	detail: loaded(MAPLE_API_DETAIL),
	workers: loaded(MAKI_WORKERS),
	platform: loaded({ queues: MAKI_QUEUES, durableObjects: MAKI_DURABLE_OBJECTS }),
	releases: loaded(MAPLE_API_RELEASES.map((release) => ({ ...release, serviceName: "maple-api" }))),
})

/** The pages' own UI Commands (charts, popovers, focus), without their warehouse and API reads. */
export const withoutReads = <M>(
	commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined,
): ReadonlyArray<Command.Command<M, never, Resources>> =>
	(commands ?? []).filter((command) => !/^(Resolve|Load|Fetch|Complete)Cloudflare/.test(command.name))
