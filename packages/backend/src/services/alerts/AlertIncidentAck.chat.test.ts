/**
 * What an acknowledgement reaches beyond the incident row: the PagerDuty acknowledgements it
 * queues, and the chat card it redraws.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import { AlertIncidentId, AlertRuleId, OrgId } from "@maple/domain/http"
import { Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertChatCardService } from "./AlertChatCardService"
import { AlertIncidentAckService, type AlertIncidentActor } from "./AlertIncidentAckService"

const ORG = Schema.decodeSync(OrgId)("org_ack_chat")
const RULE = Schema.decodeSync(AlertRuleId)("00000000-0000-4000-8000-000000000030")
const INCIDENT = Schema.decodeSync(AlertIncidentId)("00000000-0000-4000-8000-000000000031")
const RESOLVED = Schema.decodeSync(AlertIncidentId)("00000000-0000-4000-8000-000000000032")

const PD_RULE = "00000000-0000-4000-8000-0000000000d1"
const PD_DISABLED = "00000000-0000-4000-8000-0000000000d2"
const CHAT_DEST = "00000000-0000-4000-8000-0000000000d3"
const PD_PRIOR = "00000000-0000-4000-8000-0000000000d4"
const PD_UNRELATED = "00000000-0000-4000-8000-0000000000d5"

const MESSAGE_TS = "1762400000.000100"

const sam: AlertIncidentActor = { userId: null, name: "sam", source: "slack" }

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = (testDb: TestDb) =>
	Layer.mergeAll(AlertIncidentAckService.layer, AlertChatCardService.layer).pipe(
		Layer.provide(testDb.layer),
	)

const destination = (id: string, name: string, type: string, enabled: boolean) =>
	`('${id}', '${ORG}', '${name}', '${type}', ${enabled}, '{}', '', '', '', now(), now(), 'u', 'u')`

const seed = (testDb: TestDb) =>
	Effect.promise(async () => {
		await executeSql(
			testDb,
			`INSERT INTO alert_destinations
			   (id, org_id, name, type, enabled, config_json, secret_ciphertext, secret_iv, secret_tag,
			    created_at, updated_at, created_by, updated_by)
			 VALUES ${Arr.join(
					[
						destination(PD_RULE, "On-call", "pagerduty", true),
						destination(PD_DISABLED, "Old on-call", "pagerduty", false),
						destination(CHAT_DEST, "#alerts", "chat", true),
						destination(PD_PRIOR, "Former on-call", "pagerduty", true),
						destination(PD_UNRELATED, "Other team", "pagerduty", true),
					],
					", ",
				)}`,
		)
		await executeSql(
			testDb,
			`INSERT INTO alert_rules
			   (id, org_id, name, severity, signal_type, comparator, threshold, window_minutes,
			    destination_ids_json, reducer, no_data_behavior, created_at, updated_at, created_by, updated_by)
			 VALUES ($1, $2, 'Checkout errors', 'warning', 'error_rate', 'gt', 5, 5, $3::jsonb,
			    'avg', 'skip', now(), now(), 'u', 'u')`,
			[RULE, ORG, JSON.stringify([PD_RULE, PD_DISABLED, CHAT_DEST])],
		)
		await executeSql(
			testDb,
			`INSERT INTO alert_incidents
			   (id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
			    comparator, threshold, first_triggered_at, last_triggered_at, resolved_at,
			    dedupe_key, created_at, updated_at)
			 VALUES
			   ($1, $3, $4, 'k-open', 'Checkout errors', 'checkout', 'error_rate', 'warning', 'open',
			    'gt', 5, '2026-11-06T09:00:00Z', '2026-11-06T09:10:00Z', null, 'd-open', now(), now()),
			   ($2, $3, $4, 'k-res', 'Checkout errors', 'checkout', 'error_rate', 'warning', 'resolved',
			    'gt', 5, '2026-11-06T08:00:00Z', '2026-11-06T08:10:00Z', '2026-11-06T08:20:00Z', 'd-res', now(), now())`,
			[INCIDENT, RESOLVED, ORG, RULE],
		)
		const payload = JSON.stringify({
			eventType: "trigger",
			incidentId: INCIDENT,
			dedupeKey: "d-open",
			rule: {
				name: "Checkout errors",
				severity: "warning",
				signalType: "error_rate",
				windowMinutes: 5,
			},
			observed: { value: 7.5, sampleCount: 1200 },
			template: null,
			chart: null,
			linkUrl: `https://app.maple.dev/alerts/incidents/${INCIDENT}`,
			chatUrl: `https://app.maple.dev/alerts/rules/${RULE}`,
		})
		// The card the channel got, a page the former on-call destination got, and a page to the
		// rule's on-call that is still waiting to go out.
		await executeSql(
			testDb,
			`INSERT INTO alert_delivery_events
			   (id, org_id, incident_id, rule_id, destination_id, delivery_key, event_type, attempt_number,
			    status, scheduled_at, attempted_at, provider_reference, payload_json, created_at, updated_at)
			 VALUES
			   ('00000000-0000-4000-8000-0000000000e1', $1, $2, $3, $4, 'k1', 'trigger', 1, 'success',
			    '2026-11-06T09:00:00Z', '2026-11-06T09:00:01Z', $5, $6::jsonb, now(), now()),
			   ('00000000-0000-4000-8000-0000000000e2', $1, $2, $3, $7, 'k2', 'trigger', 1, 'success',
			    '2026-11-06T09:00:00Z', '2026-11-06T09:00:01Z', 'd-open', $6::jsonb, now(), now()),
			   ('00000000-0000-4000-8000-0000000000e3', $1, $2, $3, $8, 'k3', 'trigger', 2, 'queued',
			    '2026-11-06T09:05:00Z', null, null, $6::jsonb, now(), now())`,
			[ORG, INCIDENT, RULE, CHAT_DEST, MESSAGE_TS, payload, PD_PRIOR, PD_RULE],
		)
	})

const queuedAcks = (testDb: TestDb) =>
	Effect.promise(() =>
		testDb.pglite.query<{ destination_id: string; status: string; payload_json: { dedupeKey: string } }>(
			`SELECT destination_id, status, payload_json FROM alert_delivery_events
			  WHERE event_type = 'acknowledge' ORDER BY destination_id`,
		),
	).pipe(Effect.map((result) => result.rows))

describe("acknowledging an incident queues PagerDuty acknowledgements", () => {
	it.effect("only to the PagerDuty destinations this incident already paged", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acks = yield* AlertIncidentAckService

			yield* acks.acknowledge(ORG, INCIDENT, sam)

			const queued = yield* queuedAcks(testDb)
			assert.deepStrictEqual(
				Arr.map(queued, (row) => [row.destination_id, row.status, row.payload_json.dedupeKey]),
				// The rule's on-call has not been paged yet: an ack there would land before the page.
				[[PD_PRIOR, "queued", "d-open"]],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("queues nothing for an unacknowledge or for an ack that changed nothing", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acks = yield* AlertIncidentAckService

			yield* acks.acknowledge(ORG, INCIDENT, sam)
			yield* acks.acknowledge(ORG, INCIDENT, sam)
			yield* acks.unacknowledge(ORG, INCIDENT, sam)

			assert.lengthOf(yield* queuedAcks(testDb), 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})

describe("redrawing the chat card an ack was clicked on", () => {
	it.effect("shows who acknowledged, and the Acknowledge control again once it is undone", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acks = yield* AlertIncidentAckService
			const cards = yield* AlertChatCardService

			yield* acks.acknowledge(ORG, INCIDENT, sam)
			const acked = Option.getOrUndefined(yield* cards.cardForMessage(ORG, INCIDENT, MESSAGE_TS))
			const card = acked?.[0]
			assert.strictEqual(card?.kind, "alert")
			if (card?.kind !== "alert") return
			assert.include(card.title, "Checkout errors")
			assert.deepStrictEqual(card.acknowledge, { incidentId: INCIDENT, acknowledgedBy: "sam" })

			yield* acks.unacknowledge(ORG, INCIDENT, sam)
			const unacked = Option.getOrUndefined(yield* cards.cardForMessage(ORG, INCIDENT, MESSAGE_TS))
			const again = unacked?.[0]
			assert.deepStrictEqual(again?.kind === "alert" ? again.acknowledge : undefined, {
				incidentId: INCIDENT,
				acknowledgedBy: null,
			})
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("finds no card for a message Maple did not post for that incident or org", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const cards = yield* AlertChatCardService
			const otherOrg = Schema.decodeSync(OrgId)("org_someone_else")

			assert.isTrue(Option.isNone(yield* cards.cardForMessage(ORG, INCIDENT, "1762400000.999999")))
			assert.isTrue(Option.isNone(yield* cards.cardForMessage(ORG, RESOLVED, MESSAGE_TS)))
			assert.isTrue(Option.isNone(yield* cards.cardForMessage(otherOrg, INCIDENT, MESSAGE_TS)))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
