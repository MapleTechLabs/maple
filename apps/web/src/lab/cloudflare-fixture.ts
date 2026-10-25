import {
	CloudflareAnalyticsWorkersStatus,
	CloudflareAnalyticsZoneStatus,
	CloudflareConnectedAccountStatus,
} from "@maple/domain/http"
import type {
	CloudflareDurableObjectRow,
	CloudflareQueueRow,
	CloudflareWorkerDetail,
	CloudflareWorkerRow,
	CloudflareZoneBreakdown,
	CloudflareZoneCacheBucket,
	CloudflareZoneRow,
	CloudflareZoneStatusBucket,
} from "@maple/web-data/warehouse/cloudflare-infra"

// maple.dev, 2026-10-14 00:00-10:00 UTC, 30-minute buckets, copied from production.
// [time, 2xx, 3xx, 4xx, 5xx]
const STATUS: ReadonlyArray<readonly [string, number, number, number, number]> = [
	["00:00", 268537, 9072, 1754335, 0],
	["00:30", 259274, 1575, 1720724, 2],
	["01:00", 485311, 662, 16968973, 0],
	["01:30", 465244, 64, 16335169, 0],
	["02:00", 407078, 66, 11182308, 15],
	["02:30", 428669, 2451, 10258975, 0],
	["03:00", 423300, 100, 10666055, 0],
	["03:30", 370272, 47977, 8813201, 0],
	["04:00", 334933, 77, 9375689, 4],
	["04:30", 382471, 14, 7270122, 1],
	["05:00", 392664, 3003, 5624287, 4],
	["05:30", 361020, 528, 4640378, 0],
	["06:00", 360002, 841, 4517713, 0],
	["06:30", 316615, 963, 3745596, 0],
	["07:00", 340219, 1379, 3940601, 0],
	["07:30", 389541, 198, 3680267, 9],
	["08:00", 359969, 72, 3036225, 0],
	["08:30", 313213, 138, 3127589, 0],
	["09:00", 350426, 19639, 2826257, 0],
	["09:30", 342024, 14311, 2505267, 0],
	["10:00", 322741, 1355, 3053229, 0],
]

// [time, none, dynamic, hit, miss, expired]
const CACHE: ReadonlyArray<readonly [string, number, number, number, number, number]> = [
	["00:00", 1751591, 269197, 10324, 792, 40],
	["00:30", 1717252, 262575, 1714, 28, 2],
	["01:00", 16963404, 490103, 1144, 275, 0],
	["01:30", 16329207, 459805, 11444, 21, 0],
	["02:00", 11176629, 408956, 3863, 5, 14],
	["02:30", 10255027, 434262, 736, 66, 4],
	["03:00", 10659284, 429259, 820, 59, 33],
	["03:30", 8808824, 374915, 38775, 8925, 11],
	["04:00", 9369991, 340533, 139, 40, 0],
	["04:30", 7263832, 388515, 221, 40, 0],
	["05:00", 5617427, 398427, 3793, 187, 120],
	["05:30", 4635091, 366554, 241, 39, 1],
	["06:00", 4511801, 365530, 1150, 75, 0],
	["06:30", 3740684, 320956, 1514, 20, 0],
	["07:00", 3936288, 345532, 350, 11, 18],
	["07:30", 3675358, 393828, 785, 44, 0],
	["08:00", 2986568, 409235, 455, 8, 0],
	["08:30", 3122317, 317730, 874, 11, 8],
	["09:00", 2766046, 404922, 24633, 712, 0],
	["09:30", 2446713, 396731, 15873, 2283, 0],
	["10:00", 3048958, 324883, 3077, 407, 0],
]

const iso = (time: string) => `2026-10-14T${time}:00.000Z`

export const MAPLE_DEV_STATUS: ReadonlyArray<CloudflareZoneStatusBucket> = STATUS.flatMap(
	([time, ok, redirect, client, server]) =>
		(
			[
				["2xx", ok],
				["3xx", redirect],
				["4xx", client],
				["5xx", server],
			] as const
		).map(([statusClass, requests]) => ({ bucket: iso(time), statusClass, requests })),
)

export const MAPLE_DEV_CACHE: ReadonlyArray<CloudflareZoneCacheBucket> = CACHE.flatMap(
	([time, none, dynamic, hit, miss, expired]) =>
		(
			[
				["none", none],
				["dynamic", dynamic],
				["hit", hit],
				["miss", miss],
				["expired", expired],
			] as const
		).map(([cacheStatus, requests]) => ({ bucket: iso(time), cacheStatus, requests })),
)

