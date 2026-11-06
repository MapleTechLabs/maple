/**
 * The alert silence tools through the registry: matcher and window validation as invalid input,
 * the request the service receives, the default status filter, and silences on the timeline.
 */
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Schema, Array as Arr } from "effect"
import {
	AlertIncidentsListResponse,
	AlertSilenceCreateRequest,
	AlertSilenceDocument,
	AlertSilenceNotFoundError,
	AlertSilencesListResponse,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { GetIncidentTimelineOutput, ListAlertSilencesOutput } from "@maple/domain/mcp-outputs"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import type { McpToolResult } from "../types"

const RULE_ID = "7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const ACTIVE_ID = "a1111111-2222-4333-8444-555555555555"
const SCHEDULED_ID = "b1111111-2222-4333-8444-555555555555"
const ENDED_ID = "c1111111-2222-4333-8444-555555555555"
const INCIDENT_ID = "11111111-2222-4333-8444-555555555555"
const NOW = "2026-09-24T10:00:00.000Z"

const silence = (id: string, status: "scheduled" | "active" | "ended", reason: string) =>
	Schema.decodeSync(AlertSilenceDocument)({
		id,
		reason,
		matchers: { services: ["checkout"] },
		status,
		startsAt: NOW,
		endsAt: "2026-09-24T12:00:00.000Z",
		createdBy: "user_tools",
		createdAt: NOW,
		updatedAt: NOW,
	})

const stored = [
	silence(ACTIVE_ID, "active", "Checkout deploy"),
	silence(SCHEDULED_ID, "scheduled", "DB maintenance"),
	silence(ENDED_ID, "ended", "Old outage"),
]

interface Seen {
	created?: AlertSilenceCreateRequest
	listedStatuses: Array<string | undefined>
	ended?: string
}

const layer = (seen: Seen) =>
	Layer.mergeAll(
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeSync(OrgId)("org_tools"),
			userId: Schema.decodeSync(UserId)("user_tools"),
			roles: [],
			authMode: "self_hosted",
		} as never),
		Layer.succeed(AlertSilencesService, {
			list: (_org: unknown, options: { readonly status?: string } = {}) => {
				seen.listedStatuses.push(options.status)
				return Effect.succeed(
					new AlertSilencesListResponse({
						silences: Arr.filter(
							stored,
							(s) => options.status === undefined || s.status === options.status,
						),
					}),
				)
			},
			get: (_org: unknown, id: string) => {
				const found = Arr.findFirst(stored, (s) => s.id === id)
				return found._tag === "Some"
					? Effect.succeed(found.value)
					: Effect.fail(
							new AlertSilenceNotFoundError({ message: "not found", silenceId: id as never }),
						)
			},
			create: (_org: unknown, _user: unknown, _roles: unknown, request: AlertSilenceCreateRequest) => {
				seen.created = request
				return Effect.succeed(
					Schema.decodeSync(AlertSilenceDocument)({
						...Schema.encodeSync(AlertSilenceDocument)(stored[0]!),
						reason: request.reason,
						matchers: request.matchers,
						endsAt: request.endsAt,
					}),
				)
			},
			end: (_org: unknown, _user: unknown, _roles: unknown, id: string) => {
				seen.ended = id
				return id === ACTIVE_ID
					? Effect.succeed(silence(ACTIVE_ID, "ended", "Checkout deploy"))
					: Effect.fail(
							new AlertSilenceNotFoundError({ message: "not found", silenceId: id as never }),
						)
			},
		} as never),
		Layer.succeed(AlertReadModelsService, {
			listIncidents: () =>
				Effect.succeed(
					Schema.decodeSync(AlertIncidentsListResponse)({
						incidents: [
							{
								id: INCIDENT_ID,
								ruleId: RULE_ID,
								ruleName: "Checkout errors",
								groupKey: "checkout",
								signalType: "error_rate",
								severity: "critical",
								status: "open",
								comparator: "gt",
								threshold: 0.05,
								thresholdUpper: null,
								peakSeverity: null,
								firstTriggeredAt: NOW,
								lastTriggeredAt: NOW,
								resolvedAt: null,
								lastObservedValue: 0.12,
								lastSampleCount: 100,
								dedupeKey: "k",
								lastDeliveredEventType: null,
								lastNotifiedAt: null,
								holdReason: null,
								heldSince: null,
								errorIssueId: null,
								silenceId: ACTIVE_ID,
								silencedAt: NOW,
							},
						],
					}),
				),
		} as never),
	)

// The registry's requirement union names every tool's services; these tools reach only the
// ones `layer` provides, so the rest are left absent (a defect if ever reached).
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const run = (name: string, params: unknown, seen: Seen) =>
	Effect.runPromise(
		executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(
			Effect.provide(layer(seen)),
			Effect.result,
			withoutUnreachedServices,
		),
	)

