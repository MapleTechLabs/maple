/**
 * Fixture rows for `/lab/worst-case`: one realistic worst case per surface,
 * and a "demo" twin of the same shape with short benign values, so a hardening
 * pass can be screenshotted before and after on identical inputs.
 */
import { formatDuration, formatNumber } from "@maple/domain/format"
import { coerceLogRow } from "@maple/query-engine"
import { countLabel, formatBytes, formatPercent, formatUptime } from "@maple/ui/lib/format"
import { formatClock } from "@maple/ui/lib/replay-format"

import type { HostRow } from "@/components/infra/host-table"
import type { Finding } from "@/components/infra/overview/summaries"
import type { PodRow } from "@/components/infra/pod-table"
import type { ReleaseServiceImpact } from "@/components/releases/release-model"
import type { Log } from "@/api/warehouse/logs"
import { domainThresholdToForm, formatSignalValue } from "@/lib/alerts/form-utils"
import { formatUsage } from "@/lib/billing/usage"

export type WorstCaseMode = "demo" | "worst"

export const LONG_SERVICE = "checkout-service-payments-reconciliation-worker-eu-west-1"
export const LONG_HOST = "ip-10-142-87-203.eu-central-1.compute.internal"
export const LONG_URL =
	"https://dashboards.example.com/d/abcdef123/checkout-latency?orgId=1&var-service=checkout-service-payments-reconciliation-worker-eu-west-1&from=now-6h&to=now"
export const LONG_IMAGE =
	"123456789012.dkr.ecr.eu-west-1.amazonaws.com/platform/checkout-service@sha256:9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e"

const NOW = Date.now()
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/* Formatters ------------------------------------------------------------------------------- */

export interface FormatterCase {
	readonly fn: string
	readonly input: string
	readonly output: string
}

const YEAR_S = 365 * 24 * 60 * 60

/** Each case is computed here, from the real function, at module load. */
export function formatterCases(mode: WorstCaseMode): ReadonlyArray<FormatterCase> {
	const c = (fn: string, input: string, output: unknown): FormatterCase => ({
		fn,
		input,
		output: String(output),
	})
	if (mode === "demo") {
		return [
			c("formatDuration", "1500", formatDuration(1500)),
			c("formatDuration", "42", formatDuration(42)),
			c("formatNumber", "1284", formatNumber(1284)),
			c("formatBytes", "4096", formatBytes(4096)),
			c("formatUptime", "7200 s", formatUptime(7200)),
			c("formatClock", "90000 ms", formatClock(90_000)),
			c("formatPercent", "0.42", formatPercent(0.42)),
			c("countLabel", '3, "host"', countLabel(3, "host")),
			c("formatUsage", "12.5", formatUsage(12.5)),
			c("formatSignalValue(error_rate)", "0.05", formatSignalValue("error_rate", 0.05)),
			c("domainThresholdToForm(error_rate)", "0.05", domainThresholdToForm("error_rate", 0.05)),
		]
	}
	return [
		c("formatDuration", "0.000001", formatDuration(0.000001)),
		c("formatDuration", "-42.5", formatDuration(-42.5)),
		c("formatDuration", "999.96", formatDuration(999.96)),
		c("formatDuration", "59999", formatDuration(59_999)),
		c("formatDuration", "259200000", formatDuration(259_200_000)),
		c("formatDuration", "NaN", formatDuration(Number.NaN)),
		c("formatNumber", "Infinity", formatNumber(Number.POSITIVE_INFINITY)),
		c("formatNumber", "12849302", formatNumber(12_849_302)),
		c("formatNumber", "0.30000000000000004", formatNumber(0.1 + 0.2)),
		c("formatBytes", "-4096", formatBytes(-4096)),
		c("formatBytes", "5e15", formatBytes(5e15)),
		c("formatUptime", "4 s (4000 ms)", formatUptime(4)),
		c("formatUptime", "4000 (ms passed as s)", formatUptime(4000)),
		c("formatUptime", "3 years in s", formatUptime(3 * YEAR_S)),
		c("formatClock", "9 hours in ms", formatClock(9 * 60 * 60 * 1000)),
		c("formatPercent", "0.0000003", formatPercent(0.0000003)),
		c("countLabel", '1, "query", "queries"', countLabel(1, "query", "queries")),
		c("countLabel", '0, "log"', countLabel(0, "log")),
		c("countLabel", '12849302, "span"', countLabel(12_849_302, "span")),
		c("formatUsage (GB)", "48213.55", formatUsage(48_213.55)),
		c("formatUsage (GB)", "NaN", formatUsage(Number.NaN)),
		c("formatSignalValue(error_rate)", "0.07", formatSignalValue("error_rate", 0.07)),
		c("formatSignalValue(error_rate)", "0.29", formatSignalValue("error_rate", 0.29)),
		c("domainThresholdToForm(error_rate)", "0.07", domainThresholdToForm("error_rate", 0.07)),
		c("domainThresholdToForm(error_rate)", "0.29", domainThresholdToForm("error_rate", 0.29)),
	]
}