export const MAPLE_DEV_ROW: CloudflareZoneRow = {
	serviceName: "cloudflare/maple.dev",
	zoneName: "maple.dev",
	requests: 149_700_000,
	errors5xx: 41,
	errorRate: 0.0000003,
	errors4xx: 140_800_000,
	clientErrorRate: 0.94,
	requests2xx: 8_400_000,
	requests3xx: 108_000,
	cacheHits: 127_000,
	cacheableRequests: 141_000,
	cacheHitRate: 0.9,
	bytes: 188_000_000_000,
	visits: 1800,
	ttfbP50Ms: 0,
	ttfbP95Ms: 0,
	ttfbP99Ms: 0,
	originP50Ms: 0,
	originP95Ms: 0,
	originP99Ms: 0,
}

export const MAKI_ACCOUNT_ID = "maki-account"

// The whole Maki Account, 2026-10-14 00:00-12:00 UTC, copied from production.
// [zone, requests, 2xx, 3xx, 4xx, 5xx, cacheHits, cacheable, bytes, visits]
const ZONES: ReadonlyArray<
	readonly [string, number, number, number, number, number, number, number, number, number]
> = [
	["maple.dev", 152092090, 8753504, 120464, 143217804, 318, 146197, 185216, 209783792282, 2446],
	["hazelapp.dev", 90066, 22891, 43025, 1210, 22940, 18, 889, 139040253, 2754],
	["hazel.sh", 15334, 1529, 5729, 7634, 442, 797, 870, 27342492, 161],
	["makisuo.com", 14886, 13956, 507, 399, 24, 16, 44, 10011560, 1569],
	["pixelshades.dev", 10227, 1047, 1038, 8142, 0, 396, 749, 34061301, 127],
	["sonnoapp.com", 6827, 244, 16, 6567, 0, 231, 234, 1669112, 49],
	["formix.dev", 6512, 52, 3845, 2610, 5, 0, 124, 9353006, 14],
	["electric-auth.com", 6462, 342, 1613, 4502, 5, 22, 177, 10992539, 139],
	["safesight.dev", 4877, 7, 2571, 2299, 0, 0, 0, 549422, 0],
	["visualx.io", 4532, 5, 2430, 2079, 18, 0, 5, 4059663, 0],
	["crazypartygames.com", 3645, 1695, 4, 1946, 0, 61, 61, 3050691, 34],
	["slidy.app", 2919, 2673, 107, 139, 0, 6, 270, 5586954, 1270],
	["semconv.com", 665, 378, 238, 49, 0, 248, 416, 4670404, 164],
	["kubly.dev", 217, 137, 2, 78, 0, 132, 132, 1858563, 93],
	["oakroot.dev", 15, 0, 13, 1, 1, 0, 0, 9220, 0],
]

const ratio = (a: number, b: number) => (b > 0 ? a / b : 0)

export const MAKI_ZONES: ReadonlyArray<CloudflareZoneRow> = ZONES.map(
	([zoneName, requests, ok, redirect, client, server, hits, cacheable, bytes, visits]) => ({
		serviceName: `cloudflare/${zoneName}`,
		zoneName,
		requests,
		errors5xx: server,
		errorRate: ratio(server, requests),
		errors4xx: client,
		clientErrorRate: ratio(client, requests),
		requests2xx: ok,
		requests3xx: redirect,
		cacheHits: hits,
		cacheableRequests: cacheable,
		cacheHitRate: cacheable > 0 ? hits / cacheable : null,
		bytes,
		visits,
		ttfbP50Ms: 0,
		ttfbP95Ms: 0,
		ttfbP99Ms: 0,
		originP50Ms: 0,
		originP95Ms: 0,
		originP99Ms: 0,
	}),
)

