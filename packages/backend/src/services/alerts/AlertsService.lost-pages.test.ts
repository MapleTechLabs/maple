// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
import {
	AlertRuleUpsertRequest,
	PagerDutyAlertDestinationConfig,
	WebhookAlertDestinationConfig,
	type AlertDestinationId,
	type AlertThreshold,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Clock, Duration, Effect, Option, String as Str } from "effect"
import { TestClock } from "effect/testing"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { type AlertsServiceApi } from "./AlertsService"
import { DELETED_RULE_IN_FLIGHT_DELAY_MS } from "./delivery/deleted-rule-resolve"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminGrants,
	alertServices,
	asOrgId,
	asUserId,
	createErrorRateRule,
	emptyWarehouseRows,
	insertDeliveryEventRow,
	makeLayer,
	makeWarehouseStub,
	tracesRow,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const errorRateRows = (errorRate: number): ReadonlyArray<Record<string, unknown>> => [
	tracesRow({
		count: 200,
		avgDuration: 40,
		p50Duration: 20,
		p95Duration: 120,
		p99Duration: 240,
		errorRate,
		satisfiedCount: 180,
		toleratingCount: 10,
		apdexScore: 0.925,
	}),
]

/** `trigger team` per webhook request, in send order. */
const recordingFetch = (requests: Array<string>) =>
	(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input)
		requests.push(
			`${new Headers(init?.headers).get("x-maple-event-type")} ${Str.replace("https://example.com/", "")(url)}`,
		)
		return new Response("ok", { status: 200 })
	}) as typeof fetch

const requestBodyText = (body: RequestInit["body"]): string =>
	body instanceof Uint8Array ? new TextDecoder().decode(body) : typeof body === "string" ? body : ""

const tick = (alerts: AlertsServiceApi, minutes = 1) =>
	Effect.gen(function* () {
		yield* TestClock.adjust(Duration.minutes(minutes))
		yield* alerts.runSchedulerTick()
	})

const ticks = (alerts: AlertsServiceApi, minutes: number) =>
	Effect.forEach(Arr.range(1, minutes), () => tick(alerts), { discard: true })

const webhook = (alerts: AlertsServiceApi, orgId: OrgId, userId: UserId, name: string) =>
	alerts.createDestination(
		orgId,
		userId,
		adminGrants,
		new WebhookAlertDestinationConfig({
			type: "webhook",
			name,
			enabled: true,
			url: `https://example.com/${name}`,
			signingSecret: `${name}-secret`,
		}),
	)

const tier = (
	severity: AlertThreshold["severity"],
	value: number,
	destinationIds: ReadonlyArray<AlertDestinationId>,
): AlertThreshold => ({
	severity,
	value,
	upper: null,
	recoveryValue: null,
	destinationIds,
	escalationChainId: null,
})

const tieredRule = (thresholds: Arr.NonEmptyReadonlyArray<AlertThreshold>, renotifyIntervalMinutes: number) =>
	new AlertRuleUpsertRequest({
		name: "Checkout error rate",
		enabled: true,
		serviceNames: ["checkout"],
		signalType: "error_rate",
		comparator: "gt",
		thresholds,
		windowMinutes: 5,
		minimumSampleCount: 10,
		consecutiveBreachesRequired: 2,
		consecutiveHealthyRequired: 2,
		renotifyIntervalMinutes,
	})

describe("AlertsService flap suppression", () => {
	it.effect("pages a reopen above the severity the earlier incident reached", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_flap_severity")
			const userId = asUserId("user_flap_severity")
			const team = yield* webhook(alerts, orgId, userId, "team")
			const pager = yield* webhook(alerts, orgId, userId, "pager")
			yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				tieredRule([tier("warning", 5, [team.id]), tier("critical", 20, [pager.id])], 60),
			)

			// A warning opens and resolves: #team hears both.
			yield* ticks(alerts, 2)
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(requests, ["trigger team", "resolve team"])

			// Minutes later it is back, and critical: the pager has heard nothing yet.
			state.tracesAggregateRows = errorRateRows(30)
			yield* ticks(alerts, 2)
			assert.include(requests, "trigger pager")
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) })),
		)
	})
})

