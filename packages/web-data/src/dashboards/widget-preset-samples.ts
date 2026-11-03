// The picker's preview fixtures: plausible readings and rows, so its tiles aren't empty.

/** Sample readings by stat preset id. */
interface StatPresetSamples {
	readonly [presetId: string]: number
}

/** Sample rows by table or list preset id. */
interface RowPresetSamples {
	readonly [presetId: string]: ReadonlyArray<Readonly<Record<string, unknown>>>
}

/** The stat presets' sample readings. */
export const STAT_PRESET_SAMPLE_VALUES: StatPresetSamples = {
	"stat-total-traces": 48293,
	"stat-total-logs": 124817,
	"stat-error-rate": 0.032,
	"stat-total-errors": 1247,
	"stat-total-services": 12,
}

/** The table presets' sample rows, by preset id. */
export const TABLE_PRESET_SAMPLE_ROWS: RowPresetSamples = {
	"table-traces": [
		{ serviceName: "api-gw", spanName: "GET /api/users", durationMs: 142, hasError: false },
		{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, hasError: true },
		{ serviceName: "api-gw", spanName: "GET /api/health", durationMs: 3, hasError: false },
	],
	"table-errors": [
		{ errorType: "ConnectionTimeout", count: 342, affectedServicesCount: 5 },
		{ errorType: "NullPointerException", count: 128, affectedServicesCount: 3 },
		{ errorType: "RateLimitExceeded", count: 87, affectedServicesCount: 2 },
	],
	"table-services": [
		{ serviceName: "api-gateway", p95LatencyMs: 245, errorRate: 2.1, throughput: 1250 },
		{ serviceName: "user-service", p95LatencyMs: 89, errorRate: 0.4, throughput: 830 },
		{ serviceName: "order-service", p95LatencyMs: 412, errorRate: 5.2, throughput: 340 },
	],
}

/** The list presets' sample rows, by preset id. */
export const LIST_PRESET_SAMPLE_ROWS: RowPresetSamples = {
	"list-traces": [
		{ serviceName: "api-gw", spanName: "GET /api/users", durationMs: 142, statusCode: "Ok" },
		{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, statusCode: "Error" },
		{ serviceName: "api-gw", spanName: "GET /api/health", durationMs: 3, statusCode: "Ok" },
	],
	"list-error-traces": [
		{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, statusCode: "Error" },
		{ serviceName: "auth-svc", spanName: "GET /api/auth", durationMs: 2301, statusCode: "Error" },
		{ serviceName: "item-svc", spanName: "PUT /api/items", durationMs: 445, statusCode: "Error" },
	],
	"list-logs": [
		{
			timestamp: "12:04:23",
			severityText: "ERROR",
			serviceName: "api-gw",
			body: "Connection refused",
		},
		{ timestamp: "12:04:21", severityText: "WARN", serviceName: "user-svc", body: "Slow query" },
		{ timestamp: "12:04:19", severityText: "INFO", serviceName: "api-gw", body: "Request handled" },
	],
	"list-product-events": [
		{
			timestamp: "12:04:23",
			eventName: "signup_completed",
			userId: "user_8f2",
			pagePath: "/signup",
			source: "browser",
		},
		{
			timestamp: "12:04:21",
			eventName: "plan_started",
			userId: "user_8f2",
			pagePath: "",
			source: "server",
		},
		{
			timestamp: "12:04:19",
			eventName: "dashboard_created",
			userId: "user_2c1",
			pagePath: "/dashboards",
			source: "browser",
		},
	],
}
