import {
	chatConnectorId,
	ChatOutboundError,
	socketIngress,
	type ChatBlock,
	type ChatTarget,
} from "@maple/chat-platform"
import {
	AlertRuleUpsertRequest,
	AlertValidationError,
	EscalationChainCreateRequest,
	OnCallOverrideCreateRequest,
	OnCallScheduleCreateRequest,
	OnCallScheduleInUseError,
	WebhookAlertDestinationConfig,
	type EscalationStep,
	type OrgId,
} from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer, Ref, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	ChatConnectorRegistry,
	type RegisteredChatConnector,
} from "@maple/backend/services/integrations/chat-outbound"
import { OrgMembersService, type OrgMember } from "@maple/backend/services/org/OrgMembersService"
import { AlertsService, type AlertsServiceApi } from "./AlertsService"
import { AlertIncidentAckService } from "./AlertIncidentAckService"
import { ChatAlertPoster } from "./ChatAlertPoster"
import { EscalationChainsService } from "./EscalationChainsService"
import { OnCallSchedulesService } from "./OnCallSchedulesService"
import {
	adminRoles,
	asOrgId,
	asUserId,
	getError,
	makeLayer,
	makeWarehouseStub,
	okFetch,
	stubEmailService,
	stubOrgMembersService,
	tracesRow,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ana = asUserId("user_ana")
const ben = asUserId("user_ben")
const chen = asUserId("user_chen")
const MEMBERS: ReadonlyArray<OrgMember> = [
	{ userId: ana, email: "ana@acme.test", name: "Ana Alves", imageUrl: null },
	{ userId: ben, email: "ben@acme.test", name: "Ben Brook", imageUrl: null },
	{ userId: chen, email: "chen@acme.test", name: null, imageUrl: null },
]
const SLACK = chatConnectorId("slack")
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444"
const at = (iso: string) => Date.parse(iso)
/** Tuesday of Ana's week: the weekly rotation hands off Monday 09:00 Berlin. */
const NOW = at("2026-11-10T10:00:00Z")

type PostMode = "ok" | "permanent" | "transient"

interface FakeChat {
	readonly mode: Ref.Ref<PostMode>
	readonly opened: Array<{ readonly workspaceId: string; readonly userId: string }>
	readonly posted: Array<{ readonly target: ChatTarget; readonly blocks: ReadonlyArray<ChatBlock> }>
	readonly attempts: Array<PostMode>
}

const unreachable = () => Effect.die("the page reached another transport method")

/** A Slack stand-in: a DM is the user's own channel, and each post answers as `mode` says. */
const fakeSlack = (chat: FakeChat): RegisteredChatConnector => ({
	id: SLACK,
	manifest: {
		id: SLACK,
		name: "Slack",
		description: "A connector that exists only in this test.",
		icon: { viewBox: "0 0 24 24", paths: [] },
		accent: "#000000",
		settingsFields: [],
	},
	install: {
		requiredConfig: [],
		authorizeUrl: unreachable,
		complete: unreachable,
		decodeSettings: unreachable,
	},
	outbound: {
		connectorId: SLACK,
		limits: { maxMessageChars: 1000, minEditInterval: Duration.millis(500) },
		requiredConfig: [],
		transport: Effect.succeed({
			post: (target, blocks) =>
				Effect.flatMap(Ref.get(chat.mode), (mode) => {
					chat.attempts.push(mode)
					if (mode === "ok") {
						chat.posted.push({ target, blocks })
						return Effect.succeed({ target, messageId: "ts-1" })
					}
					return Effect.fail(
						new ChatOutboundError({
							message:
								mode === "permanent"
									? "Slack refused the call: messages_tab_disabled"
									: "Slack answered 503",
							connectorId: SLACK,
							operation: "post",
							...(mode === "permanent" ? { reason: "not_found" as const } : undefined),
						}),
					)
				}),
			directMessage: (workspaceId, userId) =>
				Effect.sync(() => {
					chat.opened.push({ workspaceId, userId })
					return { workspaceId, channelId: userId }
				}),
			edit: unreachable,
			whisper: unreachable,
			typing: unreachable,
			openThread: unreachable,
			conversation: unreachable,
			history: unreachable,
			destinations: unreachable,
		}),
	},
	ingress: socketIngress({
		requiredConfig: [],
		stateSchema: Schema.String,
		initialState: "",
		connectUrl: () => "wss://chat.test/gateway",
		onOpen: (state) => ({ state }),
		onFrame: (state) => ({ state }),
		onClose: (state) => ({ state }),
		heartbeat: (state) => ({ state }),
	}),
})

const errorRate = (value: number): ReadonlyArray<Record<string, unknown>> => [
	tracesRow({
		count: 200,
		avgDuration: 40,
		p50Duration: 20,
		p95Duration: 120,
		p99Duration: 240,
		errorRate: value,
		satisfiedCount: 180,
		toleratingCount: 10,
		apdexScore: 0.925,
	}),
]

const layerFor = (
	testDb: TestDb,
	state: { tracesAggregateRows: ReadonlyArray<Record<string, unknown>> },
	emails: Array<{ to: string; subject: string; html: string }>,
	chat: FakeChat,
) => {
	const members = Layer.succeed(OrgMembersService, stubOrgMembersService(MEMBERS))
	return Layer.mergeAll(
		makeLayer(
			testDb,
			makeWarehouseStub(state),
			{ fetch: okFetch },
			stubEmailService(emails),
			ChatAlertPoster.layer.pipe(
				Layer.provide(Layer.succeed(ChatConnectorRegistry, [fakeSlack(chat)])),
			),
			MEMBERS,
		),
		Layer.effect(EscalationChainsService, EscalationChainsService.make).pipe(
			Layer.provide(testDb.layer),
			Layer.provide(members),
		),
		Layer.effect(OnCallSchedulesService, OnCallSchedulesService.make).pipe(
			Layer.provide(testDb.layer),
			Layer.provide(members),
		),
		Layer.effect(AlertIncidentAckService, AlertIncidentAckService.make).pipe(
			Layer.provide(testDb.layer),
			Layer.provide(members),
		),
	)
}

const makeChat = Effect.map(Ref.make<PostMode>("ok"), (mode): FakeChat => ({
	mode,
	opened: [],
	posted: [],
	attempts: [],
}))

const tick = (alerts: AlertsServiceApi, minutes = 1) =>
	Effect.gen(function* () {
		yield* TestClock.adjust(Duration.minutes(minutes))
		yield* alerts.runSchedulerTick()
	})

const ticks = (alerts: AlertsServiceApi, minutes: number) =>
	Effect.forEach(Arr.range(1, minutes), () => tick(alerts), { discard: true })

interface PageRow {
	readonly user_id: string
	readonly channel: string
	readonly status: string
	readonly attempt_number: number
	readonly error_message: string | null
}

const pageRows = (testDb: TestDb, orgId: OrgId) =>
	Effect.promise(() =>
		testDb.pglite.query<PageRow>(
			`select user_id, channel, status, attempt_number, error_message
			 from alert_member_notifications where org_id = $1 order by channel, created_at`,
			[orgId],
		),
	).pipe(Effect.map((result) => result.rows))

const runStatus = (testDb: TestDb, orgId: OrgId) =>
	Effect.promise(() =>
		testDb.pglite.query<{ status: string; steps_sent: number }>(
			"select status, steps_sent from alert_escalation_runs where org_id = $1",
			[orgId],
		),
	).pipe(Effect.map((result) => result.rows[0]))

/** "API primary": weekly Ana, Ben, Chen from Monday 2026-11-09 09:00 Berlin; Ben covers today. */
const apiPrimary = (orgId: OrgId, options: { readonly gap?: boolean; readonly override?: boolean } = {}) =>
	Effect.gen(function* () {
		const schedules = yield* OnCallSchedulesService
		const schedule = yield* schedules.create(
			orgId,
			ana,
			adminRoles,
			new OnCallScheduleCreateRequest({
				name: "API primary",
				timeZone: "Europe/Berlin",
				layers: [
					{
						name: "Primary",
						participants: [ana, ben, chen],
						rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
						startsAt: at("2026-11-09T08:00:00Z"),
						// Saturdays only: nobody is on call on a Tuesday.
						...(options.gap === true
							? { restrictions: [{ weekdays: ["sat"], startTime: "09:00", endTime: "17:00" }] }
							: undefined),
					},
				],
			}),
		)
		if (options.override !== false) {
			yield* schedules.createOverride(
				orgId,
				ana,
				adminRoles,
				schedule.id,
				new OnCallOverrideCreateRequest({
					userId: ben,
					startsAt: at("2026-11-10T08:00:00Z"),
					endsAt: at("2026-11-11T08:00:00Z"),
				}),
			)
		}
		return schedule
	})

/** Ben linked his Slack account in a workspace the org connected. */
const linkBenOnSlack = (testDb: TestDb, orgId: OrgId) =>
	Effect.promise(async () => {
		await executeSql(
			testDb,
			`insert into chat_workspaces (id, org_id, connector, external_workspace_id, name, settings, created_at)
			 values ($1, $2, 'slack', 'T_ACME', 'Acme', '{}'::jsonb, now())`,
			[WORKSPACE_ID, orgId],
		)
		await executeSql(
			testDb,
			`insert into chat_identities (id, org_id, connector, external_user_id, user_id, display_name, created_at)
			 values (gen_random_uuid()::text, $1, 'slack', 'U_BEN', $2, 'ben', now())`,
			[orgId, ben],
		)
	})

/** Step 1 notifies a webhook, waits 10 minutes; step 2 pages the "API primary" on-call. */
const setup = (
	orgName: string,
	testDb: TestDb,
	options: { readonly gap?: boolean; readonly override?: boolean } = {},
) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService
		const chains = yield* EscalationChainsService
		const orgId = asOrgId(orgName)
		const team = yield* alerts.createDestination(
			orgId,
			ana,
			adminRoles,
			new WebhookAlertDestinationConfig({
				type: "webhook",
				name: "team",
				enabled: true,
				url: "https://example.com/team",
				signingSecret: "team-secret",
			}),
		)
		const schedule = yield* apiPrimary(orgId, options)
		yield* linkBenOnSlack(testDb, orgId)
		const steps: [EscalationStep, ...Array<EscalationStep>] = [
			{ targets: [{ type: "destination", destinationId: team.id }], waitMinutes: 10 },
			{ targets: [{ type: "schedule", scheduleId: schedule.id }], waitMinutes: 15 },
		]
		const chain = yield* chains.create(
			orgId,
			ana,
			adminRoles,
			new EscalationChainCreateRequest({ name: "API escalation", steps }),
		)
		yield* alerts.createRule(
			orgId,
			ana,
			adminRoles,
			new AlertRuleUpsertRequest({
				name: "Checkout error rate",
				enabled: true,
				serviceNames: ["checkout"],
				signalType: "error_rate",
				comparator: "gt",
				thresholds: [
					{
						severity: "critical",
						value: 5,
						upper: null,
						recoveryValue: null,
						destinationIds: [team.id],
						escalationChainId: chain.id,
					},
				],
				windowMinutes: 5,
				minimumSampleCount: 10,
				consecutiveBreachesRequired: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 60,
			}),
		)
		// Two breaching ticks open the incident and send step 1.
		yield* alerts.runSchedulerTick()
		yield* tick(alerts)
		return { alerts, chains, orgId, schedule, chain }
	})