/** Hourly requests per zone, same window. */
export const MAKI_ZONE_SPARKS: ReadonlyMap<string, ReadonlyArray<number>> = new Map(
	(
		[
			[
				"maple.dev",
				[
					4013519, 34255423, 22279562, 20320905, 17363311, 11021884, 8941730, 8352214, 6837206,
					6057924, 6968426, 5318886,
				],
			],
			["hazelapp.dev", [16323, 35648, 11930, 10079, 62, 305, 903, 8771, 221, 2072, 2370, 1382]],
			["hazel.sh", [6791, 1226, 599, 2042, 142, 198, 961, 183, 988, 976, 452, 751]],
			["makisuo.com", [5783, 328, 11, 9, 180, 11, 158, 14, 6862, 449, 983, 95]],
			["pixelshades.dev", [2199, 25, 754, 194, 676, 219, 789, 239, 1399, 1597, 204, 1932]],
			["sonnoapp.com", [750, 2, 10, 827, 243, 115, 273, 1418, 2678, 219, 4, 288]],
			["formix.dev", [1177, 2, 903, 1114, 168, 331, 1143, 13, 49, 1145, 459, 8]],
			["electric-auth.com", [41, 370, 45, 261, 328, 1934, 737, 246, 1209, 540, 713, 36]],
			["safesight.dev", [302, 2, 1, 2165, 1, 4, 1, 2, 2396, 3]],
			["visualx.io", [3, 2718, 4, 3, 10, 9, 1, 4, 22, 1688, 70]],
			["crazypartygames.com", [741, 180, 120, 25, 11, 18, 33, 1160, 7, 1227, 21, 102]],
			["slidy.app", [36, 10, 23, 7, 4, 5, 1638, 2, 1079]],
			["semconv.com", [32, 62, 66, 21, 29, 75, 37, 30, 54, 123, 53, 70]],
			["kubly.dev", [2, 14, 92, 2, 3, 3, 4, 17, 4, 73, 3]],
			["oakroot.dev", [2, 3, 3, 3, 2]],
		] as const
	).map(([zone, values]) => [`cloudflare/${zone}`, values]),
)

// [script, invocations, errors, doCalls, doErrors, cpuP99, durationP99, cpuP50, durationP50]
const WORKERS: ReadonlyArray<
	readonly [string, number, number, number, number, number, number, number, number]
> = [
	["maple-api", 15820, 166, 0, 0, 610.8, 771.5, 26.2, 67.9],
	["maple-ai", 5621, 0, 998, 17, 723.1, 755.8, 168.7, 173.8],
	["alchemy-state-store", 4857, 0, 4968, 0, 26.5, 59.2, 7.2, 12.3],
	["maple-electric-sync", 4148, 0, 0, 0, 108.3, 2524.8, 25.2, 304.8],
	["maple-landing", 2848, 0, 0, 0, 1.8, 17, 0.9, 2.1],
	["hazel-api", 1764, 0, 1457, 1456, 113.8, 977.2, 6.6, 442.6],
	["maple-api-eu", 1615, 0, 0, 0, 707.9, 851.1, 153.8, 245.8],
	["maple-web", 1108, 0, 0, 0, 20.4, 246.7, 7.3, 61.6],
	["hazel-actors", 1048, 0, 0, 0, 10.9, 10.9, 4.1, 4.1],
	["maple-chat-bot", 1036, 0, 1845, 14, 14.2, 36, 3.6, 26.8],
	["maple-alerting", 955, 0, 0, 0, 20.5, 5835.3, 5.7, 560.4],
	["maple-alerting-pr-1336", 923, 0, 0, 0, 20.5, 23.4, 3.4, 3.4],
	["maple-alerting-eu", 918, 0, 0, 0, 26.8, 936.3, 5.7, 160],
	["maple-chat-bot-pr-1336", 717, 0, 0, 0, 5.1, 5.1, 3.2, 3.2],
	["maple-chat-bot-eu", 714, 0, 0, 0, 5.5, 5.5, 3.2, 3.2],
	["crazy-party-games-rivet", 483, 0, 0, 0, 0.4, 0.4, 0.2, 0.2],
	["favicon-service", 480, 0, 0, 0, 19.7, 68.3, 4.4, 11.1],
	["crazy-party-games-web", 385, 0, 0, 0, 5.9, 5.9, 4, 4],
	["electric-proxy-api", 377, 0, 0, 0, 140, 140, 112.9, 112.9],
	["link-preview-worker", 317, 0, 0, 0, 5.3, 5.3, 1.5, 1.5],
	["maple-electric-sync-eu", 291, 0, 0, 0, 137.8, 1275.9, 41.8, 69.6],
	["hazel-electric-proxy", 251, 0, 0, 0, 43.2, 372.7, 14.3, 229.5],
	["visualx-worker", 243, 0, 0, 0, 6.3, 181.9, 5.5, 168],
	["maple-web-eu", 199, 0, 0, 0, 28.1, 691.8, 6, 115.7],
	["hazel-backend", 159, 159, 0, 0, 48.4, 544.2, 46, 526.2],
	["hazel-bot-gateway", 145, 0, 0, 0, 31.9, 87.2, 18.5, 44.9],
	["maple-ai-eu", 82, 0, 113, 0, 794.6, 794.6, 362.2, 376.5],
	["maple-portal-api-production", 72, 0, 0, 0, 742.5, 2582.8, 217.3, 1178],
	["semconv", 42, 0, 0, 0, 5, 6, 1.4, 2.4],
	["horse-meme-saloon", 22, 0, 0, 0, 13.4, 13.4, 5.8, 5.8],
	["maple-local-ui", 19, 0, 0, 0, 2.2, 8.8, 1.3, 6],
	["maple-electric-sync-pr-1336", 17, 0, 0, 0, 77.9, 1288, 50.3, 55.9],
	["maple-api-pr-1336", 16, 0, 0, 0, 113.8, 159.2, 113.1, 151.7],
	["kubly-updates", 6, 0, 0, 0, 1, 11.2, 0.9, 7.4],
	["maple-landing-pr-1336", 4, 0, 0, 0, 1.8, 20.9, 1.2, 13.9],
	["maple-web-pr-1336", 2, 0, 0, 0, 1.4, 11.1, 0.4, 0.4],
	["maple-sandbox", 0, 0, 208, 0, 0, 0, 0, 0],
	["maple-sandbox-eu", 0, 0, 100, 0, 0, 0, 0, 0],
]