describe("AlertsService flap suppression after a page that never arrived", () => {
	it.effect("pages a reopen when the earlier incident's own page never got through", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const delivered: Array<string> = []
		const outage = { triggers: true }
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const event = new Headers(init?.headers).get("x-maple-event-type")
			if (event === "trigger" && outage.triggers) return new Response("down", { status: 503 })
			const url = String(input instanceof Request ? input.url : input)
			delivered.push(`${event} ${Str.replace("https://example.com/", "")(url)}`)
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_flap_unpaged")
			const userId = asUserId("user_flap_unpaged")
			const team = yield* webhook(alerts, orgId, userId, "team")
			yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				tieredRule([tier("critical", 5, [team.id])], 60),
			)

			// The page fails while the incident is open, and the incident resolves on its own.
			yield* ticks(alerts, 2)
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)
			assert.notInclude(delivered, "trigger team")

			// It comes back minutes later: nobody has heard of it yet, so this one pages.
			outage.triggers = false
			state.tracesAggregateRows = errorRateRows(10)
			yield* ticks(alerts, 2)
			assert.include(delivered, "trigger team")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})
})

describe("AlertsService flap suppression after an incident that paged nobody", () => {
	it.effect("pages a reopen when the earlier incident's destination was switched off", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_flap_silent")
			const userId = asUserId("user_flap_silent")
			const team = yield* webhook(alerts, orgId, userId, "team")
			yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				tieredRule([tier("critical", 5, [team.id])], 60),
			)
			const setEnabled = (enabled: boolean) =>
				alerts.updateDestination(orgId, userId, adminGrants, team.id, { type: "webhook", enabled })

			// Opens and resolves while its only destination is off: no page is even queued.
			yield* setEnabled(false)
			yield* ticks(alerts, 2)
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(requests, [])

			// Back minutes later with the destination on: nobody has heard of it, so it pages.
			yield* setEnabled(true)
			state.tracesAggregateRows = errorRateRows(10)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(requests, ["trigger team"])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) })),
		)
	})
})

describe("AlertsService rule deletion", () => {
	it.effect("sends the all-clear to a destination the open incident paged", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_delete_resolve")
			const userId = asUserId("user_delete_resolve")
			const team = yield* webhook(alerts, orgId, userId, "team")
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				tieredRule([tier("critical", 5, [team.id])], 60),
			)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(requests, ["trigger team"])

			yield* alerts.deleteRule(orgId, adminGrants, rule.id)
			yield* tick(alerts)

			assert.deepStrictEqual(requests, ["trigger team", "resolve team"])
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) })),
		)
	})

	it.effect("sends nothing when the rule has no open incident", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_delete_quiet")
			const userId = asUserId("user_delete_quiet")
			const team = yield* webhook(alerts, orgId, userId, "team")
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				tieredRule([tier("critical", 5, [team.id])], 60),
			)
			yield* ticks(alerts, 2)
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)

			yield* alerts.deleteRule(orgId, adminGrants, rule.id)
			yield* tick(alerts)

			assert.deepStrictEqual(requests, ["trigger team", "resolve team"])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) })),
		)
	})
})

