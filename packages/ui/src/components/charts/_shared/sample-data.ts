export const pieSampleData = [
	{ name: "api-gateway", value: 4820 },
	{ name: "user-service", value: 3210 },
	{ name: "order-service", value: 1740 },
	{ name: "auth-service", value: 920 },
	{ name: "billing-service", value: 540 },
]

export const funnelSampleData = [
	{ name: "Visited", value: 4820 },
	{ name: "Signed up", value: 2110 },
	{ name: "Activated", value: 940 },
	{ name: "Converted", value: 360 },
]

/** The drop-off view's extras on the same stages: time between steps and where the leavers went. */
export const funnelDropoffSampleData = [
	{ name: "Visited", value: 4820 },
	{
		name: "Signed up",
		value: 2110,
		p50Ms: 252_000,
		p90Ms: 3_600_000,
		leavers: [
			{ name: "", count: 1190 },
			{ name: "/docs/quickstart", count: 840 },
			{ name: "/pricing", count: 410 },
			{ name: "/blog", count: 270 },
		],
	},
	{
		name: "Activated",
		value: 940,
		p50Ms: 6_000_000,
		p90Ms: 86_400_000,
		leavers: [
			{ name: "", count: 520 },
			{ name: "/docs/quickstart", count: 360 },
			{ name: "/settings/team", count: 140 },
			{ name: "/settings/billing", count: 90 },
			{ name: "/support", count: 60 },
		],
	},
	{
		name: "Converted",
		value: 360,
		p50Ms: 180_000_000,
		p90Ms: 600_000_000,
		leavers: [
			{ name: "/settings/billing", count: 260 },
			{ name: "", count: 210 },
			{ name: "/pricing", count: 110 },
		],
	},
]

/** Hops out of one anchor, three steps deep, with the two sentinels the query emits. */
export const pathsSampleData = [
	{ hop: 1, fromNode: "Signed up", toNode: "Created ingest key", count: 1460 },
	{ hop: 1, fromNode: "Signed up", toNode: "/docs/quickstart", count: 310 },
	{ hop: 1, fromNode: "Signed up", toNode: "", count: 140 },
	{ hop: 1, fromNode: "Signed up", toNode: "/settings/team", count: 120 },
	{ hop: 1, fromNode: "Signed up", toNode: "$other", count: 80 },
	{ hop: 2, fromNode: "Created ingest key", toNode: "First trace received", count: 940 },
	{ hop: 2, fromNode: "Created ingest key", toNode: "/docs/quickstart", count: 280 },
	{ hop: 2, fromNode: "Created ingest key", toNode: "", count: 180 },
	{ hop: 2, fromNode: "Created ingest key", toNode: "$other", count: 60 },
	{ hop: 2, fromNode: "/docs/quickstart", toNode: "Created ingest key", count: 130 },
	{ hop: 2, fromNode: "/docs/quickstart", toNode: "First trace received", count: 80 },
	{ hop: 2, fromNode: "/docs/quickstart", toNode: "", count: 80 },
	{ hop: 2, fromNode: "/docs/quickstart", toNode: "$other", count: 20 },
	{ hop: 2, fromNode: "/settings/team", toNode: "Invited teammate", count: 70 },
	{ hop: 2, fromNode: "/settings/team", toNode: "", count: 40 },
	{ hop: 2, fromNode: "/settings/team", toNode: "$other", count: 10 },
	{ hop: 2, fromNode: "$other", toNode: "", count: 30 },
	{ hop: 2, fromNode: "$other", toNode: "/docs/quickstart", count: 50 },
	{ hop: 3, fromNode: "First trace received", toNode: "/traces", count: 610 },
	{ hop: 3, fromNode: "First trace received", toNode: "Created dashboard", count: 200 },
	{ hop: 3, fromNode: "First trace received", toNode: "Plan started", count: 150 },
	{ hop: 3, fromNode: "First trace received", toNode: "", count: 60 },
	{ hop: 3, fromNode: "/docs/quickstart", toNode: "", count: 140 },
	{ hop: 3, fromNode: "/docs/quickstart", toNode: "First trace received", count: 90 },
	{ hop: 3, fromNode: "/docs/quickstart", toNode: "$other", count: 100 },
	{ hop: 3, fromNode: "Created ingest key", toNode: "First trace received", count: 40 },
	{ hop: 3, fromNode: "Created ingest key", toNode: "Plan started", count: 40 },
	{ hop: 3, fromNode: "Created ingest key", toNode: "", count: 20 },
	{ hop: 3, fromNode: "Created ingest key", toNode: "$other", count: 30 },
	{ hop: 3, fromNode: "Invited teammate", toNode: "Plan started", count: 20 },
	{ hop: 3, fromNode: "Invited teammate", toNode: "Created dashboard", count: 40 },
	{ hop: 3, fromNode: "Invited teammate", toNode: "", count: 10 },
	{ hop: 3, fromNode: "$other", toNode: "", count: 10 },
	{ hop: 3, fromNode: "$other", toNode: "$other", count: 80 },
]

/** Ranked, not sequential — the top rows are deliberately near-identical, which
 *  is the case a funnel mislabels as four separate "100%" stages. */