export const MAKI_WORKERS: ReadonlyArray<CloudflareWorkerRow> = WORKERS.filter(
	([, requests]) => requests > 0,
).map(([scriptName, requests, errors, , , cpuP99Ms, durationP99Ms, cpuP50Ms, durationP50Ms]) => ({
	serviceName: `cloudflare-worker/${scriptName}`,
	accountId: MAKI_ACCOUNT_ID,
	scriptName,
	requests,
	errors,
	errorRate: ratio(errors, requests),
	subrequests: 0,
	cpuP50Ms,
	cpuP99Ms,
	durationP50Ms,
	durationP99Ms,
}))

export const MAKI_DURABLE_OBJECTS: ReadonlyArray<CloudflareDurableObjectRow> = WORKERS.filter(
	([, , , doCalls]) => doCalls > 0,
).map(([scriptName, , , requests, errors]) => ({
	serviceName: `cloudflare-worker/${scriptName}`,
	accountId: MAKI_ACCOUNT_ID,
	scriptName,
	requests,
	errors,
	errorRate: ratio(errors, requests),
}))

export const MAKI_QUEUES: ReadonlyArray<CloudflareQueueRow> = (
	[
		["0a1b2c3d4e5f60718293a4b5c6d7e8f9", 55, 1100, 12_200, 0.3],
		["1b2c3d4e5f60718293a4b5c6d7e8f90a", 2, 84, 5_800, 0.2],
		["2c3d4e5f60718293a4b5c6d7e8f90a1b", 2, 6, 1_900, 0.4],
		["3d4e5f60718293a4b5c6d7e8f90a1b2c", 2, 3, 1_400, 0.3],
	] as const
).map(([queueName, backlogMessages, backlogMessagesMax, backlogBytes, consumerConcurrency]) => ({
	serviceName: `cloudflare-queue/${queueName}`,
	accountId: MAKI_ACCOUNT_ID,
	queueName,
	backlogMessages,
	backlogMessagesMax,
	backlogBytes,
	consumerConcurrency,
}))