const ok = async (name: string, params: unknown, seen: Seen) => {
	const result = await run(name, params, seen)
	if (result._tag !== "Success") throw new Error(`${name} failed: ${JSON.stringify(result.failure)}`)
	return result.success
}

const invalidParameter = (result: Awaited<ReturnType<typeof run>>) =>
	result._tag === "Failure" && "parameter" in result.failure ? result.failure.parameter : undefined

const text = (result: McpToolResult) => result.content[0]?.text ?? ""
const fresh = (): Seen => ({ listedStatuses: [] })

describe("alert silence tools", () => {
	it("create_alert_silence turns a duration into an end time and passes the matchers", async () => {
		const seen = fresh()
		const result = await ok(
			"create_alert_silence",
			{
				reason: "Checkout deploy",
				rule_ids: [RULE_ID],
				services: "checkout",
				tags: [],
				duration_minutes: "90",
			},
			seen,
		)
		expect(seen.created?.matchers).toEqual({ ruleIds: [RULE_ID], services: ["checkout"] })
		expect(seen.created?.startsAt).toBeUndefined()
		const endsInMs = Date.parse(seen.created?.endsAt ?? "") - Date.now()
		expect(endsInMs).toBeGreaterThan(89 * 60_000)
		expect(endsInMs).toBeLessThanOrEqual(90 * 60_000)
		expect(text(result)).toContain("Reason: Checkout deploy")
		expect(text(result)).toContain(`\`end_alert_silence silence_id="${ACTIVE_ID}"\``)
	})

	it("create_alert_silence ends a duration after an explicit start", async () => {
		const seen = fresh()
		await ok(
			"create_alert_silence",
			{
				reason: "Window",
				tags: ["payments"],
				starts_at: "2030-01-01 00:00:00",
				duration_minutes: 30,
			},
			seen,
		)
		expect(seen.created?.startsAt).toBe("2030-01-01T00:00:00.000Z")
		expect(seen.created?.endsAt).toBe("2030-01-01T00:30:00.000Z")
	})

	it("create_alert_silence refuses a silence with no matcher", async () => {
		const seen = fresh()
		const result = await run(
			"create_alert_silence",
			{ reason: "Everything", services: [], duration_minutes: 30 },
			seen,
		)
		expect(invalidParameter(result)).toBe("rule_ids")
		expect(seen.created).toBeUndefined()
	})

	it("create_alert_silence needs exactly one of duration_minutes and ends_at", async () => {
		const seen = fresh()
		const both = await run(
			"create_alert_silence",
			{ reason: "x", tags: ["a"], duration_minutes: 30, ends_at: "2030-01-01T00:00:00Z" },
			seen,
		)
		expect(invalidParameter(both)).toBe("duration_minutes")
		const neither = await run("create_alert_silence", { reason: "x", tags: ["a"] }, seen)
		expect(invalidParameter(neither)).toBe("duration_minutes")
		expect(seen.created).toBeUndefined()
	})

	it("list_alert_silences shows active and scheduled silences by default, not ended ones", async () => {
		const seen = fresh()
		const result = await ok("list_alert_silences", {}, seen)
		const output = Schema.decodeUnknownSync(ListAlertSilencesOutput)(result.structuredContent)
		expect(Arr.map(output.silences, (s) => s.id)).toEqual([ACTIVE_ID, SCHEDULED_ID])
		expect(output.status).toBeUndefined()
		expect(text(result)).not.toContain("Old outage")

		const ended = await ok("list_alert_silences", { status: "ended" }, fresh())
		expect(text(ended)).toContain("Old outage")
	})

	it("end_alert_silence ends by id and maps an unknown one to silence_id", async () => {
		const seen = fresh()
		const result = await ok("end_alert_silence", { silence_id: ACTIVE_ID }, seen)
		expect(seen.ended).toBe(ACTIVE_ID)
		expect(text(result)).toContain("Status: ended")

		const missing = await run("end_alert_silence", { silence_id: INCIDENT_ID }, fresh())
		expect(invalidParameter(missing)).toBe("silence_id")
		const malformed = await run("end_alert_silence", { silence_id: "nope" }, fresh())
		expect(invalidParameter(malformed)).toBe("silence_id")
	})

	it("get_incident_timeline names the silence holding back an incident's notifications", async () => {
		const result = await ok("get_incident_timeline", {}, fresh())
		const output = Schema.decodeUnknownSync(GetIncidentTimelineOutput)(result.structuredContent)
		expect(output.incidents[0]?.silenceReason).toBe("Checkout deploy")
		expect(text(result)).toContain(`held back by silence "Checkout deploy" (${ACTIVE_ID})`)
	})
})
