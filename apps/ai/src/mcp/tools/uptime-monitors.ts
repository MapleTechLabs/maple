/**
 * Uptime monitors: Maple checks a URL, port or DNS name on a schedule, or waits for a job's
 * heartbeat pings. Anyone may list them; creating, changing and deleting is admin-only, like
 * the REST routes, since a monitor makes Maple request an operator-chosen host on a schedule.
 */
import { Effect, Schema } from "effect"
import {
	DeleteUptimeMonitorOutput,
	ListUptimeMonitorsOutput,
	UptimeMonitorMutationOutput,
	type UptimeMonitorRow,
} from "@maple/domain/mcp-outputs"
import { decodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import {
	UptimeIntervalSeconds,
	UptimeMonitorKind,
	UptimeMonitorStatus,
	type AlertDestinationId,
	type OrgId,
} from "@maple/domain/primitives"
import { UptimeDnsRecordType, UptimeHttpMethod } from "@maple/domain/uptime"
import { isAdmin, requireAdmin } from "@maple/backend/services/auth/auth"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import {
	buildUptimeConfig,
	DEFAULT_GRACE_SECONDS,
	pingCommand,
	toMcpUptimeError,
	toMonitorRow,
	updateUptimeConfig,
	type UptimeConfigFields,
} from "../lib/uptime-monitors"

const adminOnly = (tool: string) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentMcpTenant
		yield* requireAdmin(
			tenant.roles,
			() =>
				new McpUnavailableError({
					message: `${tool} changes the organization's uptime monitors, which only org admins may do. Ask an admin, or change it in Alerts → Uptime.`,
					capability: "org_admin",
				}),
		)
		return tenant
	})

const decodeInterval = (raw: number | undefined) =>
	raw === undefined
		? Effect.succeed(undefined)
		: Schema.decodeUnknownEffect(UptimeIntervalSeconds)(raw).pipe(
				Effect.mapError(
					() =>
						new McpInvalidInputError({
							message: "interval_seconds must be a whole number from 30 to 3600.",
							parameter: "interval_seconds",
						}),
				),
			)

/** `interval_seconds` and `failures_to_down` drive probes; a heartbeat has neither. */
const refuseProbeSettingsForHeartbeat = (
	kind: UptimeMonitorKind,
	params: {
		readonly interval_seconds?: number | undefined
		readonly failures_to_down?: number | undefined
	},
) => {
	if (kind !== "heartbeat") return Effect.void
	if (params.interval_seconds !== undefined) {
		return Effect.fail(
			new McpInvalidInputError({
				message:
					"interval_seconds applies to http, tcp and dns monitors. A heartbeat's cadence is heartbeat_interval_seconds or cron, plus grace_seconds.",
				parameter: "interval_seconds",
			}),
		)
	}
	if (params.failures_to_down !== undefined) {
		return Effect.fail(
			new McpInvalidInputError({
				message:
					"failures_to_down applies to http, tcp and dns monitors. A heartbeat goes down once a ping is later than its schedule plus grace_seconds.",
				parameter: "failures_to_down",
			}),
		)
	}
	return Effect.void
}

const decodeDestinations = (raw: ReadonlyArray<string> | undefined) =>
	raw === undefined
		? Effect.succeed(undefined)
		: Effect.forEach(raw, P.decodeResourceId("alertDestination", "destination_ids"))

/** A monitor by its id, REST id (`upm_…`) or exact name. */
const resolveMonitor = Effect.fnUntraced(function* (tool: string, orgId: OrgId, ref: string) {
	const service = yield* UptimeMonitorsService
	const monitors = yield* service.list(orgId).pipe(Effect.mapError(toMcpUptimeError(tool)))
	const id = decodePublicId(PublicIdPrefixes.uptimeMonitor, ref.trim()) ?? ref.trim()
	const matches = monitors.filter((monitor) => monitor.id === id || monitor.name === ref.trim())
	const [monitor] = matches
	if (monitor === undefined) {
		return yield* new McpInvalidInputError({
			message: `No uptime monitor named "${ref}". list_uptime_monitors lists them.`,
			parameter: "monitor",
		})
	}
	if (matches.length > 1) {
		return yield* new McpInvalidInputError({
			message: `${matches.length} uptime monitors match "${ref}"; pass one's id instead: ${matches.map((m) => m.id).join(", ")}.`,
			parameter: "monitor",
		})
	}
	return monitor
})

