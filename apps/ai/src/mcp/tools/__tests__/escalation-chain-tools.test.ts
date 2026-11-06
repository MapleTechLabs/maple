/**
 * The escalation chain tools through the registry: step input decoded to the service request,
 * steps rendered with destination names, and service failures as input errors on the parameter.
 */
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Schema, Array as Arr } from "effect"
import {
	AlertDestinationsListResponse,
	AlertValidationError,
	EscalationChainDocument,
	EscalationChainId,
	EscalationChainInUseError,
	EscalationChainNotFoundError,
	EscalationChainsListResponse,
	OnCallSchedulesListResponse,
	OrgId,
	UserId,
	type EscalationChainCreateRequest,
	type EscalationChainUpdateRequest,
} from "@maple/domain/http"
import { encodePublicId } from "@maple/domain/http/v2"
import { ListEscalationChainsOutput } from "@maple/domain/mcp-outputs"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import type { McpToolResult } from "../types"

const CHAIN_ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"
const MISSING_ID = "9b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e"
const RULE_ID = "7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const PRIMARY = "0e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b"
const SECONDARY = "1f2e3d4c-5b6a-4798-8a0b-2c3d4e5f6a7b"
const SCHEDULE = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d"
const NOW = "2026-11-06T10:00:00.000Z"

const chainDoc = (overrides: Partial<typeof EscalationChainDocument.Encoded> = {}) =>
	Schema.decodeSync(EscalationChainDocument)({
		id: CHAIN_ID,
		name: "Checkout on-call",
		description: null,
		steps: [
			{ targets: [{ type: "destination", destinationId: PRIMARY }], waitMinutes: 10 },
			{ targets: [{ type: "destination", destinationId: SECONDARY }], waitMinutes: 90 },
		],
		repeatCount: 1,
		ruleIds: [RULE_ID],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	})

const notFound = (id: string) =>
	new EscalationChainNotFoundError({
		message: "Escalation chain not found",
		chainId: Schema.decodeSync(EscalationChainId)(id),
	})

interface Seen {
	created?: EscalationChainCreateRequest
	updated?: EscalationChainUpdateRequest
	deleted?: string
	/** The service refuses creates as an unknown destination. */
	rejectCreate?: boolean
	/** The chain is still named by a rule. */
	inUse?: boolean
}