export const hbarSampleData = [
	{ name: "RedisClient.beginMutation", value: 87_200_000 },
	{ name: "UserAttributesCache.beginMutation", value: 86_400_000 },
	{ name: "RedisClient.endMutation", value: 85_900_000 },
	{ name: "ArtifactCache.get", value: 39_000_000 },
	{ name: "SessionStore.load", value: 14_600_000 },
	{ name: "Billing.meterUsage", value: 4_200_000 },
]

export const histogramSampleData = [
	{ name: "0-50", value: 12 },
	{ name: "50-100", value: 41 },
	{ name: "100-150", value: 88 },
	{ name: "150-200", value: 132 },
	{ name: "200-250", value: 95 },
	{ name: "250-300", value: 64 },
	{ name: "300-350", value: 30 },
	{ name: "350-400", value: 12 },
	{ name: "400+", value: 6 },
]

export const heatmapSampleData = [
	{ x: "00:00", y: "0-100ms", value: 45 },
	{ x: "00:00", y: "100-300ms", value: 12 },
	{ x: "00:00", y: "300ms+", value: 3 },
	{ x: "06:00", y: "0-100ms", value: 78 },
	{ x: "06:00", y: "100-300ms", value: 24 },
	{ x: "06:00", y: "300ms+", value: 5 },
	{ x: "12:00", y: "0-100ms", value: 142 },
	{ x: "12:00", y: "100-300ms", value: 48 },
	{ x: "12:00", y: "300ms+", value: 12 },
	{ x: "18:00", y: "0-100ms", value: 96 },
	{ x: "18:00", y: "100-300ms", value: 32 },
	{ x: "18:00", y: "300ms+", value: 8 },
]

export const defaultBarData = [
	{ name: "Jan", value: 186 },
	{ name: "Feb", value: 305 },
	{ name: "Mar", value: 237 },
	{ name: "Apr", value: 173 },
	{ name: "May", value: 209 },
	{ name: "Jun", value: 214 },
]

export const areaTimeSeriesData = [
	{ month: "Jan", desktop: 186, mobile: 80 },
	{ month: "Feb", desktop: 305, mobile: 200 },
	{ month: "Mar", desktop: 237, mobile: 120 },
	{ month: "Apr", desktop: 73, mobile: 190 },
	{ month: "May", desktop: 209, mobile: 130 },
	{ month: "Jun", desktop: 214, mobile: 140 },
]

export const lineTimeSeriesData = [
	{ date: "Jan", value: 186 },
	{ date: "Feb", value: 305 },
	{ date: "Mar", value: 237 },
	{ date: "Apr", value: 73 },
	{ date: "May", value: 209 },
	{ date: "Jun", value: 214 },
]

export const latencyTimeSeriesData = [
	{ bucket: "2024-01-01T00:00:00Z", p50LatencyMs: 12, p95LatencyMs: 45, p99LatencyMs: 120 },
	{ bucket: "2024-01-01T01:00:00Z", p50LatencyMs: 15, p95LatencyMs: 52, p99LatencyMs: 135 },
	{ bucket: "2024-01-01T02:00:00Z", p50LatencyMs: 11, p95LatencyMs: 40, p99LatencyMs: 98 },
	{ bucket: "2024-01-01T03:00:00Z", p50LatencyMs: 18, p95LatencyMs: 61, p99LatencyMs: 155 },
	{ bucket: "2024-01-01T04:00:00Z", p50LatencyMs: 14, p95LatencyMs: 48, p99LatencyMs: 110 },
	{ bucket: "2024-01-01T05:00:00Z", p50LatencyMs: 13, p95LatencyMs: 44, p99LatencyMs: 102 },
]

export const throughputTimeSeriesData = [
	{ bucket: "2024-01-01T00:00:00Z", throughput: 1240, errorRate: 1.2 },
	{ bucket: "2024-01-01T01:00:00Z", throughput: 1580, errorRate: 2.5 },
	{ bucket: "2024-01-01T02:00:00Z", throughput: 980, errorRate: 0.8 },
	{ bucket: "2024-01-01T03:00:00Z", throughput: 1720, errorRate: 4.2 },
	{ bucket: "2024-01-01T04:00:00Z", throughput: 1350, errorRate: 1.8 },
	{ bucket: "2024-01-01T05:00:00Z", throughput: 1100, errorRate: 1.1 },
]

export const apdexTimeSeriesData = [
	{ bucket: "2024-01-01T00:00:00Z", apdexScore: 0.94 },
	{ bucket: "2024-01-01T01:00:00Z", apdexScore: 0.91 },
	{ bucket: "2024-01-01T02:00:00Z", apdexScore: 0.96 },
	{ bucket: "2024-01-01T03:00:00Z", apdexScore: 0.88 },
	{ bucket: "2024-01-01T04:00:00Z", apdexScore: 0.92 },
	{ bucket: "2024-01-01T05:00:00Z", apdexScore: 0.95 },
]

export const errorRateTimeSeriesData = [
	{ bucket: "2024-01-01T00:00:00Z", errorRate: 0.012 },
	{ bucket: "2024-01-01T01:00:00Z", errorRate: 0.025 },
	{ bucket: "2024-01-01T02:00:00Z", errorRate: 0.008 },
	{ bucket: "2024-01-01T03:00:00Z", errorRate: 0.042 },
	{ bucket: "2024-01-01T04:00:00Z", errorRate: 0.018 },
	{ bucket: "2024-01-01T05:00:00Z", errorRate: 0.011 },
]