const percent = (ratio: number | null) => (ratio === null ? "-" : `${(ratio * 100).toFixed(1)}%`)

const lastCheckCell = (row: typeof UptimeMonitorRow.Type) => {
	if (row.kind === "heartbeat") return row.lastPingAt === null ? "no ping yet" : `ping ${row.lastPingAt}`
	const check = row.lastCheck
	if (check === null) return "not checked yet"
	const code = check.statusCode === null ? "" : ` ${check.statusCode}`
	const took = check.durationMs === null ? "" : ` in ${Math.round(check.durationMs)} ms`
	return `${check.ok ? "ok" : "failed"}${code}${took} at ${check.at.slice(0, 19)}`
}

/** For a monitor that is down: its failing check's trace, then the service it belongs to. */
const downNext = (row: typeof UptimeMonitorRow.Type): ReadonlyArray<NextCall> => [
	...(row.lastCheck?.traceId != null
		? [
				doc.next(
					"inspect_trace",
					{
						trace_id: row.lastCheck.traceId,
						timestamp: row.lastCheck.at.slice(0, 19).replace("T", " "),
					},
					`the failing check of "${row.name}"`,
				),
			]
		: []),
	...(row.serviceName === null
		? []
		: [doc.next("diagnose_service", { service: row.serviceName }, `the health of ${row.serviceName}`)]),
]

const renderMonitor = (title: string, row: typeof UptimeMonitorRow.Type) => ({
	title,
	notices: [
		...(row.enabled
			? []
			: [
					"The monitor is paused: nothing is checked and no incident opens. update_uptime_monitor enabled=true resumes it.",
				]),
		...(row.status === "down"
			? [`"${row.name}" is down: ${row.lastCheck?.error ?? "its last check failed"}.`]
			: []),
	],
	blocks: [
		doc.fields([
			["Name", row.name],
			["Id", row.id],
			["Kind", row.kind],
			["Target", row.target],
			["Status", row.status],
			["Interval", row.kind === "heartbeat" ? undefined : `${row.intervalSeconds}s`],
			[
				"Down after",
				row.kind === "heartbeat" ? undefined : `${row.failuresToDown} failed checks in a row`,
			],
			["Service", row.serviceName ?? undefined],
			["Destinations", row.destinationIds.length === 0 ? "none" : row.destinationIds.join(", ")],
			["Last check", lastCheckCell(row)],
			[
				"Recent uptime",
				row.recentChecks === 0
					? undefined
					: `${percent(row.uptimeRatio)} of ${row.recentChecks} checks`,
			],
		]),
		// The ping URL is a credential and rendered text can be relayed to chat: it stays in
		// the structured result (admins only) and the monitor's page in Maple.
		...(row.kind === "heartbeat"
			? [
					doc.text(
						"Have the job ping its URL when it succeeds (GET or POST), or the URL plus `/fail` to report a failure. The ping URL and a curl line for the job's last step are in this result's structured output (`monitor.heartbeatUrl`, `pingCommand`) and on the monitor's page in Maple.",
					),
				]
			: []),
	],
	next: [
		...(row.status === "down" ? downNext(row) : []),
		doc.next("list_uptime_monitors", {}, "every monitor's status after its first checks"),
	],
})