/** maple.dev's top paths over the same 12h, as the breakdown endpoint returns them. */
export const MAPLE_DEV_PATHS: CloudflareZoneBreakdown = (() => {
	const rows: ReadonlyArray<readonly [string, number, number, number]> = [
		["/v1/traces", 139_600_000, 0.00001, 180e9],
		["/v1/sessionReplays/meta", 2_900_000, 0.00001, 2.5e9],
		["/v1/sessionEvents", 2_500_000, 0.00001, 1.7e9],
		["/v1/sessionReplays/blob", 2_400_000, 0, 1.2e9],
		["/v1/metrics", 2_000_000, 0, 1.5e9],
		["/v1/logs", 1_200_000, 0, 422e6],
		["/mcp", 12_400, 0, 62e6],
		["/api/internal/scrape-results", 7_500, 0, 2.3e6],
		["/api/sync/shape", 6_600, 0.0014, 5.1e6],
		["/service/.env", 3_600, 0, 26.5e3],
		["/", 3_300, 0.0027, 24.9e6],
		["/api/integrations/github/webhook", 2_700, 0, 840e3],
	]
	const total = rows.reduce((acc, [, requests]) => acc + requests, 0)
	return {
		totals: rows.map(([key, requests, errorRate, bytes]) => ({
			key,
			requests,
			errors5xx: Math.round(requests * errorRate),
			errorRate,
			bytes,
			share: requests / total,
		})),
		buckets: [],
		unattributed: 0,
		coverage: 0.999,
		coverageStart: null,
		ignoredFilters: [],
	}
})()

// maple-api, same window, 30-minute buckets. Its 166 exceptions all landed before 01:00.
const MAPLE_API_TIMES = [
	"00:00",
	"00:30",
	"01:00",
	"01:30",
	"02:00",
	"02:30",
	"03:00",
	"03:30",
	"04:00",
	"04:30",
	"05:00",
	"05:30",
	"06:00",
	"06:30",
	"07:00",
	"07:30",
	"08:00",
	"08:30",
	"09:00",
	"09:30",
	"10:00",
	"10:30",
	"11:00",
	"11:30",
] as const
const MAPLE_API_SUCCESS = [
	1248, 1292, 611, 483, 433, 229, 349, 601, 404, 396, 500, 379, 340, 564, 540, 675, 647, 308, 441, 1346,
	700, 1257, 725, 996,
]
// [cpuP50, cpuP99, durationP50, durationP99]
const MAPLE_API_LATENCY: ReadonlyArray<readonly [number, number, number, number]> = [
	[70.2, 558.5, 343.1, 1429.4],
	[38.1, 556, 162, 726.5],
	[19.6, 658.2, 41.6, 658.2],
	[15.2, 622, 33.8, 622],
	[18.8, 714, 42.8, 714],
	[79.6, 710, 95.9, 710],
	[20.9, 655.1, 41.5, 655.3],
	[13.9, 446.8, 19, 459.9],
	[14.9, 610.9, 18.5, 706],
	[15.7, 549.5, 22, 549.5],
	[22.2, 641.4, 31.2, 641.4],
	[17.3, 563.6, 33.3, 563.6],
	[19.4, 629.2, 46.1, 629.2],
	[20.7, 529.5, 35.9, 718.1],
	[15.4, 560.8, 38.7, 560.8],
	[9.9, 521.4, 15.9, 521.4],
	[12.5, 505.4, 24.3, 905],
	[24, 714.3, 60.6, 756.6],
	[25.9, 592.6, 50.3, 649.3],
	[17.9, 517.7, 57.8, 1058.8],
	[17.3, 594.6, 33.1, 952.5],
	[14, 565.9, 41.4, 990],
	[42.2, 914.3, 91.8, 923],
	[29.5, 692.5, 60.2, 823.1],
]

export const MAPLE_API_DETAIL: CloudflareWorkerDetail = {
	outcomeBuckets: [
		...MAPLE_API_TIMES.map((time, i) => ({
			bucket: iso(time),
			status: "success",
			requests: MAPLE_API_SUCCESS[i] ?? 0,
		})),
		{ bucket: iso("00:00"), status: "scriptThrewException", requests: 141 },
		{ bucket: iso("00:30"), status: "scriptThrewException", requests: 25 },
		{ bucket: iso("11:30"), status: "clientDisconnected", requests: 2 },
	],
	latencyBuckets: MAPLE_API_TIMES.map((time, i) => {
		const [cpuP50Ms, cpuP99Ms, durationP50Ms, durationP99Ms] = MAPLE_API_LATENCY[i] ?? [0, 0, 0, 0]
		return {
			bucket: iso(time),
			cpuP50Ms,
			cpuP99Ms,
			durationP50Ms,
			durationP99Ms,
			doWallP50Ms: 0,
			doWallP99Ms: 0,
		}
	}),
	durableObjectBuckets: [],
}