describe("escalation pages the on-call", () => {
	it.effect("pages whoever the schedule has on call at step time, by email and Slack DM", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRate(10) }
		const emails: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const chat = yield* makeChat
			yield* TestClock.setTime(NOW)
			return yield* Effect.gen(function* () {
				const { alerts, orgId } = yield* setup("org_page_ben", testDb)
				assert.deepStrictEqual(yield* pageRows(testDb, orgId), [])

				yield* ticks(alerts, 10)
				// Ben covers Ana's week today, so step 2 pages him and only him.
				assert.deepStrictEqual(
					Arr.map(emails, (email) => email.to),
					["ben@acme.test"],
				)
				assert.include(emails[0]?.subject ?? "", "Checkout error rate")
				assert.deepStrictEqual(chat.opened, [{ workspaceId: "T_ACME", userId: "U_BEN" }])
				assert.deepStrictEqual(
					Arr.map(chat.posted, (post) => post.target.channelId),
					["U_BEN"],
				)
				assert.deepStrictEqual(
					Arr.map(yield* pageRows(testDb, orgId), (row) => [row.user_id, row.channel, row.status]),
					[
						[ben, "email", "sent"],
						[ben, "slack", "sent"],
					],
				)

				// The timeline names him and the channel, never the address.
				const [incident] = (yield* alerts.listIncidents(orgId, {})).incidents
				if (incident === undefined) return assert.fail("expected an incident")
				const events = yield* (yield* AlertIncidentAckService).listEvents(orgId, incident.id)
				// Both pages went out in the same step, so their order is not fixed.
				assert.sameDeepMembers(
					Arr.map(events, (event) => [
						event.type,
						event.page?.name,
						event.page?.channel,
						event.page?.status,
					]),
					[
						["paged", "Ben Brook", "email", "sent"],
						["paged", "Ben Brook", "slack", "sent"],
					],
				)
				assert.notInclude(JSON.stringify(events), "ben@acme.test")
			}).pipe(Effect.provide(layerFor(testDb, state, emails, chat)))
		})
	})

	it.effect("pages nobody for a schedule with no one on call, and still moves to the next step", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRate(10) }
		const emails: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const chat = yield* makeChat
			yield* TestClock.setTime(NOW)
			return yield* Effect.gen(function* () {
				const { alerts, orgId } = yield* setup("org_page_gap", testDb, { gap: true, override: false })
				yield* ticks(alerts, 10)
				assert.deepStrictEqual(yield* pageRows(testDb, orgId), [])
				assert.lengthOf(emails, 0)
				assert.lengthOf(chat.posted, 0)
				assert.deepStrictEqual(yield* runStatus(testDb, orgId), {
					status: "exhausted",
					steps_sent: 2,
				})
			}).pipe(Effect.provide(layerFor(testDb, state, emails, chat)))
		})
	})

	it.effect("skips a queued page once the incident is acknowledged", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRate(10) }
		const emails: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const chat = yield* makeChat
			yield* TestClock.setTime(NOW)
			return yield* Effect.gen(function* () {
				const { alerts, orgId } = yield* setup("org_page_ack", testDb)
				yield* ticks(alerts, 10)
				// Pages queued by a step that committed just before the ack, as the drain finds them.
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`insert into alert_member_notifications (id, org_id, incident_id, run_id, user_id, channel,
						   status, attempt_number, scheduled_at, payload_json, dedupe_key, created_at, updated_at)
						 select gen_random_uuid()::text, org_id, incident_id, run_id, $2, channel, 'queued', 1,
						   scheduled_at, payload_json, dedupe_key || ':late', created_at, updated_at
						 from alert_member_notifications where org_id = $1`,
						[orgId, chen],
					),
				)
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`update alert_incidents set acknowledged_at = now(), acknowledged_by_name = 'Ana',
						   acknowledged_via = 'web' where org_id = $1`,
						[orgId],
					),
				)
				yield* tick(alerts)
				const late = Arr.filter(yield* pageRows(testDb, orgId), (row) => row.user_id === chen)
				assert.deepStrictEqual(
					Arr.map(late, (row) => row.status),
					["skipped", "skipped"],
				)
				assert.include(late[0]?.error_message ?? "", "acknowledged")
				assert.notInclude(
					Arr.map(emails, (email) => email.to),
					"chen@acme.test",
				)
			}).pipe(Effect.provide(layerFor(testDb, state, emails, chat)))
		})
	})

	it.effect("does not retry a DM the platform refuses for good", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRate(10) }
		const emails: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const chat = yield* makeChat
			yield* Ref.set(chat.mode, "permanent")
			yield* TestClock.setTime(NOW)
			return yield* Effect.gen(function* () {
				const { alerts, orgId } = yield* setup("org_page_permanent", testDb)
				yield* ticks(alerts, 20)
				const slack = Arr.filter(yield* pageRows(testDb, orgId), (row) => row.channel === "slack")
				assert.deepStrictEqual(
					Arr.map(slack, (row) => [row.status, row.attempt_number]),
					[["failed", 1]],
				)
				assert.include(slack[0]?.error_message ?? "", "messages_tab_disabled")
				assert.deepStrictEqual(chat.attempts, ["permanent"])
			}).pipe(Effect.provide(layerFor(testDb, state, emails, chat)))
		})
	})

	it.effect("retries a DM that failed for a passing reason, and sends it", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRate(10) }
		const emails: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const chat = yield* makeChat
			yield* Ref.set(chat.mode, "transient")
			yield* TestClock.setTime(NOW)
			return yield* Effect.gen(function* () {
				const { alerts, orgId } = yield* setup("org_page_transient", testDb)
				yield* ticks(alerts, 10)
				const queued = Arr.filter(yield* pageRows(testDb, orgId), (row) => row.channel === "slack")
				assert.deepStrictEqual(
					Arr.map(queued, (row) => [row.status, row.attempt_number]),
					[["queued", 2]],
				)
				yield* Ref.set(chat.mode, "ok")
				yield* ticks(alerts, 2)
				const sent = Arr.filter(yield* pageRows(testDb, orgId), (row) => row.channel === "slack")
				assert.deepStrictEqual(
					Arr.map(sent, (row) => [row.status, row.attempt_number]),
					[["sent", 2]],
				)
				assert.deepStrictEqual(chat.attempts, ["transient", "ok"])
			}).pipe(Effect.provide(layerFor(testDb, state, emails, chat)))
		})
	})
})

