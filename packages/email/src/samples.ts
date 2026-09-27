/** Sample props for the local preview renders (`bun run --cwd packages/email preview`). */
import type { AlertNotificationProps } from "./alert-notification"
import type {
	Delta,
	DigestBreakdownRow,
	DigestEnvironmentGroup,
	DigestService,
	WeeklyDigestProps,
} from "./weekly-digest-core"
import { computeDelta } from "./weekly-digest-core"
import {
	aiProductIcon,
	emailIcon,
	faviconIcon,
	type WebAnalyticsDigestProps,
} from "./web-analytics-digest-core"

const pct = (value: number): Delta => ({ kind: "pct", value })

/** Build the grouped/breakdown views the renderer consumes from a flat service
 * list, the same way DigestService does — so a sample only has to declare the
 * services once. */
function derive(services: Array<DigestService>): {
	services: Array<DigestService>
	environmentGroups: Array<DigestEnvironmentGroup>
	breakdown: { environments: Array<DigestBreakdownRow>; namespaces: Array<DigestBreakdownRow> }
} {
	const by = (dimension: (s: DigestService) => string): Array<DigestBreakdownRow> => {
		const totals = new Map<string, { requests: number; errors: number }>()
		for (const s of services) {
			const key = dimension(s)
			const entry = totals.get(key) ?? { requests: 0, errors: 0 }
			entry.requests += s.requests
			entry.errors += (s.requests * s.errorRate) / 100
			totals.set(key, entry)
		}
		return [...totals.entries()]
			.map(([label, t]) => ({
				label,
				requests: t.requests,
				errorRate: t.requests > 0 ? (t.errors / t.requests) * 100 : 0,
				requestsDelta: pct(4.2),
			}))
			.sort((a, b) => b.requests - a.requests)
	}

	const groups = new Map<string, Array<DigestService>>()
	for (const s of services) {
		const bucket = groups.get(s.environment)
		if (bucket) bucket.push(s)
		else groups.set(s.environment, [s])
	}

	return {
		services: [...services].sort((a, b) => b.errorRate - a.errorRate),
		environmentGroups: [...groups.entries()]
			.map(([environment, groupServices]) => {
				const requests = groupServices.reduce((sum, s) => sum + s.requests, 0)
				return { environment, requests, requestsDelta: pct(6.1), services: groupServices }
			})
			.sort((a, b) => b.requests - a.requests),
		breakdown: { environments: by((s) => s.environment), namespaces: by((s) => s.namespace) },
	}
}

/** A healthy week: traffic up, errors down, one service running slightly hot. */
export const healthyDigestProps: WeeklyDigestProps = {
	orgName: "Acme Corp",
	dateRange: { start: "Mar 24", end: "Mar 30" },
	scope: { environments: [], namespaces: [] },
	summary: {
		requests: { value: 1_234_567, delta: pct(12.3) },
		errors: { value: 4231, delta: pct(-8.2) },
		p95Latency: { valueMs: 245, delta: pct(5.1) },
		dataVolume: { valueBytes: 18_300_000_000, delta: pct(3.4) },
	},
	series: [
		{ label: "M", requests: 150_000, errors: 400 },
		{ label: "T", requests: 182_000, errors: 520 },
		{ label: "W", requests: 168_000, errors: 610 },
		{ label: "T", requests: 201_000, errors: 480 },
		{ label: "F", requests: 224_000, errors: 690 },
		{ label: "S", requests: 142_000, errors: 380 },
		{ label: "S", requests: 167_000, errors: 751 },
	],
	...derive([
		{
			name: "api-gateway",
			environment: "production",
			namespace: "",
			requests: 450_000,
			errorRate: 0.3,
			p95Ms: 120,
			requestsDelta: pct(8.4),
		},
		{
			name: "auth-service",
			environment: "production",
			namespace: "",
			requests: 280_000,
			errorRate: 1.2,
			p95Ms: 85,
			requestsDelta: pct(-3.1),
		},
		{
			name: "payments",
			environment: "production",
			namespace: "",
			requests: 95_000,
			errorRate: 0.1,
			p95Ms: 340,
			requestsDelta: pct(22.7),
		},
		{
			name: "user-service",
			environment: "production",
			namespace: "",
			requests: 82_000,
			errorRate: 0.4,
			p95Ms: 92,
			requestsDelta: pct(1.2),
		},
		{
			name: "notification-svc",
			environment: "production",
			namespace: "",
			requests: 45_000,
			errorRate: 2.8,
			p95Ms: 210,
			requestsDelta: pct(-14.0),
		},
	]),
	topErrors: [
		{
			message: "NullPointerException in UserService.getProfile",
			count: 1204,
			affectedServices: 3,
			isNew: false,
		},
		{
			message: "ConnectionTimeout: Redis pool exhausted after 30s",
			count: 892,
			affectedServices: 2,
			isNew: true,
		},
		{ message: "AuthTokenExpired: JWT validation failed", count: 445, affectedServices: 1, isNew: false },
	],
	ingestion: {
		logs: 5_200_000,
		traces: 1_234_567,
		metrics: 890_000,
		totalBytes: 18_300_000_000,
		approximate: false,
	},
	baseUrl: "https://app.maple.dev",
	dashboardUrl: "https://app.maple.dev",
	unsubscribeUrl: "https://app.maple.dev/settings/notifications",
}