describe("AlertsService rule deletion with pages in other states", () => {
	interface Sent {
		readonly event: string | null
		readonly destination: string
		readonly body: string
	}

	const capturingFetch = (sent: Array<Sent>, failing: { resolves: boolean }) =>
		(async (input: RequestInfo | URL, init?: RequestInit) => {
			const event = new Headers(init?.headers).get("x-maple-event-type")
			if (event === "resolve" && failing.resolves) return new Response("down", { status: 503 })
			const url = String(input instanceof Request ? input.url : input)
			sent.push({
				event,
				destination: Str.replace("https://example.com/", "")(url),
				body: requestBodyText(init?.body),
			})
			return new Response("ok", { status: 200 })
		}) as typeof fetch

	const openIncidentWith = (testDb: TestDb, names: Arr.NonEmptyReadonlyArray<string>) =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_delete_states")
			const userId = asUserId("user_delete_states")
			const destinations = yield* Effect.forEach(names, (name) => webhook(alerts, orgId, userId, name))
			const first = Arr.headNonEmpty(destinations)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				tieredRule([tier("critical", 5, [first.id])], 60),
			)
			yield* ticks(alerts, 2)
			const incident = yield* Effect.promise(() =>
				queryFirstRow<{ id: string }>(
					testDb,
					"select id from alert_incidents where rule_id = $1 and status = 'open'",
					[rule.id],
				),
			)
			return { alerts, orgId, rule, destinations, incidentId: incident?.id ?? "" }
		})

	const resolveRows = (testDb: TestDb, ruleId: string) =>
		Effect.promise(() =>
			testDb.pglite.query<{ destination_id: string; scheduled_at: Date }>(
				"select destination_id, scheduled_at from alert_delivery_events where rule_id = $1 and event_type = 'resolve' order by destination_id",
				[ruleId],
			),
		).pipe(Effect.map((result) => result.rows))

	it.effect("reaches a destination paged once, however many reminders another got since", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<Sent> = []
		return Effect.gen(function* () {
			const { alerts, orgId, rule, destinations, incidentId } = yield* openIncidentWith(testDb, [
				"team",
				"pager",
			])
			const pager = destinations[1]?.id ?? ""
			// The pager was paged once, long ago; the team has had thousands of reminders since.
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-0000000007a1",
					orgId,
					incidentId,
					ruleId: rule.id,
					destinationId: pager,
					deliveryKey: "old-pager-page",
					eventType: "trigger",
					attemptNumber: 1,
					status: "success",
					scheduledAt: DEFAULT_CLOCK_EPOCH_MS - 86_400_000,
					payloadJson: JSON.stringify({ rule: { id: rule.id, comparator: "gt" }, incidentId }),
					createdAt: DEFAULT_CLOCK_EPOCH_MS - 86_400_000,
				}),
			)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_delivery_events
					   (id, org_id, incident_id, rule_id, destination_id, delivery_key, event_type,
					    attempt_number, status, scheduled_at, payload_json, created_at, updated_at)
					 select gen_random_uuid()::text, org_id, incident_id, rule_id, destination_id,
					        'reminder-' || n, 'renotify', 1, 'success', scheduled_at, payload_json,
					        created_at + (n || ' seconds')::interval, updated_at
					   from alert_delivery_events, generate_series(1, 2100) as n
					  where rule_id = $1 and event_type = 'trigger' and destination_id <> $2`,
					[rule.id, pager],
				),
			)

			yield* alerts.deleteRule(orgId, adminGrants, rule.id)
			yield* tick(alerts)

			assert.sameMembers(
				Arr.map(
					Arr.filter(sent, (request) => request.event === "resolve"),
					(request) => request.destination,
				),
				["team", "pager"],
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: errorRateRows(10) }), {
					fetch: capturingFetch(sent, { resolves: false }),
				}),
			),
		)
	})

	it.effect("sends no all-clear for a post that was skipped, unless an earlier page went out", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<Sent> = []
		return Effect.gen(function* () {
			const { alerts, orgId, rule, destinations, incidentId } = yield* openIncidentWith(testDb, [
				"team",
				"muted",
				"later-muted",
			])
			const page = (index: number, destinationId: string, eventType: string, skipped: boolean) =>
				Effect.promise(async () => {
					const id = `00000000-0000-4000-8000-0000000008a${index}`
					await insertDeliveryEventRow(testDb, {
						id,
						orgId,
						incidentId,
						ruleId: rule.id,
						destinationId,
						deliveryKey: `skipped-case-${index}`,
						eventType,
						attemptNumber: 1,
						status: "success",
						scheduledAt: DEFAULT_CLOCK_EPOCH_MS + index * 1000,
						payloadJson: JSON.stringify({ rule: { id: rule.id, comparator: "gt" }, incidentId }),
						createdAt: DEFAULT_CLOCK_EPOCH_MS + index * 1000,
					})
					if (skipped) {
						await executeSql(
							testDb,
							"update alert_delivery_events set provider_message = $1 where id = $2",
							["Skipped: alert notifications are off for this Slack workspace", id],
						)
					}
				})
			// "muted" only ever had a post that was not made; "later-muted" was paged, then skipped.
			yield* page(1, destinations[1]?.id ?? "", "trigger", true)
			yield* page(2, destinations[2]?.id ?? "", "trigger", false)
			yield* page(3, destinations[2]?.id ?? "", "renotify", true)

			yield* alerts.deleteRule(orgId, adminGrants, rule.id)
			yield* tick(alerts)

			assert.sameMembers(
				Arr.map(
					Arr.filter(sent, (request) => request.event === "resolve"),
					(request) => request.destination,
				),
				["team", "later-muted"],
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: errorRateRows(10) }), {
					fetch: capturingFetch(sent, { resolves: false }),
				}),
			),
		)
	})

	it.effect("answers a page still on its way out a minute later, and a waiting one not at all", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<Sent> = []
		return Effect.gen(function* () {
			const { alerts, orgId, rule, destinations, incidentId } = yield* openIncidentWith(testDb, [
				"team",
				"flying",
				"waiting",
			])
			const page = (index: number, status: string) =>
				Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-0000000007b${index}`,
						orgId,
						incidentId,
						ruleId: rule.id,
						destinationId: destinations[index]?.id ?? "",
						deliveryKey: `page-${index}`,
						eventType: "trigger",
						attemptNumber: 1,
						status,
						// Not due, so no tick sends the waiting one before the delete.
						scheduledAt: DEFAULT_CLOCK_EPOCH_MS + 3_600_000,
						payloadJson: JSON.stringify({ rule: { id: rule.id, comparator: "gt" }, incidentId }),
					}),
				)
			yield* page(1, "processing")
			yield* page(2, "queued")
			const deletedAt = yield* Clock.currentTimeMillis

			yield* alerts.deleteRule(orgId, adminGrants, rule.id)

			const queued = yield* resolveRows(testDb, rule.id)
			const dueIn = (destinationId: string | undefined) =>
				Arr.map(
					Arr.filter(queued, (row) => row.destination_id === destinationId),
					(row) => row.scheduled_at.getTime() - deletedAt,
				)
			assert.deepStrictEqual(dueIn(destinations[0]?.id), [0])
			assert.deepStrictEqual(dueIn(destinations[1]?.id), [DELETED_RULE_IN_FLIGHT_DELAY_MS])
			assert.deepStrictEqual(dueIn(destinations[2]?.id), [])
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: errorRateRows(10) }), {
					fetch: capturingFetch(sent, { resolves: false }),
				}),
			),
		)
	})

	it.effect("still sends an all-clear that was waiting for a retry when its rule went", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const sent: Array<Sent> = []
		const failing = { resolves: true }
		return Effect.gen(function* () {
			const { alerts, orgId, rule } = yield* openIncidentWith(testDb, ["team"])
			// The incident resolves, but its all-clear does not get through.
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 2)
			assert.deepStrictEqual(
				Arr.map(sent, (request) => request.event),
				["trigger"],
			)

			yield* alerts.deleteRule(orgId, adminGrants, rule.id)
			failing.resolves = false
			yield* ticks(alerts, 30)

			assert.deepStrictEqual(
				Arr.map(sent, (request) => request.event),
				["trigger", "resolve"],
			)
			// Its incident and rule are gone by now: it links to the alerts list, like a rebuilt one.
			const links: { readonly linkUrl?: string; readonly chatUrl?: string } = JSON.parse(
				sent[1]?.body ?? "{}",
			)
			assert.match(links.linkUrl ?? "", /\/alerts$/)
			assert.strictEqual(links.chatUrl, links.linkUrl)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub(state), { fetch: capturingFetch(sent, failing) }),
			),
		)
	})

	const linksOf = (body: string | undefined) => {
		const links: { readonly linkUrl?: string; readonly chatUrl?: string } = JSON.parse(body ?? "{}")
		return links
	}

	it.effect(
		"relinks an all-clear that was on its way out when its rule went, for whoever takes it over",
		() => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) }
			const sent: Array<Sent> = []
			const failing = { resolves: true }
			return Effect.gen(function* () {
				const { alerts, orgId, rule } = yield* openIncidentWith(testDb, ["team"])
				state.tracesAggregateRows = errorRateRows(0.5)
				yield* ticks(alerts, 2)
				// The retry is claimed by a worker that then dies: in flight, its claim about to run out.
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`update alert_delivery_events
					    set status = 'processing', claimed_at = scheduled_at, claim_expires_at = scheduled_at
					  where rule_id = $1 and event_type = 'resolve' and status = 'queued'`,
						[rule.id],
					),
				)

				yield* alerts.deleteRule(orgId, adminGrants, rule.id)
				failing.resolves = false
				yield* ticks(alerts, 30)

				const resolve = Arr.findFirst(sent, (request) => request.event === "resolve")
				const links = linksOf(Option.getOrUndefined(resolve)?.body)
				assert.match(links.linkUrl ?? "", /\/alerts$/)
				assert.strictEqual(links.chatUrl, links.linkUrl)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: capturingFetch(sent, failing) }),
				),
			)
		},
	)

	it.effect("relinks the retry of an all-clear whose rule was deleted while it was being sent", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const resolves: Array<string> = []
		/** Run once each, while an all-clear is on the wire; that all-clear then fails. */
		const duringResolve: Array<() => Promise<void>> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (new Headers(init?.headers).get("x-maple-event-type") !== "resolve") {
				return new Response("ok", { status: 200 })
			}
			const run = duringResolve.shift()
			if (run !== undefined) {
				await run()
				return new Response("down", { status: 503 })
			}
			resolves.push(requestBodyText(init?.body))
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		return Effect.gen(function* () {
			const { alerts, orgId, rule } = yield* openIncidentWith(testDb, ["team"])
			const run = Effect.runPromiseWith(yield* Effect.context())
			duringResolve.push(() => run(Effect.asVoid(alerts.deleteRule(orgId, adminGrants, rule.id))))
			state.tracesAggregateRows = errorRateRows(0.5)
			yield* ticks(alerts, 40)

			assert.isAbove(resolves.length, 0)
			const links = linksOf(resolves[0])
			assert.match(links.linkUrl ?? "", /\/alerts$/)
			assert.strictEqual(links.chatUrl, links.linkUrl)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("links the all-clear to the alerts list, not to what was deleted", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<Sent> = []
		return Effect.gen(function* () {
			const { alerts, orgId, rule } = yield* openIncidentWith(testDb, ["team"])
			yield* alerts.deleteRule(orgId, adminGrants, rule.id)
			yield* tick(alerts)

			const resolve = Arr.findFirst(sent, (request) => request.event === "resolve")
			const links: { readonly linkUrl?: string; readonly chatUrl?: string } = JSON.parse(
				Option.match(resolve, { onNone: () => "{}", onSome: (request) => request.body }),
			)
			assert.match(links.linkUrl ?? "", /\/alerts$/)
			assert.strictEqual(links.chatUrl, links.linkUrl)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: errorRateRows(10) }), {
					fetch: capturingFetch(sent, { resolves: false }),
				}),
			),
		)
	})
})