const layer = (seen: Seen) =>
	Layer.mergeAll(
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeSync(OrgId)("org_tools"),
			userId: Schema.decodeSync(UserId)("user_tools"),
			roles: [],
			authMode: "self_hosted",
		}),
		Layer.mock(EscalationChainsService)({
			list: () => Effect.succeed(new EscalationChainsListResponse({ chains: [chainDoc()] })),
			get: (_org, id) => (id === CHAIN_ID ? Effect.succeed(chainDoc()) : Effect.fail(notFound(id))),
			create: (_org, _user, _roles, request) => {
				seen.created = request
				if (seen.rejectCreate === true) {
					const message = "An escalation step names a destination that does not exist"
					return Effect.fail(new AlertValidationError({ message, details: [message] }))
				}
				return Effect.succeed(
					chainDoc({
						name: request.name,
						steps: request.steps,
						repeatCount: request.repeatCount ?? 0,
						ruleIds: [],
					}),
				)
			},
			update: (_org, _user, _roles, id, request) => {
				seen.updated = request
				return id === CHAIN_ID
					? Effect.succeed(chainDoc(request.name === undefined ? {} : { name: request.name }))
					: Effect.fail(notFound(id))
			},
			delete: (_org, _roles, id) => {
				seen.deleted = id
				return seen.inUse === true
					? Effect.fail(
							new EscalationChainInUseError({
								message: "in use",
								chainId: Schema.decodeSync(EscalationChainId)(id),
								ruleIds: chainDoc().ruleIds,
								ruleNames: ["Checkout errors"],
							}),
						)
					: Effect.void
			},
		}),
		Layer.mock(OnCallSchedulesService)({
			memberNames: () => Effect.succeed(new Map([["user_ana", "Ana Alves"]])),
			list: () =>
				Effect.succeed(
					Schema.decodeSync(OnCallSchedulesListResponse)({
						schedules: [
							{
								id: SCHEDULE,
								name: "API primary",
								description: null,
								timeZone: "Europe/Berlin",
								layers: [
									{
										name: "Primary",
										participants: ["user_ana"],
										rotation: {
											kind: "weekly",
											handoffWeekday: "mon",
											handoffTime: "09:00",
										},
										startsAt: Date.parse(NOW),
									},
								],
								onCallNow: null,
								chainIds: [CHAIN_ID],
								createdAt: NOW,
								updatedAt: NOW,
							},
						],
					}),
				),
		}),
		Layer.mock(AlertsService)({
			listDestinations: () =>
				Effect.succeed(
					Schema.decodeSync(AlertDestinationsListResponse)({
						destinations: Arr.map(
							[
								[PRIMARY, "Primary pager", "pagerduty"],
								[SECONDARY, "Ops channel", "webhook"],
							] as const,
							([id, name, type]) => ({
								id,
								name,
								type,
								enabled: true,
								summary: name,
								channelLabel: null,
								memberUserIds: null,
								lastTestedAt: null,
								lastTestError: null,
								createdAt: NOW,
								updatedAt: NOW,
							}),
						),
					}),
				),
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

describe("escalation chain tools", () => {
	it("list_escalation_chains renders each step with its destinations and wait", async () => {
		const result = await ok("list_escalation_chains", {})
		const output = Schema.decodeUnknownSync(ListEscalationChainsOutput)(result.structuredContent)
		expect(output.chains[0]?.publicId).toBe(encodePublicId("esc", CHAIN_ID))
		expect(output.chains[0]?.steps[1]?.targets[0]?.name).toBe("Ops channel")
		expect(text(result)).toContain(
			`1. notify Primary pager (pagerduty, ${encodePublicId("dest", PRIMARY)}), then wait 10m for an ack`,
		)
		expect(text(result)).toContain(
			`2. notify Ops channel (webhook, ${encodePublicId("dest", SECONDARY)}), then wait 1h 30m for an ack`,
		)
		expect(text(result)).toContain("repeats 1 more time")
	})

	it("list_escalation_chains shows the esc_ and dest_ ids create shows", async () => {
		const listed = await ok("list_escalation_chains", {})
		const created = await ok("create_escalation_chain", {
			name: "Checkout on-call",
			steps: JSON.stringify([{ destination_ids: [PRIMARY], wait_minutes: 10 }]),
		})
		const output = Schema.decodeUnknownSync(ListEscalationChainsOutput)(listed.structuredContent)
		expect(output.chains[0]?.steps[0]?.targets[0]?.publicId).toBe(encodePublicId("dest", PRIMARY))
		for (const result of [listed, created]) {
			expect(text(result)).toContain(encodePublicId("esc", CHAIN_ID))
			expect(text(result)).toContain(CHAIN_ID)
			expect(text(result)).toContain(encodePublicId("dest", PRIMARY))
		}
	})

	it("create and update report a bad field against the parameter it came from", async () => {
		const step = [{ destination_ids: [PRIMARY], wait_minutes: 10 }]
		const failures = await Promise.all([
			run("create_escalation_chain", { name: "Loop", steps: step, repeat_count: 6 }, {}),
			run("create_escalation_chain", { name: " padded ", steps: step }, {}),
			run("create_escalation_chain", { name: "Notes", steps: step, description: "x".repeat(501) }, {}),
			run("create_escalation_chain", { name: "Slow", steps: [{ ...step[0], wait_minutes: 0 }] }, {}),
			run("update_escalation_chain", { chain_id: CHAIN_ID, repeat_count: 6 }, {}),
			run("update_escalation_chain", { chain_id: CHAIN_ID, name: "x".repeat(121) }, {}),
			run("create_escalation_chain", { name: "Silent", steps: [{ wait_minutes: 5 }] }, {}),
			run(
				"create_escalation_chain",
				{
					name: "Wide",
					steps: [
						{
							destination_ids: Arr.makeBy(6, () => PRIMARY),
							schedule_ids: Arr.makeBy(5, () => SCHEDULE),
							wait_minutes: 5,
						},
					],
				},
				{},
			),
		])
		expect(Arr.map(failures, invalidParameter)).toEqual([
			"repeat_count",
			"name",
			"description",
			"steps",
			"repeat_count",
			"name",
			"steps",
			"steps",
		])
		const messages = Arr.map(failures, (result) =>
			result._tag === "Failure" ? result.failure.message : "",
		)
		expect(messages[0]).toContain("repeat_count: Expected a value less than or equal to 5")
		expect(messages[3]).toContain("steps[0].wait_minutes: Expected a value greater than or equal to 1")
		expect(messages[6]).toBe(
			"steps[0]: needs at least one id in destination_ids, user_ids or schedule_ids",
		)
		expect(messages[7]).toContain(
			"steps[0]: destination_ids, user_ids and schedule_ids together: Expected",
		)
	})

	it("create_escalation_chain decodes REST destination ids and JSON steps into the request", async () => {
		const seen: Seen = {}
		const result = await ok(
			"create_escalation_chain",
			{
				name: "Checkout on-call",
				steps: JSON.stringify([
					{ destination_ids: [encodePublicId("dest", PRIMARY)], wait_minutes: 5 },
					{ destination_ids: [SECONDARY, PRIMARY], wait_minutes: 15 },
				]),
				repeat_count: 2,
			},
			seen,
		)
		expect(seen.created?.steps).toEqual([
			{ targets: [{ type: "destination", destinationId: PRIMARY }], waitMinutes: 5 },
			{
				targets: [
					{ type: "destination", destinationId: SECONDARY },
					{ type: "destination", destinationId: PRIMARY },
				],
				waitMinutes: 15,
			},
		])
		expect(seen.created?.repeatCount).toBe(2)
		expect(text(result)).toContain(
			`2. notify Ops channel (webhook, ${encodePublicId("dest", SECONDARY)}), Primary pager (pagerduty, ${encodePublicId("dest", PRIMARY)}), then wait 15m`,
		)
	})

	it("create_escalation_chain pages members and on-call schedules, and names them in the steps", async () => {
		const seen: Seen = {}
		const result = await ok(
			"create_escalation_chain",
			{
				name: "API on-call",
				steps: JSON.stringify([
					{
						schedule_ids: [encodePublicId("onc", SCHEDULE)],
						user_ids: ["user_ana"],
						wait_minutes: 5,
					},
					{ destination_ids: [PRIMARY], wait_minutes: 10 },
				]),
			},
			seen,
		)
		expect(seen.created?.steps).toEqual([
			{
				targets: [
					{ type: "user", userId: "user_ana" },
					{ type: "schedule", scheduleId: SCHEDULE },
				],
				waitMinutes: 5,
			},
			{ targets: [{ type: "destination", destinationId: PRIMARY }], waitMinutes: 10 },
		])
		expect(text(result)).toContain(
			`1. notify Ana Alves (user_ana), whoever is on call on API primary (${encodePublicId("onc", SCHEDULE)}), then wait 5m`,
		)
		const badSchedule = await run(
			"create_escalation_chain",
			{ name: "Bad", steps: [{ schedule_ids: ["dest_nope"], wait_minutes: 5 }] },
			{},
		)
		expect(invalidParameter(badSchedule)).toBe("steps")
	})

	it("create_escalation_chain refuses bad steps before the service and maps an unknown destination to steps", async () => {
		const seen: Seen = {}
		const empty = await run("create_escalation_chain", { name: "Empty", steps: [] }, seen)
		const tooLong = await run(
			"create_escalation_chain",
			{ name: "Slow", steps: [{ destination_ids: [PRIMARY], wait_minutes: 2000 }] },
			seen,
		)
		const badId = await run(
			"create_escalation_chain",
			{ name: "Bad", steps: [{ destination_ids: ["alrt_nope"], wait_minutes: 5 }] },
			seen,
		)
		for (const result of [empty, tooLong, badId]) expect(invalidParameter(result)).toBe("steps")
		expect(seen.created).toBeUndefined()

		const rejected = await run(
			"create_escalation_chain",
			{ name: "Ghost", steps: [{ destination_ids: [MISSING_ID], wait_minutes: 5 }] },
			{ rejectCreate: true },
		)
		expect(invalidParameter(rejected)).toBe("steps")
	})

	it("update_escalation_chain sends only the given fields and needs at least one", async () => {
		const seen: Seen = {}
		await ok(
			"update_escalation_chain",
			{ chain_id: encodePublicId("esc", CHAIN_ID), name: "Renamed" },
			seen,
		)
		expect(seen.updated).toEqual({ name: "Renamed" })

		const nothing = await run("update_escalation_chain", { chain_id: CHAIN_ID }, {})
		expect(invalidParameter(nothing)).toBe("steps")
		const missing = await run("update_escalation_chain", { chain_id: MISSING_ID, repeat_count: 0 }, {})
		expect(invalidParameter(missing)).toBe("chain_id")
	})

	it("delete_escalation_chain names the rules that still use a chain", async () => {
		const seen: Seen = {}
		const result = await ok("delete_escalation_chain", { chain_id: CHAIN_ID }, seen)
		expect(seen.deleted).toBe(CHAIN_ID)
		expect(text(result)).toContain("Checkout on-call")

		const inUse = await run("delete_escalation_chain", { chain_id: CHAIN_ID }, { inUse: true })
		expect(invalidParameter(inUse)).toBe("chain_id")
		expect(inUse._tag === "Failure" ? inUse.failure.message : "").toContain(
			`"Checkout errors" (${RULE_ID})`,
		)

		const missing = await run("delete_escalation_chain", { chain_id: MISSING_ID }, {})
		expect(invalidParameter(missing)).toBe("chain_id")
	})
})
