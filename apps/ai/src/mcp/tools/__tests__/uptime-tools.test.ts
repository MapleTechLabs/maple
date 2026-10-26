import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
	DeleteUptimeMonitorOutput,
	ListUptimeMonitorsOutput,
	UptimeMonitorMutationOutput,
} from "@maple/domain/mcp-outputs"
import { UptimeMonitorLimitReachedError } from "@maple/domain/http"
import { RoleName } from "@maple/domain/primitives"
import { executeSql } from "@maple/backend/platform/test-pglite"
import type { McpToolResult } from "../types"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { buildUptimeConfig, toMcpUptimeError, updateUptimeConfig } from "../../lib/uptime-monitors"

let member: EvalRuntime
let admin: EvalRuntime
beforeAll(() => {
	member = makeEvalRuntime()
	admin = { ...member, tenant: { ...member.tenant, roles: [Schema.decodeSync(RoleName)("org:admin")] } }
})
afterAll(async () => {
	await member.dispose()
})

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, result: McpToolResult) =>
	Schema.decodeUnknownSync(schema)(result.structuredContent)

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"

describe("create_uptime_monitor", () => {
	it("is refused for a member who is not an org admin", async () => {
		const result = await runToolDirect(member, "create_uptime_monitor", {
			name: "member-api",
			kind: "http",
			url: "https://api.acme.dev/health",
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("only org admins")
	})

	it("creates an http check expecting 2xx and points at the monitor list", async () => {
		const result = await runToolDirect(admin, "create_uptime_monitor", {
			name: "checkout-api",
			kind: "http",
			url: "https://api.acme.dev/health",
			service: "checkout",
		})
		const output = decode(UptimeMonitorMutationOutput, result)
		expect(output.monitor).toMatchObject({
			kind: "http",
			target: "GET https://api.acme.dev/health",
			status: "pending",
			serviceName: "checkout",
			intervalSeconds: 60,
			failuresToDown: 2,
		})
		expect(output.pingCommand).toBeNull()
		expect(markdown(result)).toContain("list_uptime_monitors")
	})

	it("returns a heartbeat's ping URL and a curl line for the job", async () => {
		const result = await runToolDirect(admin, "create_uptime_monitor", {
			name: "nightly-backup",
			kind: "heartbeat",
			heartbeat_interval_seconds: 86400,
		})
		const output = decode(UptimeMonitorMutationOutput, result)
		expect(output.monitor.heartbeatUrl).toMatch(/\/hb\/[\w-]+$/u)
		expect(output.pingCommand).toBe(`curl -fsS -m 10 --retry 3 ${output.monitor.heartbeatUrl}`)
		expect(output.monitor.target).toBe("ping every 24h, 5m grace")
		expect(markdown(result)).toContain(`${output.monitor.heartbeatUrl}/fail`)
	})

	it("names a field that belongs to another kind instead of dropping it", async () => {
		const result = await runToolDirect(admin, "create_uptime_monitor", {
			name: "wrong-field",
			kind: "http",
			url: "https://api.acme.dev/health",
			port: 443,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("port applies to tcp monitors")
	})

	it("refuses an interval outside 30 to 3600 seconds", async () => {
		const result = await runToolDirect(admin, "create_uptime_monitor", {
			name: "too-fast",
			kind: "tcp",
			host: "db.acme.dev",
			port: 5432,
			interval_seconds: 5,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("30 to 3600")
	})
})

describe("list_uptime_monitors", () => {
	it("puts a down monitor first with its error, uptime share and failing trace", async () => {
		const created = decode(
			UptimeMonitorMutationOutput,
			await runToolDirect(admin, "create_uptime_monitor", {
				name: "payments-db",
				kind: "tcp",
				host: "db.acme.dev",
				port: 5432,
			}),
		)
		const at = Date.now() - 60_000
		await executeSql(
			member.testDb,
			`UPDATE uptime_monitor_states SET status = 'down', consecutive_failures = 2,
			 last_check_json = $2, recent_json = $3 WHERE monitor_id = $1`,
			[
				created.monitor.id,
				JSON.stringify({
					at,
					ok: false,
					durationMs: 10000,
					statusCode: null,
					error: "Connection timed out",
					traceId: TRACE_ID,
				}),
				JSON.stringify([
					{ at: at - 120_000, ok: true, durationMs: 12 },
					{ at: at - 60_000, ok: false, durationMs: 10000 },
					{ at: at - 30_000, ok: true, durationMs: 15 },
					{ at, ok: false, durationMs: 10000 },
				]),
			],
		)

		const result = await runToolDirect(member, "list_uptime_monitors", {})
		const output = decode(ListUptimeMonitorsOutput, result)
		expect(output.monitors[0]).toMatchObject({
			name: "payments-db",
			status: "down",
			uptimeRatio: 0.5,
			lastCheck: { error: "Connection timed out", traceId: TRACE_ID },
		})
		expect(output.counts.down).toBe(1)
		expect(markdown(result)).toContain(`inspect_trace trace_id="${TRACE_ID}"`)

		const down = decode(
			ListUptimeMonitorsOutput,
			await runToolDirect(member, "list_uptime_monitors", { status: "down" }),
		)
		expect(down.monitors.map((monitor) => monitor.name)).toEqual(["payments-db"])
	})

	it("hides a heartbeat's ping URL from members and shows it to admins", async () => {
		const created = decode(
			UptimeMonitorMutationOutput,
			await runToolDirect(admin, "create_uptime_monitor", {
				name: "weekly-report",
				kind: "heartbeat",
				heartbeat_interval_seconds: 604800,
			}),
		)
		const pingUrl = created.monitor.heartbeatUrl
		expect(pingUrl).toMatch(/\/hb\/[\w-]+$/u)

		const memberResult = await runToolDirect(member, "list_uptime_monitors", {})
		const memberRow = decode(ListUptimeMonitorsOutput, memberResult).monitors.find(
			(row) => row.id === created.monitor.id,
		)
		expect(memberRow?.heartbeatUrl).toBeNull()
		expect(JSON.stringify(memberResult)).not.toContain("/hb/")

		const adminRow = decode(
			ListUptimeMonitorsOutput,
			await runToolDirect(admin, "list_uptime_monitors", {}),
		).monitors.find((row) => row.id === created.monitor.id)
		expect(adminRow?.heartbeatUrl).toBe(pingUrl)
	})

	it("filters by service", async () => {
		const output = decode(
			ListUptimeMonitorsOutput,
			await runToolDirect(member, "list_uptime_monitors", { service: "checkout" }),
		)
		expect(output.monitors.map((monitor) => monitor.name)).toEqual(["checkout-api"])
	})
})

describe("update_uptime_monitor", () => {
	it("pauses a monitor by name, then resumes it from pending", async () => {
		const paused = decode(
			UptimeMonitorMutationOutput,
			await runToolDirect(admin, "update_uptime_monitor", { monitor: "checkout-api", enabled: false }),
		)
		expect(paused.monitor).toMatchObject({ enabled: false, status: "paused" })

		const resumed = await runToolDirect(admin, "update_uptime_monitor", {
			monitor: "checkout-api",
			enabled: true,
			interval_seconds: 300,
		})
		expect(decode(UptimeMonitorMutationOutput, resumed).monitor).toMatchObject({
			enabled: true,
			status: "pending",
			intervalSeconds: 300,
		})
	})

	it("says which monitors exist when the name matches none", async () => {
		const result = await runToolDirect(admin, "update_uptime_monitor", {
			monitor: "nope",
			enabled: false,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("list_uptime_monitors")
	})
})

describe("delete_uptime_monitor", () => {
	it("asks for confirmation before deleting", async () => {
		const result = await runToolDirect(admin, "delete_uptime_monitor", {
			monitor: "nightly-backup",
			confirm: false,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("confirm=true")
	})

	it("deletes a confirmed monitor so it no longer lists", async () => {
		const result = await runToolDirect(admin, "delete_uptime_monitor", {
			monitor: "nightly-backup",
			confirm: true,
		})
		expect(decode(DeleteUptimeMonitorOutput, result)).toMatchObject({
			deleted: true,
			name: "nightly-backup",
		})
		const listed = decode(
			ListUptimeMonitorsOutput,
			await runToolDirect(member, "list_uptime_monitors", {}),
		)
		expect(listed.monitors.map((monitor) => monitor.name)).not.toContain("nightly-backup")
	})
})

describe("uptime monitor config and errors", () => {
	it("reads the plan limit as how many included monitors the org has used", () => {
		const error = toMcpUptimeError("create_uptime_monitor")(
			new UptimeMonitorLimitReachedError({ message: "limit", limit: 10 }),
		)
		expect(error._tag).toBe("@maple/mcp/errors/McpUnavailableError")
		expect(error.message).toContain("This organization has used its 10 included uptime monitors")
	})

	it("swaps the expected status of an http check and keeps its other assertions", async () => {
		const current = await Effect.runPromise(
			buildUptimeConfig("http", {
				url: "https://api.acme.dev/health",
				max_response_ms: 800,
				body_contains: "ok",
			}),
		)
		const next = await Effect.runPromise(updateUptimeConfig(current, { expected_status: "204" }))
		expect(next).toMatchObject({
			assertions: [
				{ _tag: "status", op: "is", value: "204" },
				{ _tag: "latency", underMs: 800 },
				{ _tag: "body", op: "contains", value: "ok" },
			],
		})
	})

	it("refuses a heartbeat with both an interval and a cron schedule", async () => {
		const exit = await Effect.runPromiseExit(
			buildUptimeConfig("heartbeat", { heartbeat_interval_seconds: 3600, cron: "0 * * * *" }),
		)
		expect(exit._tag).toBe("Failure")
	})
})