/* Infra ------------------------------------------------------------------------------------ */

const host = (hostName: string, cpuPct: number, memoryPct: number, diskPct: number): HostRow => ({
	hostName,
	osType: "linux",
	hostArch: "amd64",
	cloudProvider: "aws",
	lastSeen: ago(4_000),
	cpuPct,
	memoryPct,
	diskPct,
	load15: cpuPct * 8,
})

export function hosts(mode: WorstCaseMode): ReadonlyArray<HostRow> {
	if (mode === "demo") return [host("api-01", 0.42, 0.51, 0.3), host("worker-02", 0.18, 0.33, 0.2)]
	return [
		host(LONG_HOST, 0.97, 0.99, 1),
		host("ip-10-142-87-204.eu-central-1.compute.internal", 0, 0, 0),
		{ ...host("db", 1.42, 0.5, 0.2), osType: "", hostArch: "", cloudProvider: "" },
	]
}

const pod = (podName: string, deploymentName: string, cpu: number, mem: number): PodRow => ({
	podName,
	namespace: "payments",
	nodeName: LONG_HOST,
	clusterName: "prod-eu-central-1",
	environment: "production",
	deploymentName,
	statefulsetName: "",
	daemonsetName: "",
	jobName: "",
	qosClass: "Burstable",
	podUid: `uid-${podName}`,
	computeType: "",
	lastSeen: ago(6_000),
	cpuUsage: cpu * 2,
	cpuLimitPct: cpu,
	memoryLimitPct: mem,
	cpuRequestPct: cpu * 1.4,
	memoryRequestPct: mem * 1.2,
	cpuUsagePeak: cpu * 2.4,
	cpuLimitPctPeak: Math.min(1.5, cpu * 1.2),
	memoryLimitPctPeak: mem,
	saturation: Math.max(cpu, mem),
})

export function pods(mode: WorstCaseMode): ReadonlyArray<PodRow> {
	if (mode === "demo")
		return [pod("api-7f9c-x2k9p", "api", 0.3, 0.4), pod("web-5b4a-q8m3z", "web", 0.1, 0.2)]
	const deploy = "checkout-service-payments-reconciliation-worker"
	return [
		pod(`${deploy}-7f9c8d6b5-x2k9p`, deploy, 0.97, 0.99),
		pod(`${deploy}-7f9c8d6b5-q8m3z`, deploy, 0.94, 1.31),
		pod("a", "", 0, 0),
	]
}

export function finding(mode: WorstCaseMode): Finding {
	const name = mode === "demo" ? "api-01" : LONG_HOST
	return {
		key: `wc-${name}`,
		source: "hosts",
		tone: "crit",
		title: `${name} at 97% CPU`,
		detail:
			mode === "demo"
				? "Peak 99% over the window"
				: `Peak 99.97% over the window, load15 7.76 on 8 vCPU, memory 99%, disk 100%, ${LONG_IMAGE}`,
		target: { kind: "host", hostName: name },
	}
}

export const containerImage = (mode: WorstCaseMode) => (mode === "demo" ? "checkout:1.4.2" : LONG_IMAGE)

/* Legend ----------------------------------------------------------------------------------- */

const COLORS = [
	"#4f8cff",
	"#f59e0b",
	"#10b981",
	"#ef4444",
	"#a855f7",
	"#14b8a6",
	"#f43f5e",
	"#84cc16",
	"#64748b",
]

export interface LegendFixture {
	readonly series: ReadonlyArray<{ key: string; label: string; color: string }>
	readonly stats: Record<string, { min: number; max: number; mean: number; last: number }>
}