const configParameters = {
	url: P.optionalText("http: the public http(s) URL to request"),
	method: P.optionalOneOf(UptimeHttpMethod.literals, "http: request method (default GET)"),
	expected_status: P.optionalText(
		"http: expected status, a class like `2xx` (the default) or an exact code like `204`",
	),
	max_response_ms: P.optionalNumber(
		"http: fail the check when the response takes this many milliseconds or more",
	),
	body_contains: P.optionalText("http: fail the check unless the response body contains this text"),
	host: P.optionalText("tcp: hostname or IP to connect to. dns: the name to resolve"),
	port: P.optionalNumber("tcp: port to connect to (1 to 65535)"),
	record_type: P.optionalOneOf(UptimeDnsRecordType.literals, "dns: record type to query (default A)"),
	expected: P.optionalText("dns: up when any answer equals this; omit to only require that it resolves"),
	heartbeat_interval_seconds: P.optionalNumber("heartbeat: expected seconds between pings (at least 60)"),
	cron: P.optionalText("heartbeat: cron expression of the expected pings, instead of an interval"),
	timezone: P.optionalText("heartbeat: IANA timezone the cron expression runs in (default UTC)"),
	grace_seconds: P.optionalNumber(
		`heartbeat: how late a ping may be before the monitor goes down (0 to 86400, default ${DEFAULT_GRACE_SECONDS})`,
	),
	interval_seconds: P.optionalNumber("http/tcp/dns: seconds between checks, 30 to 3600 (default 60)"),
	failures_to_down: P.optionalNumber(
		"http/tcp/dns: failed checks in a row before the monitor is down, 1 to 10 (default 2)",
	),
	service: P.service("The `service.name` the monitor belongs to: links its failures to that service"),
} as const

const ALIASES = { ...P.SERVICE_ALIASES, hostname: "host" } as const

const configFields = (params: UptimeConfigFields): UptimeConfigFields => ({
	url: params.url,
	method: params.method,
	expected_status: params.expected_status,
	max_response_ms: params.max_response_ms,
	body_contains: params.body_contains,
	host: params.host,
	port: params.port,
	record_type: params.record_type,
	expected: params.expected,
	heartbeat_interval_seconds: params.heartbeat_interval_seconds,
	cron: params.cron,
	timezone: params.timezone,
	grace_seconds: params.grace_seconds,
})

const STATUS_ORDER = { down: 0, pending: 1, up: 2, paused: 3 } as const