/** maple-api's versions in the window, from its own spans' `service.version`. */
export const MAPLE_API_RELEASES: ReadonlyArray<{
	commitSha: string
	firstSeen: string
	spanCount: number
	errorCount: number
}> = [
	{
		commitSha: "93e595dea960c98cd8f76bd52c02b44f749d6851",
		firstSeen: iso("00:00"),
		spanCount: 77974,
		errorCount: 11,
	},
	{
		commitSha: "5472320e0cdf7b3fa9fc96f9bd1d1553b20047ea",
		firstSeen: iso("10:06"),
		spanCount: 1,
		errorCount: 0,
	},
	{
		commitSha: "ed8a4128927833ebc28e25e509b6aa120e52b35d",
		firstSeen: iso("10:59"),
		spanCount: 2137,
		errorCount: 0,
	},
	{
		commitSha: "d7a6ee72eaf854b1f74c305ad202a9d3b1ba932a",
		firstSeen: iso("11:10"),
		spanCount: 4652,
		errorCount: 0,
	},
	{
		commitSha: "c9e38b707225b7d98c58a0111dcffb1a9bd4aeb7",
		firstSeen: iso("11:28"),
		spanCount: 1136,
		errorCount: 0,
	},
	{
		commitSha: "701d72fccc06ba1603e4fac244ac1379f2da0896",
		firstSeen: iso("11:37"),
		spanCount: 10518,
		errorCount: 0,
	},
]

// Multi-account demo: the same rows split across three accounts of one grant. Not production data:
// the split, the shared Worker name and the sync problems are invented to show every state.
export const DEMO_NOW = Date.parse("2026-10-14T12:00:00.000Z")
const MIN = 60_000
const ACCOUNT_OF_ZONE = (zone: string) =>
	zone.startsWith("maple") || zone === "makisuo.com" || zone === "semconv.com"
		? "acct-maple"
		: zone.startsWith("hazel")
			? "acct-hazel"
			: "acct-side"
const ACCOUNT_OF_SCRIPT = (script: string) =>
	script.startsWith("maple") || script === "alchemy-state-store" || script === "semconv"
		? "acct-maple"
		: script.startsWith("hazel")
			? "acct-hazel"
			: "acct-side"

export const DEMO_WORKERS: ReadonlyArray<CloudflareWorkerRow> = [
	...MAKI_WORKERS.map((w) => ({ ...w, accountId: ACCOUNT_OF_SCRIPT(w.scriptName) })),
	// The same script name deployed in a second account.
	{
		...MAKI_WORKERS.find((w) => w.scriptName === "favicon-service")!,
		accountId: "acct-hazel",
		requests: 96,
		errors: 4,
		errorRate: 4 / 96,
	},
]
export const DEMO_DURABLE_OBJECTS: ReadonlyArray<CloudflareDurableObjectRow> = MAKI_DURABLE_OBJECTS.map(
	(d) => ({
		...d,
		accountId: ACCOUNT_OF_SCRIPT(d.scriptName),
	}),
)

const zoneStatus = (name: string, lastSyncedAt: number, lastError: string | null = null) =>
	new CloudflareAnalyticsZoneStatus({
		id: name,
		name,
		enabled: true,
		lastSyncedAt,
		lastError,
		watermarkAt: lastSyncedAt,
	})

const accountStatus = (
	accountId: string,
	accountName: string,
	syncedAt: number,
	errors: Record<string, string> = {},
) =>
	new CloudflareConnectedAccountStatus({
		accountId,
		accountName,
		connectedByUserId: null,
		scope: "analytics",
		analyticsCapable: true,
		revoked: false,
		zones: MAKI_ZONES.filter((z) => ACCOUNT_OF_ZONE(z.zoneName) === accountId).map((z) =>
			zoneStatus(z.zoneName, syncedAt, errors[z.zoneName] ?? null),
		),
		workers: new CloudflareAnalyticsWorkersStatus({
			enabled: true,
			lastSyncedAt: syncedAt,
			lastError: null,
			watermarkAt: syncedAt,
		}),
	})

export const DEMO_ACCOUNT_STATUSES: ReadonlyArray<CloudflareConnectedAccountStatus> = [
	accountStatus("acct-maple", "Maple Production", DEMO_NOW - 2 * MIN),
	accountStatus("acct-hazel", "Hazel", DEMO_NOW - 3 * MIN, { "hazelapp.dev": "GraphQL rate limited" }),
	accountStatus("acct-side", "Side projects", DEMO_NOW - 47 * MIN),
]