/** Elevated error rate, errors and latency climbing week over week. */
export const watchDigestProps: WeeklyDigestProps = {
	...healthyDigestProps,
	summary: {
		...healthyDigestProps.summary,
		requests: { value: 980_000, delta: pct(-4.1) },
		errors: { value: 21_400, delta: pct(38.6) },
		p95Latency: { valueMs: 410, delta: pct(28.9) },
	},
	series: healthyDigestProps.series.map((point, index) => ({
		...point,
		errors: Math.round(point.requests * (0.012 + index * 0.004)),
	})),
	...derive([
		{
			name: "payments",
			environment: "production",
			namespace: "",
			requests: 120_000,
			errorRate: 3.4,
			p95Ms: 520,
			requestsDelta: pct(-2.1),
		},
		{
			name: "api-gateway",
			environment: "production",
			namespace: "",
			requests: 410_000,
			errorRate: 1.8,
			p95Ms: 180,
			requestsDelta: pct(-6.4),
		},
		{
			name: "auth-service",
			environment: "production",
			namespace: "",
			requests: 240_000,
			errorRate: 1.1,
			p95Ms: 130,
			requestsDelta: pct(3.2),
		},
		{
			name: "user-service",
			environment: "production",
			namespace: "",
			requests: 78_000,
			errorRate: 0.5,
			p95Ms: 96,
			requestsDelta: pct(0.4),
		},
	]),
}

/** A service on fire. */
export const criticalDigestProps: WeeklyDigestProps = {
	...healthyDigestProps,
	summary: {
		...healthyDigestProps.summary,
		requests: { value: 760_000, delta: pct(-18.2) },
		errors: { value: 61_800, delta: pct(142.0) },
		p95Latency: { valueMs: 980, delta: pct(96.3) },
		dataVolume: { valueBytes: 12_100_000_000, delta: pct(-22.0) },
	},
	series: healthyDigestProps.series.map((point, index) => ({
		...point,
		errors: Math.round(point.requests * (0.03 + index * 0.012)),
	})),
	...derive([
		{
			name: "payments",
			environment: "production",
			namespace: "",
			requests: 88_000,
			errorRate: 14.6,
			p95Ms: 2100,
			requestsDelta: pct(-41.0),
		},
		{
			name: "checkout",
			environment: "production",
			namespace: "",
			requests: 64_000,
			errorRate: 8.2,
			p95Ms: 1450,
			requestsDelta: pct(-33.5),
		},
		{
			name: "api-gateway",
			environment: "production",
			namespace: "",
			requests: 380_000,
			errorRate: 4.1,
			p95Ms: 320,
			requestsDelta: pct(-12.0),
		},
		{
			name: "auth-service",
			environment: "production",
			namespace: "",
			requests: 210_000,
			errorRate: 2.0,
			p95Ms: 240,
			requestsDelta: pct(-5.1),
		},
	]),
	topErrors: [
		{
			message: "PaymentGatewayTimeout: upstream did not respond within 5000ms",
			count: 18_420,
			affectedServices: 4,
			isNew: true,
		},
		{
			message: "DeadlockDetected: serialization failure on orders table",
			count: 9310,
			affectedServices: 2,
			isNew: true,
		},
		{
			message: "NullPointerException in UserService.getProfile",
			count: 1204,
			affectedServices: 3,
			isNew: false,
		},
	],
}