describe("AlertsService pages that outlive their incident", () => {
	const fixedTime = 1_710_000_400_000
	const incidentId = "00000000-0000-4000-8000-000000000501"

	/** A PagerDuty rule with one seeded incident (or none) and one queued retry of its page. */
	const run = (incident: {
		readonly status: "open" | "resolved" | "missing"
		readonly acknowledged: boolean
		/** The pager was already told of the ack, for an earlier page. */
		readonly acknowledgeAlreadySent?: boolean
	}) => {
		const testDb = createTestDb(trackedDbs)
		const actions: Array<string> = []
		/** The PagerDuty alert each request addressed, in the order `actions` holds them. */
		const dedupKeys: Array<string> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body: { readonly event_action?: string; readonly dedup_key?: string } = JSON.parse(
				requestBodyText(init?.body),
			)
			actions.push(body.event_action ?? "unknown")
			dedupKeys.push(body.dedup_key ?? "")
			return new Response("{}", { status: 202 })
		}) as typeof fetch
		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_stale_page")
			const userId = asUserId("user_stale_page")
			const destination = yield* alerts.createDestination(
				orgId,
				userId,
				adminGrants,
				new PagerDutyAlertDestinationConfig({
					type: "pagerduty",
					name: "On-call",
					enabled: true,
					integrationKey: "abcdefghijklmnopqrstuvwxyz012345",
				}),
			)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			// Break the rule's stored query so the tick queues nothing of its own.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					rule.id,
				]),
			)
			yield* Effect.promise(() =>
				incident.status === "missing"
					? Promise.resolve()
					: executeSql(
							testDb,
							`INSERT INTO alert_incidents
					   (id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
					    comparator, threshold, first_triggered_at, last_triggered_at, resolved_at, dedupe_key,
					    acknowledged_at, acknowledged_by_name, acknowledged_via, created_at, updated_at)
					 VALUES ($1, $2, $3, 'k', 'Checkout error rate', '__total__', 'error_rate', 'warning', $4,
					    'gt', 5, $5, $5, $6, 'dedupe-stale', $7, $8, $9, $5, $5)`,
							[
								incidentId,
								orgId,
								rule.id,
								incident.status,
								new Date(fixedTime - 120_000),
								incident.status === "resolved" ? new Date(fixedTime - 30_000) : null,
								incident.acknowledged ? new Date(fixedTime - 20_000) : null,
								incident.acknowledged ? "sam" : null,
								incident.acknowledged ? "web" : null,
							],
						),
			)
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000502",
					orgId,
					incidentId,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "page-1",
					eventType: "trigger",
					attemptNumber: 2,
					status: "queued",
					scheduledAt: fixedTime - 500,
					payloadJson: JSON.stringify({
						eventType: "trigger",
						incidentId,
						dedupeKey: "dedupe-stale",
						rule: { id: rule.id, name: "Checkout error rate", severity: "warning" },
					}),
				}),
			)
			if (incident.acknowledgeAlreadySent === true) {
				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: "00000000-0000-4000-8000-000000000503",
						orgId,
						incidentId,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: "ack-earlier",
						eventType: "acknowledge",
						attemptNumber: 1,
						status: "success",
						scheduledAt: fixedTime - 10_000,
						payloadJson: JSON.stringify({ eventType: "acknowledge", incidentId }),
					}),
				)
			}
			// Creating the destination pinged the pager; only what follows is under test.
			actions.length = 0
			dedupKeys.length = 0
			yield* alerts.runSchedulerTick()
			yield* tick(alerts)
			const page = yield* Effect.promise(() =>
				queryFirstRow<{ status: string; error: string | null }>(
					testDb,
					`select status, error_message as error from alert_delivery_events where delivery_key = 'page-1'`,
					[],
				),
			)
			return { actions, dedupKeys, page }
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	}

	it.effect("does not send a retried page once its incident has resolved", () =>
		Effect.gen(function* () {
			const { actions, page } = yield* run({ status: "resolved", acknowledged: false })
			assert.deepStrictEqual(actions, [])
			assert.strictEqual(page?.status, "failed")
			assert.strictEqual(page?.error, "Not sent: the incident resolved before this page went out")
		}),
	)

	it.effect("does not send a retried page whose incident went with its rule", () =>
		Effect.gen(function* () {
			const { actions, page } = yield* run({ status: "missing", acknowledged: false })
			assert.deepStrictEqual(actions, [])
			assert.strictEqual(page?.status, "failed")
		}),
	)

	it.effect("still sends a retried page while the incident is open", () =>
		Effect.gen(function* () {
			const { actions, page } = yield* run({ status: "open", acknowledged: false })
			assert.deepStrictEqual(actions, ["trigger"])
			assert.strictEqual(page?.status, "success")
		}),
	)

	it.effect("tells the pager about an acknowledgement that came before its page landed", () =>
		Effect.gen(function* () {
			const { actions, dedupKeys } = yield* run({ status: "open", acknowledged: true })
			assert.deepStrictEqual(actions, ["trigger", "acknowledge"])
			// The acknowledgement is for the alert the page just opened, not some other one.
			assert.isAbove(dedupKeys[0]?.length ?? 0, 0)
			assert.strictEqual(dedupKeys[1], dedupKeys[0])
		}),
	)

	it.effect("acknowledges the late page even when an earlier page was already acknowledged", () =>
		Effect.gen(function* () {
			const { actions, dedupKeys } = yield* run({
				status: "open",
				acknowledged: true,
				acknowledgeAlreadySent: true,
			})
			assert.deepStrictEqual(actions, ["trigger", "acknowledge"])
			assert.strictEqual(dedupKeys[1], dedupKeys[0])
		}),
	)
})