describe("escalation chain targets", () => {
	it.effect("refuses an unknown user or schedule, and a schedule a chain pages cannot be deleted", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRate(1) }
		const emails: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const chat = yield* makeChat
			yield* TestClock.setTime(NOW)
			return yield* Effect.gen(function* () {
				const chains = yield* EscalationChainsService
				const schedules = yield* OnCallSchedulesService
				const orgId = asOrgId("org_page_guards")
				const schedule = yield* apiPrimary(orgId, { override: false })
				const create = (steps: [EscalationStep, ...Array<EscalationStep>]) =>
					chains.create(
						orgId,
						ana,
						adminRoles,
						new EscalationChainCreateRequest({ name: "Guarded", steps }),
					)

				const stranger = getError(
					yield* Effect.exit(
						create([
							{ targets: [{ type: "user", userId: asUserId("user_zed") }], waitMinutes: 5 },
						]),
					),
				)
				if (!Schema.is(AlertValidationError)(stranger))
					return assert.fail("expected a validation error")
				assert.include(stranger.message, "user_zed")

				const otherOrgs = yield* apiPrimary(asOrgId("org_page_guards_other"), { override: false })
				const foreign = getError(
					yield* Effect.exit(
						create([
							{ targets: [{ type: "schedule", scheduleId: otherOrgs.id }], waitMinutes: 5 },
						]),
					),
				)
				assert.instanceOf(foreign, AlertValidationError)

				const chain = yield* create([
					{
						targets: [
							{ type: "schedule", scheduleId: schedule.id },
							{ type: "user", userId: chen },
						],
						waitMinutes: 5,
					},
				])
				assert.deepStrictEqual((yield* schedules.get(orgId, schedule.id)).chainIds, [chain.id])
				const inUse = getError(yield* Effect.exit(schedules.delete(orgId, adminRoles, schedule.id)))
				if (!Schema.is(OnCallScheduleInUseError)(inUse)) return assert.fail("expected in use")
				assert.deepStrictEqual(inUse.chainNames, ["Guarded"])

				yield* chains.delete(orgId, adminRoles, chain.id)
				yield* schedules.delete(orgId, adminRoles, schedule.id)
				assert.lengthOf((yield* schedules.list(orgId)).schedules, 0)
			}).pipe(Effect.provide(layerFor(testDb, state, emails, chat)))
		})
	})
})