/**
 * Multiple environments and namespaces, plus every delta state the union can
 * produce — a service with no previous week (`new`), one that went silent
 * (`gone`), and one whose previous week is below the significance floor
 * (`none`, rendered as a dim dash instead of a five-figure percentage).
 */
export const multiEnvDigestProps: WeeklyDigestProps = {
	...healthyDigestProps,
	orgName: "Acme Corp",
	scope: { environments: [], namespaces: [] },
	summary: {
		requests: { value: 2_140_000, delta: pct(9.4) },
		errors: { value: 12_800, delta: computeDelta(12_800, 0) },
		p95Latency: { valueMs: 312, delta: pct(-4.8) },
		dataVolume: { valueBytes: 24_800_000_000, delta: pct(11.2) },
	},
	...derive([
		{
			name: "api-gateway",
			environment: "production",
			namespace: "edge",
			requests: 980_000,
			errorRate: 0.4,
			p95Ms: 118,
			requestsDelta: pct(7.2),
		},
		{
			name: "payments",
			environment: "production",
			namespace: "commerce",
			requests: 420_000,
			errorRate: 2.9,
			p95Ms: 460,
			requestsDelta: pct(-11.4),
		},
		{
			name: "checkout",
			environment: "production",
			namespace: "commerce",
			requests: 310_000,
			errorRate: 0.8,
			p95Ms: 280,
			requestsDelta: computeDelta(310_000, 0),
		},
		{
			name: "auth-service",
			environment: "production",
			namespace: "identity",
			requests: 240_000,
			errorRate: 0.2,
			p95Ms: 74,
			requestsDelta: pct(1.9),
		},
		{
			name: "api-gateway",
			environment: "staging",
			namespace: "edge",
			requests: 84_000,
			errorRate: 1.1,
			p95Ms: 132,
			requestsDelta: pct(1240.0),
		},
		{
			name: "batch-worker",
			environment: "staging",
			namespace: "",
			requests: 12_000,
			errorRate: 6.4,
			p95Ms: 1820,
			requestsDelta: computeDelta(12_000, 40),
		},
		{
			name: "legacy-sync",
			environment: "staging",
			namespace: "commerce",
			requests: 0,
			errorRate: 0,
			p95Ms: 0,
			requestsDelta: computeDelta(0, 8400),
		},
	]),
	ingestion: {
		logs: 9_400_000,
		traces: 2_140_000,
		metrics: 1_310_000,
		totalBytes: 24_800_000_000,
		approximate: false,
	},
}

/** The same org, scoped to one namespace in one environment. */
export const scopedDigestProps: WeeklyDigestProps = {
	...multiEnvDigestProps,
	scope: { environments: ["production"], namespaces: ["commerce"] },
	summary: {
		requests: { value: 730_000, delta: pct(2.1) },
		errors: { value: 14_600, delta: pct(6.8) },
		p95Latency: { valueMs: 388, delta: pct(-2.2) },
		dataVolume: { valueBytes: 24_800_000_000, delta: pct(11.2) },
	},
	...derive([
		{
			name: "payments",
			environment: "production",
			namespace: "commerce",
			requests: 420_000,
			errorRate: 2.9,
			p95Ms: 460,
			requestsDelta: pct(-11.4),
		},
		{
			name: "checkout",
			environment: "production",
			namespace: "commerce",
			requests: 310_000,
			errorRate: 0.8,
			p95Ms: 280,
			requestsDelta: pct(4.4),
		},
	]),
	ingestion: { ...multiEnvDigestProps.ingestion, approximate: true },
}

