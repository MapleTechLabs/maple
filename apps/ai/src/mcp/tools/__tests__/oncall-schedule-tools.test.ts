/**
 * The on-call tools through the registry: layer input decoded to the service request, people
 * rendered by display name, schedules found by name, and service failures as parameter errors.
 */
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import {
	AlertValidationError,
	OnCallAtResponse,
	OnCallOverrideDocument,
	OnCallOverrideId,
	OnCallOverrideNotFoundError,
	OnCallScheduleDocument,
	OnCallScheduleId,
	OnCallScheduleInUseError,
	OnCallScheduleNotFoundError,
	EscalationChainId,
	OnCallSchedulesListResponse,
	OnCallShiftsResponse,
	ONCALL_LOOKAROUND_MS,
	OrgId,
	UserId,
	type OnCallOverrideCreateRequest,
	type OnCallScheduleCreateRequest,
	type OnCallScheduleUpdateRequest,
} from "@maple/domain/http"
import { encodePublicId } from "@maple/domain/http/v2"
import { ListOnCallSchedulesOutput, WhoIsOnCallOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import type { McpToolResult } from "../types"

const SCHEDULE_ID = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"
const OVERRIDE_ID = "6b5c4d3e-2f10-4b8c-9d8e-7f6a5b4c3d2e"
const MISSING_ID = "9b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e"
const NOW = "2026-11-06T10:00:00.000Z"
const WEEK = {
	name: "Primary",
	participants: ["user_ana", "user_ben", "user_chen"],
	rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
	startsAt: Date.parse("2026-11-09T08:00:00Z"),
} as const

const scheduleDoc = (overrides: Partial<typeof OnCallScheduleDocument.Encoded> = {}) =>
	Schema.decodeSync(OnCallScheduleDocument)({
		id: SCHEDULE_ID,
		name: "Checkout primary",
		description: null,
		timeZone: "Europe/Berlin",
		layers: [WEEK],
		onCallNow: {
			userId: "user_ana",
			startsAt: "2026-11-09T08:00:00.000Z",
			endsAt: "2026-11-16T08:00:00.000Z",
		},
		chainIds: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	})

const notFound = (id: string) =>
	new OnCallScheduleNotFoundError({
		message: "On-call schedule not found",
		scheduleId: Schema.decodeSync(OnCallScheduleId)(id),
	})

interface Seen {
	created?: OnCallScheduleCreateRequest
	updated?: OnCallScheduleUpdateRequest
	overrideCreated?: OnCallOverrideCreateRequest
	deletedSchedule?: string
	deletedOverride?: string
	onCallAt?: number
	/** The service refuses writes as an unknown member. */
	rejectMember?: boolean
	/** An escalation chain still pages the schedule. */
	inUse?: boolean
	/** Ana's shift runs past the 15-day lookaround, so its end is the clamp, not a handoff. */
	longShift?: boolean
}

const rejectMember = () => {
	const message = "Not members of this workspace: user_zed"
	return Effect.fail(new AlertValidationError({ message, details: [message] }))
}

const layer = (seen: Seen) =>
	Layer.mergeAll(
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeSync(OrgId)("org_tools"),
			userId: Schema.decodeSync(UserId)("user_tools"),
			roles: [],
			authMode: "self_hosted",
		}),
		Layer.mock(OnCallSchedulesService)({
			memberNames: () =>
				Effect.succeed(
					new Map([
						["user_ana", "Ana Alves"],
						["user_ben", "Ben Brook"],
					]),
				),
			list: () => Effect.succeed(new OnCallSchedulesListResponse({ schedules: [scheduleDoc()] })),
			get: (_org, id) =>
				id === SCHEDULE_ID ? Effect.succeed(scheduleDoc()) : Effect.fail(notFound(id)),
			create: (_org, _user, _roles, request) => {
				seen.created = request
				if (seen.rejectMember === true) return rejectMember()
				return Effect.succeed(scheduleDoc({ name: request.name, timeZone: request.timeZone }))
			},
			update: (_org, _user, _roles, id, request) => {
				seen.updated = request
				return id === SCHEDULE_ID ? Effect.succeed(scheduleDoc()) : Effect.fail(notFound(id))
			},
			delete: (_org, _roles, id) => {
				seen.deletedSchedule = id
				return seen.inUse === true
					? Effect.fail(
							new OnCallScheduleInUseError({
								message: "in use",
								scheduleId: Schema.decodeSync(OnCallScheduleId)(id),
								chainIds: [
									Schema.decodeSync(EscalationChainId)(
										"3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
									),
								],
								chainNames: ["API escalation"],
							}),
						)
					: Effect.void
			},
			onCallAt: (_org, _id, atMs) => {
				seen.onCallAt = atMs
				if (seen.longShift === true) {
					return Effect.succeed(
						Schema.decodeSync(OnCallAtResponse)({
							at: new Date(atMs).toISOString(),
							shift: {
								userId: "user_ana",
								startsAt: new Date(atMs - ONCALL_LOOKAROUND_MS).toISOString(),
								endsAt: new Date(atMs + ONCALL_LOOKAROUND_MS).toISOString(),
								source: { kind: "layer", layerIndex: 0 },
							},
						}),
					)
				}
				return Effect.succeed(
					Schema.decodeSync(OnCallAtResponse)({
						at: new Date(atMs).toISOString(),
						shift: {
							userId: "user_ben",
							startsAt: "2026-11-12T17:00:00.000Z",
							endsAt: "2026-11-13T08:00:00.000Z",
							source: { kind: "override", overrideId: OVERRIDE_ID },
						},
					}),
				)
			},
			shifts: (_org, _id, fromMs, toMs) =>
				seen.longShift === true
					? // Rendered from the clamp edge: the same shift, carrying on.
						Effect.succeed(
							Schema.decodeSync(OnCallShiftsResponse)({
								from: new Date(fromMs).toISOString(),
								to: new Date(toMs).toISOString(),
								layers: [],
								final: [
									{
										userId: "user_ana",
										startsAt: new Date(fromMs).toISOString(),
										endsAt: new Date(toMs).toISOString(),
										source: { kind: "layer", layerIndex: 0 },
									},
								],
							}),
						)
					: Effect.succeed(
							Schema.decodeSync(OnCallShiftsResponse)({
								from: "2026-11-13T08:00:00.000Z",
								to: "2026-11-27T08:00:00.000Z",
								layers: [],
								final: [
									{
										userId: "user_ana",
										startsAt: "2026-11-13T08:00:00.000Z",
										endsAt: "2026-11-16T08:00:00.000Z",
										source: { kind: "layer", layerIndex: 0 },
									},
								],
							}),
						),
			createOverride: (_org, _user, _roles, id, request) => {
				seen.overrideCreated = request
				if (seen.rejectMember === true) return rejectMember()
				return Effect.succeed(
					Schema.decodeSync(OnCallOverrideDocument)({
						id: OVERRIDE_ID,
						scheduleId: id,
						userId: request.userId,
						startsAt: new Date(request.startsAt).toISOString(),
						endsAt: new Date(request.endsAt).toISOString(),
						createdBy: "user_tools",
						createdAt: NOW,
					}),
				)
			},
			deleteOverride: (_org, _roles, _id, overrideId) => {
				seen.deletedOverride = overrideId
				return overrideId === OVERRIDE_ID
					? Effect.void
					: Effect.fail(
							new OnCallOverrideNotFoundError({
								message: "On-call override not found",
								overrideId: Schema.decodeSync(OnCallOverrideId)(overrideId),
							}),
						)
			},
		}),
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

