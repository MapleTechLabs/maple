import type { WeeklyDigestProps } from "../weekly-digest"

/** Shared sample props for the react-email preview variants. */
export const baseDigestProps: WeeklyDigestProps = {
	orgName: "Acme Corp",
	dateRange: { start: "Mar 24", end: "Mar 31" },
	summary: {
		requests: { value: 1_234_567, delta: 12.3 },
		errors: { value: 4231, delta: -8.2 },
		p95Latency: { valueMs: 245, delta: 5.1 },
		dataVolume: { valueBytes: 18_300_000_000, delta: 3.4 },
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
	services: [
		{ name: "api-gateway", requests: 450_000, errorRate: 0.3, p95Ms: 120, requestsDelta: 8.4 },
		{ name: "auth-service", requests: 280_000, errorRate: 1.2, p95Ms: 85, requestsDelta: -3.1 },
		{ name: "payments", requests: 95_000, errorRate: 0.1, p95Ms: 340, requestsDelta: 22.7 },
		{ name: "user-service", requests: 82_000, errorRate: 0.4, p95Ms: 92, requestsDelta: 1.2 },
		{ name: "notification-svc", requests: 45_000, errorRate: 2.8, p95Ms: 210, requestsDelta: -14.0 },
	],
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
	},
	baseUrl: "https://app.maple.dev",
	dashboardUrl: "https://app.maple.dev",
	unsubscribeUrl: "https://app.maple.dev/settings/notifications",
}