/** Critical trigger. */
export const alertNotificationProps: AlertNotificationProps = {
	ruleName: "API error rate — checkout",
	eventLabel: "Triggered",
	eventEmoji: "\u{1F6A8}",
	severity: "critical",
	signalLabel: "Error Rate",
	group: "checkout-service",
	observedSummary: "5.2% > 1%",
	window: "5m",
	accentColor: "#e01e5a",
	linkUrl: "https://app.maple.dev/alerts/rule_123",
	chatUrl: "https://app.maple.dev/alerts/incidents/inc_456",
}

const shareOf = <T extends { value: number; icon: string | null }>(rows: Array<T>) => {
	const total = rows.reduce((sum, row) => sum + row.value, 0)
	return rows.map((row) => ({ ...row, share: total > 0 ? row.value / total : 0 }))
}

export const webAnalyticsDigestProps: WebAnalyticsDigestProps = {
	orgName: "Acme Corp",
	dateRange: { start: "Sep 21", end: "Sep 27" },
	summary: {
		visitors: { value: 12_480, delta: pct(18.2) },
		pageViews: { value: 41_930, delta: pct(9.6) },
		bounceRate: { value: 42.7, delta: pct(-3.1) },
		avgSessionMs: { value: 154_000, delta: pct(6.4) },
	},
	topPages: shareOf([
		{ icon: null, label: "/", value: 14_220, delta: pct(4.1) },
		{ icon: null, label: "/pricing", value: 6_310, delta: pct(22.8) },
		{ icon: null, label: "/docs/getting-started", value: 4_870, delta: pct(-6.2) },
	]),
	sources: shareOf([
		{ icon: emailIcon("direct"), label: "Direct", value: 6_120 },
		{ icon: faviconIcon("google.com"), label: "google.com", value: 3_480 },
		{ icon: faviconIcon("github.com"), label: "github.com", value: 1_210 },
	]),
	ai: {
		referrals: {
			sessions: 642,
			delta: pct(38.5),
			byProduct: shareOf([
				{ icon: aiProductIcon("chatgpt"), label: "ChatGPT", value: 410, delta: pct(21.3) },
				{ icon: aiProductIcon("claude"), label: "Claude", value: 148, delta: pct(64.4) },
				{
					icon: aiProductIcon("perplexity"),
					label: "Perplexity",
					value: 61,
					delta: { kind: "none" },
				},
			]),
		},
		crawlers: {
			requests: 18_320,
			delta: pct(-12.4),
			byCrawler: shareOf([
				{ icon: aiProductIcon("chatgpt"), label: "GPTBot", value: 7_940 },
				{ icon: aiProductIcon("claude"), label: "ClaudeBot", value: 5_210 },
				{ icon: aiProductIcon("perplexity"), label: "PerplexityBot", value: 2_880 },
			]),
		},
	},
	baseUrl: "https://app.maple.dev",
	analyticsUrl:
		"https://app.maple.dev/analytics?startTime=2026-09-21+00%3A00%3A00&endTime=2026-09-27+23%3A59%3A59",
	aiUrl: "https://app.maple.dev/analytics?startTime=2026-09-21+00%3A00%3A00&endTime=2026-09-27+23%3A59%3A59&tab=ai",
	unsubscribeUrl: "https://app.maple.dev/settings/notifications",
}

/** A small site with no AI traffic and a warehouse without the crawler table. */
export const quietWebAnalyticsDigestProps: WebAnalyticsDigestProps = {
	...webAnalyticsDigestProps,
	orgName: "Tiny Blog",
	summary: {
		visitors: { value: 84, delta: { kind: "none" } },
		pageViews: { value: 212, delta: { kind: "none" } },
		bounceRate: { value: null, delta: { kind: "none" } },
		avgSessionMs: { value: 41_000, delta: { kind: "none" } },
	},
	topPages: shareOf([
		{ icon: null, label: "/", value: 150, delta: { kind: "none" } },
		{ icon: null, label: "/about", value: 62, delta: { kind: "none" } },
	]),
	sources: shareOf([{ icon: emailIcon("direct"), label: "Direct", value: 84 }]),
	ai: { referrals: { sessions: 0, delta: { kind: "none" }, byProduct: [] }, crawlers: null },
}