const ok = async (name: string, params: unknown, seen: Seen = {}) => {
	const result = await run(name, params, seen)
	if (result._tag !== "Success") throw new Error(`${name} failed: ${JSON.stringify(result.failure)}`)
	return result.success
}

const invalidParameter = (result: Awaited<ReturnType<typeof run>>) =>
	result._tag === "Failure" && "parameter" in result.failure ? result.failure.parameter : undefined

const text = (result: McpToolResult) => result.content[0]?.text ?? ""

describe("on-call schedule tools", () => {
	it("list_oncall_schedules names people by display name and falls back to the user id", async () => {
		const result = await ok("list_oncall_schedules", {})
		const output = Schema.decodeUnknownSync(ListOnCallSchedulesOutput)(result.structuredContent)
		expect(output.schedules[0]?.publicId).toBe(encodePublicId("onc", SCHEDULE_ID))
		expect(output.schedules[0]?.onCallNow?.user).toEqual({ userId: "user_ana", name: "Ana Alves" })
		expect(text(result)).toContain("Ana Alves (user_ana) on call until 2026-11-16T08:00:00.000Z")
		expect(text(result)).toContain("Primary: weekly, Monday 09:00")
		expect(text(result)).toContain("Ana Alves, Ben Brook, user_chen")
	})

	it("who_is_on_call finds a schedule by name, reads `at` and says who covers and who is next", async () => {
		const seen: Seen = {}
		const result = await ok(
			"who_is_on_call",
			{ schedule: "checkout PRIMARY", at: "2026-11-12 19:00:00" },
			seen,
		)
		expect(seen.onCallAt).toBe(Date.parse("2026-11-12T19:00:00Z"))
		const output = Schema.decodeUnknownSync(WhoIsOnCallOutput)(result.structuredContent)
		expect(output.onCall?.user).toEqual({ userId: "user_ben", name: "Ben Brook" })
		expect(output.next?.user.userId).toBe("user_ana")
		expect(text(result)).toContain(
			"Ben Brook (user_ben) is on call for Checkout primary at 2026-11-12T19:00:00.000Z, through an override",
		)
		expect(text(result)).toContain("Ana Alves (user_ana) from 2026-11-13T08:00:00.000Z")
	})

	it("who_is_on_call reports no next shift when the current one runs past the lookaround", async () => {
		const result = await ok("who_is_on_call", { schedule: SCHEDULE_ID }, { longShift: true })
		const output = Schema.decodeUnknownSync(WhoIsOnCallOutput)(result.structuredContent)
		expect([output.onCall?.user.userId, output.next]).toEqual(["user_ana", null])
		expect(text(result)).toContain("no handoff within two weeks")
	})

	it("who_is_on_call takes a REST id and refuses an unknown schedule on the parameter", async () => {
		await ok("who_is_on_call", { schedule: encodePublicId("onc", SCHEDULE_ID) })
		const byId = await run("who_is_on_call", { schedule: MISSING_ID }, {})
		const byName = await run("who_is_on_call", { schedule: "Nonexistent rota" }, {})
		expect([invalidParameter(byId), invalidParameter(byName)]).toEqual(["schedule", "schedule"])
	})

	it("create_oncall_schedule decodes JSON layers into the request and maps an unknown member to layers", async () => {
		const seen: Seen = {}
		await ok(
			"create_oncall_schedule",
			{
				name: "Checkout primary",
				time_zone: "Europe/Berlin",
				layers: JSON.stringify([
					{
						name: "Primary",
						participants: ["user_ana", "user_ben"],
						rotation: { kind: "weekly", handoff_weekday: "mon", handoff_time: "09:00" },
						starts_at: "2026-11-09T08:00:00.000Z",
						restrictions: [{ weekdays: ["mon"], start_time: "18:00", end_time: "08:00" }],
					},
				]),
			},
			seen,
		)
		expect(seen.created?.layers).toEqual([
			{
				name: "Primary",
				participants: ["user_ana", "user_ben"],
				rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
				startsAt: Date.parse("2026-11-09T08:00:00Z"),
				restrictions: [{ weekdays: ["mon"], startTime: "18:00", endTime: "08:00" }],
			},
		])

		const empty = await run("create_oncall_schedule", { name: "E", time_zone: "UTC", layers: [] }, {})
		// Rejected by the parameter schema before the handler runs.
		expect(empty._tag === "Failure" ? empty.failure.message : "").toContain("`layers`")
		const badZone = await run(
			"create_oncall_schedule",
			{
				name: "Z",
				time_zone: "Mars/Olympus",
				layers: [
					{
						...WEEK,
						participants: ["user_ana"],
						rotation: { kind: "daily", handoff_time: "09:00" },
						starts_at: NOW,
					},
				],
			},
			{},
		)
		expect(invalidParameter(badZone)).toBe("time_zone")
		const stranger = await run(
			"create_oncall_schedule",
			{
				name: "S",
				time_zone: "UTC",
				layers: [
					{
						name: "P",
						participants: ["user_zed"],
						rotation: { kind: "custom", length_hours: 12 },
						starts_at: NOW,
					},
				],
			},
			{ rejectMember: true },
		)
		expect(invalidParameter(stranger)).toBe("layers")
	})

	it("update_oncall_schedule sends only the given fields and needs at least one", async () => {
		const seen: Seen = {}
		await ok(
			"update_oncall_schedule",
			{ schedule_id: encodePublicId("onc", SCHEDULE_ID), name: "Renamed" },
			seen,
		)
		expect(seen.updated).toEqual({ name: "Renamed" })
		const nothing = await run("update_oncall_schedule", { schedule_id: SCHEDULE_ID }, {})
		expect(invalidParameter(nothing)).toBe("layers")
		const missing = await run("update_oncall_schedule", { schedule_id: MISSING_ID, name: "x" }, {})
		expect(invalidParameter(missing)).toBe("schedule_id")
	})

	it("create_oncall_override converts times and names who covers; delete maps an unknown override", async () => {
		const seen: Seen = {}
		const created = await ok(
			"create_oncall_override",
			{
				schedule_id: SCHEDULE_ID,
				user_id: "user_ben",
				starts_at: "2026-11-12T17:00:00Z",
				ends_at: "2026-11-13 08:00:00",
			},
			seen,
		)
		expect(seen.overrideCreated).toEqual({
			userId: "user_ben",
			startsAt: Date.parse("2026-11-12T17:00:00Z"),
			endsAt: Date.parse("2026-11-13T08:00:00Z"),
		})
		expect(text(created)).toContain(
			"Ben Brook (user_ben) covers Checkout primary from 2026-11-12T17:00:00.000Z",
		)

		const stranger = await run(
			"create_oncall_override",
			{
				schedule_id: SCHEDULE_ID,
				user_id: "user_zed",
				starts_at: NOW,
				ends_at: "2026-11-07T10:00:00Z",
			},
			{ rejectMember: true },
		)
		expect(invalidParameter(stranger)).toBe("user_id")

		const deleteSeen: Seen = {}
		await ok(
			"delete_oncall_override",
			{ schedule_id: SCHEDULE_ID, override_id: encodePublicId("ovr", OVERRIDE_ID) },
			deleteSeen,
		)
		expect(deleteSeen.deletedOverride).toBe(OVERRIDE_ID)
		const unknown = await run(
			"delete_oncall_override",
			{ schedule_id: SCHEDULE_ID, override_id: MISSING_ID },
			{},
		)
		expect(invalidParameter(unknown)).toBe("override_id")
	})

	it("delete_oncall_schedule names what it deleted and refuses an unknown schedule", async () => {
		const seen: Seen = {}
		const result = await ok("delete_oncall_schedule", { schedule_id: SCHEDULE_ID }, seen)
		expect(seen.deletedSchedule).toBe(SCHEDULE_ID)
		expect(text(result)).toContain("Checkout primary")
		const missing = await run("delete_oncall_schedule", { schedule_id: MISSING_ID }, {})
		expect(invalidParameter(missing)).toBe("schedule_id")
		const inUse = await run("delete_oncall_schedule", { schedule_id: SCHEDULE_ID }, { inUse: true })
		expect(invalidParameter(inUse)).toBe("schedule_id")
		expect(inUse._tag === "Failure" ? inUse.failure.message : "").toContain('"API escalation"')
	})
})