describe("AlertsService reminders and acknowledgements", () => {
	const TICKS = 36

	/**
	 * A firing incident ticked past its 30-minute reminder. `acknowledgeAtTick` acknowledges it
	 * while that tick's check is running: after the tick read the incident, before it writes.
	 */
	const run = (acknowledgeAtTick: number | null) => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: errorRateRows(10) }
		const requests: Array<string> = []
		const hook = { armed: false, ran: false }
		const acknowledge = Effect.suspend(() => {
			if (!hook.armed || hook.ran) return Effect.void
			hook.ran = true
			return Effect.promise(() =>
				executeSql(
					testDb,
					`update alert_incidents
					    set acknowledged_at = now(), acknowledged_by_name = 'sam', acknowledged_via = 'web'
					  where status = 'open'`,
					[],
				),
			)
		})
		const base = makeWarehouseStub(state)
		const warehouse: WarehouseQueryServiceApi = {
			...base,
			rawSqlQuery: (tenant, sql, options) =>
				Effect.andThen(acknowledge, base.rawSqlQuery(tenant, sql, options)),
			compiledQueryWithCapabilities: (tenant, compile, options) =>
				Effect.andThen(acknowledge, base.compiledQueryWithCapabilities(tenant, compile, options)),
			compiledQueryFirst: (tenant, compiled, options) =>
				Effect.andThen(acknowledge, base.compiledQueryFirst(tenant, compiled, options)),
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* alertServices
			const orgId = asOrgId("org_reminder_ack")
			const userId = asUserId("user_reminder_ack")
			const team = yield* webhook(alerts, orgId, userId, "team")
			yield* alerts.createRule(
				orgId,
				userId,
				adminGrants,
				tieredRule([tier("critical", 5, [team.id])], 30),
			)
			// The tick each request count was first seen at, so the reminder's tick can be read back.
			const sentAfterTick = yield* Effect.forEach(Arr.range(1, TICKS), (index) =>
				Effect.gen(function* () {
					hook.armed = index === acknowledgeAtTick
					yield* tick(alerts)
					return requests.length
				}),
			)
			const reminderTick = Arr.findFirstIndex(sentAfterTick, (sent) => sent >= 2)
			const incident = yield* Effect.promise(() =>
				queryFirstRow<{ lastNotifiedAt: Date | null }>(
					testDb,
					`select last_notified_at as "lastNotifiedAt" from alert_incidents where status = 'open'`,
					[],
				),
			)
			return {
				requests,
				hook,
				reminderTick,
				lastNotifiedAt: incident?.lastNotifiedAt?.getTime() ?? null,
			}
		}).pipe(Effect.provide(makeLayer(testDb, warehouse, { fetch: recordingFetch(requests) })))
	}

	it.effect("sends no reminder when the ack lands while the reminder's check is running", () =>
		Effect.gen(function* () {
			const unacknowledged = yield* run(null)
			assert.deepStrictEqual(unacknowledged.requests, ["trigger team", "renotify team"])
			const reminderTick = Option.getOrThrow(unacknowledged.reminderTick) + 1

			const { requests, hook, lastNotifiedAt } = yield* run(reminderTick)
			assert.isTrue(hook.ran)
			assert.deepStrictEqual(requests, ["trigger team"])
			// The reminder clock still reads the page that went out, so an unacknowledge
			// finds the reminder overdue instead of a full interval away.
			assert.isBelow(
				lastNotifiedAt ?? Number.POSITIVE_INFINITY,
				DEFAULT_CLOCK_EPOCH_MS + Duration.toMillis(Duration.minutes(reminderTick)),
			)
		}),
	)
})