export function registerUptimeMonitorTools(server: McpToolRegistrar) {
	server.define({
		name: "list_uptime_monitors",
		title: "List Uptime Monitors",
		description:
			"Every uptime monitor (http, tcp, dns checks run by Maple, and heartbeats your jobs ping) with its status, last check (status code, duration, error, trace id) and the share of its recent checks that passed. Down monitors come first. A failed http/tcp/dns check is a span in the org's traces: inspect_trace reads it.",
		parameters: Schema.Struct({
			status: P.optionalOneOf(UptimeMonitorStatus.literals, "Only monitors in this status"),
			service: P.service("Only monitors linked to this service (exact `service.name`)"),
		}),
		aliases: P.SERVICE_ALIASES,
		output: ListUptimeMonitorsOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Checking uptime monitors"],
		handler: Effect.fn("McpTool.listUptimeMonitors")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* UptimeMonitorsService
			const monitors = yield* service
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpUptimeError("list_uptime_monitors")))
			const canWrite = isAdmin(tenant.roles)
			const rows = monitors.map((monitor) => toMonitorRow(monitor, canWrite))
			const count = (status: keyof typeof STATUS_ORDER) =>
				rows.filter((row) => row.status === status).length
			const shown = rows
				.filter(
					(row) =>
						(params.status === undefined || row.status === params.status) &&
						(params.service === undefined || row.serviceName === params.service),
				)
				.toSorted((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": shown.length })
			return {
				monitors: shown,
				total: shown.length,
				counts: {
					up: count("up"),
					down: count("down"),
					pending: count("pending"),
					paused: count("paused"),
				},
				...(params.status === undefined ? undefined : { statusFilter: params.status }),
				...(params.service === undefined ? undefined : { serviceFilter: params.service }),
			}
		}),
		render: (output) => ({
			title: "Uptime monitors",
			scope: [
				["Status", output.statusFilter],
				["Service", output.serviceFilter],
			],
			...(output.monitors.length === 0
				? {
						empty: {
							message:
								output.statusFilter === undefined && output.serviceFilter === undefined
									? "This organization has no uptime monitors."
									: "No uptime monitor matches these filters.",
							hints: ["create_uptime_monitor adds one (org admins only)."],
						},
					}
				: undefined),
			blocks:
				output.monitors.length === 0
					? []
					: [
							doc.text(
								`${output.counts.down} down, ${output.counts.up} up, ${output.counts.pending} pending, ${output.counts.paused} paused.`,
							),
							doc.table(
								[
									"Name",
									"Kind",
									"Target",
									"Status",
									"Recent uptime",
									"Last check",
									"Error",
									"Trace",
								],
								output.monitors.map((row) => [
									row.name,
									row.kind,
									row.target,
									row.status,
									percent(row.uptimeRatio),
									lastCheckCell(row),
									row.lastCheck?.error ?? "-",
									row.lastCheck?.traceId ?? "-",
								]),
							),
						],
			next: output.monitors
				.filter((row) => row.status === "down")
				.slice(0, 3)
				.flatMap(downNext),
		}),
	})

	server.define({
		name: "create_uptime_monitor",
		title: "Create Uptime Monitor",
		description:
			"Start monitoring an endpoint. kind=http requests `url` and expects `expected_status` (default 2xx), optionally under `max_response_ms` and with `body_contains`; kind=tcp connects to `host`:`port`; kind=dns resolves `host` (`record_type`, optional `expected` answer); kind=heartbeat waits for your job to ping a URL every `heartbeat_interval_seconds` or on a `cron` schedule, plus `grace_seconds`. A monitor that goes down opens an alert incident and notifies `destination_ids`. Admin only. Returns the monitor and, for a heartbeat, its ping URL and a curl line for the job.",
		parameters: Schema.Struct({
			name: P.text("A label for the monitor, unique among the org's monitors and alert rules"),
			kind: P.oneOf(UptimeMonitorKind.literals, "What the monitor checks"),
			...configParameters,
			destination_ids: P.optionalResourceIdList(
				"alertDestination",
				"Alert destinations notified when the monitor goes down (list_alert_destinations lists them)",
			),
		}),
		aliases: ALIASES,
		output: UptimeMonitorMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
		phrases: ["Adding an uptime monitor"],
		handler: Effect.fn("McpTool.createUptimeMonitor")(function* (params) {
			const tenant = yield* adminOnly("create_uptime_monitor")
			yield* refuseProbeSettingsForHeartbeat(params.kind, params)
			const service = yield* UptimeMonitorsService
			const config = yield* buildUptimeConfig(params.kind, configFields(params))
			const intervalSeconds = yield* decodeInterval(params.interval_seconds)
			const destinationIds: ReadonlyArray<AlertDestinationId> | undefined = yield* decodeDestinations(
				params.destination_ids,
			)
			const created = yield* service
				.create(tenant.orgId, {
					name: params.name,
					kind: params.kind,
					config,
					...(intervalSeconds === undefined ? undefined : { intervalSeconds }),
					...(params.failures_to_down === undefined
						? undefined
						: { failuresToDown: params.failures_to_down }),
					...(params.service === undefined ? undefined : { serviceName: params.service }),
					...(destinationIds === undefined ? undefined : { destinationIds }),
					createdBy: tenant.userId,
				})
				.pipe(Effect.mapError(toMcpUptimeError("create_uptime_monitor")))
			return {
				action: "created" as const,
				monitor: toMonitorRow(created, true),
				pingCommand: pingCommand(created.heartbeatUrl),
			}
		}),
		render: (output) => renderMonitor("Uptime monitor created", output.monitor),
	})

	server.define({
		name: "update_uptime_monitor",
		title: "Update Uptime Monitor",
		description:
			"Change an uptime monitor: pause it (enabled=false) or resume it (enabled=true, which restarts it from pending), or change its name, target, assertions, schedule, interval, service or destinations. Fields left out keep their value; a monitor cannot change kind. Admin only.",
		parameters: Schema.Struct({
			monitor: P.text("The monitor's name or id (list_uptime_monitors lists them)"),
			enabled: P.optionalFlag("false pauses the monitor, true resumes it"),
			name: P.optionalText("A new name"),
			...configParameters,
			clear_service: P.optionalFlag("true unlinks the monitor from its service; not with `service`"),
			clear_max_response_ms: P.optionalFlag(
				"http: true removes the response time check; not with `max_response_ms`",
			),
			clear_body_contains: P.optionalFlag(
				"http: true removes the body contains check; not with `body_contains`",
			),
			clear_expected: P.optionalFlag("dns: true removes the expected answer; not with `expected`"),
			destination_ids: P.optionalResourceIdList(
				"alertDestination",
				"Replaces the alert destinations notified when the monitor goes down; [] notifies none",
			),
		}),
		aliases: ALIASES,
		output: UptimeMonitorMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
		phrases: ["Updating an uptime monitor"],
		handler: Effect.fn("McpTool.updateUptimeMonitor")(function* (params) {
			const tenant = yield* adminOnly("update_uptime_monitor")
			const service = yield* UptimeMonitorsService
			const current = yield* resolveMonitor("update_uptime_monitor", tenant.orgId, params.monitor)
			yield* refuseProbeSettingsForHeartbeat(current.kind, params)
			if (params.clear_service === true && params.service !== undefined) {
				return yield* new McpInvalidInputError({
					message: "Pass service to link a service, or clear_service=true to unlink it, not both.",
					parameter: "clear_service",
				})
			}
			const serviceName = params.clear_service === true ? null : params.service
			const config = yield* updateUptimeConfig(current.config, {
				...configFields(params),
				clear_max_response_ms: params.clear_max_response_ms,
				clear_body_contains: params.clear_body_contains,
				clear_expected: params.clear_expected,
			})
			const intervalSeconds = yield* decodeInterval(params.interval_seconds)
			const destinationIds: ReadonlyArray<AlertDestinationId> | undefined = yield* decodeDestinations(
				params.destination_ids,
			)
			const updated = yield* service
				.update(tenant.orgId, current.id, {
					...(params.name === undefined ? undefined : { name: params.name }),
					...(config === undefined ? undefined : { config }),
					...(intervalSeconds === undefined ? undefined : { intervalSeconds }),
					...(params.failures_to_down === undefined
						? undefined
						: { failuresToDown: params.failures_to_down }),
					...(serviceName === undefined ? undefined : { serviceName }),
					...(params.enabled === undefined ? undefined : { enabled: params.enabled }),
					...(destinationIds === undefined ? undefined : { destinationIds }),
					updatedBy: tenant.userId,
				})
				.pipe(Effect.mapError(toMcpUptimeError("update_uptime_monitor")))
			return {
				action: "updated" as const,
				monitor: toMonitorRow(updated, true),
				pingCommand: pingCommand(updated.heartbeatUrl),
			}
		}),
		render: (output) => renderMonitor("Uptime monitor updated", output.monitor),
	})

	server.define({
		name: "delete_uptime_monitor",
		title: "Delete Uptime Monitor",
		description:
			"Delete an uptime monitor and its alert rule. Check spans already in the traces stay. Irreversible; requires confirm=true. To stop it for a while, update_uptime_monitor enabled=false instead. Admin only.",
		parameters: Schema.Struct({
			monitor: P.text("The monitor's name or id"),
			confirm: P.flag("Must be true. There is no undo."),
		}),
		output: DeleteUptimeMonitorOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting an uptime monitor"],
		handler: Effect.fn("McpTool.deleteUptimeMonitor")(function* (params) {
			// A member is refused before being asked to confirm, as create and update are.
			const tenant = yield* adminOnly("delete_uptime_monitor")
			if (params.confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call delete_uptime_monitor with confirm=true to delete "${params.monitor}", or pause it with update_uptime_monitor enabled=false.`,
					parameter: "confirm",
				})
			}
			const service = yield* UptimeMonitorsService
			const monitor = yield* resolveMonitor("delete_uptime_monitor", tenant.orgId, params.monitor)
			yield* service
				.delete(tenant.orgId, monitor.id)
				.pipe(Effect.mapError(toMcpUptimeError("delete_uptime_monitor")))
			return { deleted: true, id: monitor.id, name: monitor.name }
		}),
		render: (output) => ({
			title: "Uptime monitor deleted",
			blocks: [doc.text(`Deleted "${output.name}" (${output.id}) and its alert rule.`)],
			next: [doc.next("list_uptime_monitors", {}, "the monitors that remain")],
		}),
	})
}