export function legend(mode: WorstCaseMode): LegendFixture {
	const label = (i: number) =>
		mode === "demo"
			? `service-${i + 1}`
			: `service.name=${LONG_SERVICE}, http.route=/api/v2/organizations/{orgId}/projects/{projectId}${i === 0 ? "" : `/v${i}`}`
	const count = mode === "demo" ? 3 : 8
	const series = Array.from({ length: count + 1 }, (_, i) => ({
		key: `s${i + 1}`,
		label: i === count ? (mode === "demo" ? "idle" : "service.name=, http.route=") : label(i),
		color: COLORS[i % COLORS.length]!,
	}))
	// The last series has no stats entry at all: what an all-null column computes to.
	const stats = Object.fromEntries(
		series.slice(0, count).map((s, i) => {
			const scale = mode === "demo" ? 10 : 10 ** (i - 2)
			return [
				s.key,
				{ min: 0.12 * scale, max: 98_765.4321 * scale, mean: 1234.5678 * scale, last: 42 * scale },
			]
		}),
	)
	return { series, stats }
}

/* AI tool table ---------------------------------------------------------------------------- */

export function toolTable(mode: WorstCaseMode): { headers: string[]; rows: string[][]; title: string } {
	const headers = ["id", "pr", "year", "count"]
	if (mode === "demo") return { headers, title: "Rows", rows: [["42", "17", "2026", "12"]] }
	return {
		headers,
		title: "query_traces_by_service_and_time_window",
		rows: [
			["17293822569102704640", "128493", "2026", "1284903"],
			["9007199254740993", "#128494", "2025", "0.30000000000000004"],
			["", "-0", "1e21", "NaN"],
		],
	}
}

/* Logs + attributes ------------------------------------------------------------------------ */

const DB_STATEMENT = `SELECT o.id, o.org_id, o.status, ${Array.from({ length: 160 }, (_, i) => `li.col_${i}`).join(", ")} FROM orders o JOIN line_items li ON li.order_id = o.id WHERE o.org_id = $1 AND o.created_at > now() - interval '7 days' ORDER BY o.created_at DESC LIMIT 500`

export function attributes(mode: WorstCaseMode): Record<string, string> {
	if (mode === "demo")
		return { "db.system": "postgresql", "db.statement": "SELECT 1", "service.name": "api" }
	return {
		"db.system": "postgresql",
		"db.statement": DB_STATEMENT.padEnd(4096, " /* padding */"),
		"db.user": "",
		"service.name": LONG_SERVICE,
		"url.full": LONG_URL,
	}
}

export function logs(mode: WorstCaseMode): ReadonlyArray<Log> {
	const row = (severityText: string, severityNumber: number, body: string, serviceName: string) =>
		coerceLogRow({
			timestamp: ago(30_000),
			severityText,
			severityNumber,
			serviceName,
			body,
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			spanId: "00f067aa0ba902b7",
			logAttributes: attributes(mode),
			resourceAttributes: { "deployment.environment.name": "production" },
		})
	if (mode === "demo")
		return [row("INFO", 9, "payment captured", "api"), row("ERROR", 17, "payment failed", "api")]
	return [
		row("", 0, "", LONG_SERVICE),
		row("TRACE2", 2, "\x1b[31mERROR\x1b[0m payment failed", LONG_SERVICE),
		row("ERROR", 17, `upstream failed: ${LONG_URL} ${"x".repeat(600)}`, "unknown_service:node"),
	]
}

/* Releases --------------------------------------------------------------------------------- */

export function releaseImpact(mode: WorstCaseMode): ReleaseServiceImpact {
	const worst = mode === "worst"
	return {
		serviceName: worst ? LONG_SERVICE : "api",
		environment: "production",
		commitSha: "8f21c0d9e4b7a6f5c3d2e1f0a9b8c7d6e5f4a3b2",
		firstSeen: ago(2 * 60 * 60 * 1000),
		spanCount: worst ? 12_849_302 : 4_200,
		errorCount: worst ? 514_000 : 21,
		errorRate: worst ? 0.04 : 0.005,
		p50LatencyMs: worst ? 0.000001 : 42,
		p95LatencyMs: worst ? 59_999 : 180,
		p99LatencyMs: worst ? 259_200_000 : 410,
		apdexScore: worst ? 0.0000003 : 0.94,
		baseline: {
			commitSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
			firstSeen: ago(26 * 60 * 60 * 1000),
			spanCount: worst ? 51 : 4_000,
			errorCount: 0,
			errorRate: worst ? 0 : 0.004,
			p50LatencyMs: worst ? 0 : 40,
			p95LatencyMs: worst ? 0 : 170,
			p99LatencyMs: worst ? 0 : 400,
			apdexScore: worst ? 1 : 0.95,
		},
		errorRatio: worst ? Number.POSITIVE_INFINITY : 1.25,
		p95Delta: worst ? Number.POSITIVE_INFINITY : 0.06,
		share: 1,
		isNewest: true,
		health: worst ? "regressed" : "healthy",
	}
}
