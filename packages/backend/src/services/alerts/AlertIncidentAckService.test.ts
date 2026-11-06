import { afterEach, assert, describe, it } from "@effect/vitest"
import { AlertIncidentId, AlertRuleId, OrgId, UserId } from "@maple/domain/http"
import { Duration, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertIncidentAckService, type AlertIncidentActor } from "./AlertIncidentAckService"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asRuleId = Schema.decodeUnknownSync(AlertRuleId)
const asIncidentId = Schema.decodeUnknownSync(AlertIncidentId)
const asUserId = Schema.decodeUnknownSync(UserId)

const ORG = asOrgId("org_alert_ack")
const OTHER_ORG = asOrgId("org_alert_ack_other")
const RULE = asRuleId("00000000-0000-4000-8000-000000000020")
const OPEN = asIncidentId("00000000-0000-4000-8000-000000000021")
const RESOLVED = asIncidentId("00000000-0000-4000-8000-000000000022")

const dana: AlertIncidentActor = { userId: asUserId("user_dana"), name: "Dana Kim", source: "web" }
const slackClick: AlertIncidentActor = { userId: null, name: "sam", source: "slack" }

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = (testDb: TestDb) =>
	Layer.effect(AlertIncidentAckService, AlertIncidentAckService.make).pipe(Layer.provide(testDb.layer))

const seed = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO alert_incidents
			   (id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
			    comparator, threshold, first_triggered_at, last_triggered_at, resolved_at,
			    dedupe_key, created_at, updated_at)
			 VALUES
			   ($1, $3, $4, 'ack-open', 'Checkout errors', '__total__', 'error_rate', 'critical', 'open',
			    'gt', 5, '2026-11-06T09:00:00Z', '2026-11-06T09:10:00Z', null, 'd-open', now(), now()),
			   ($2, $3, $4, 'ack-resolved', 'Checkout errors', '__total__', 'error_rate', 'critical', 'resolved',
			    'gt', 5, '2026-11-06T08:00:00Z', '2026-11-06T08:10:00Z', '2026-11-06T08:20:00Z', 'd-res', now(), now())`,
			[OPEN, RESOLVED, ORG, RULE],
		),
	)

describe("AlertIncidentAckService", () => {
	it.effect("acknowledges, records who and where, and unacknowledges", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acks = yield* AlertIncidentAckService

			const acked = yield* acks.acknowledge(ORG, OPEN, dana)
			assert.isTrue(acked.changed)
			assert.strictEqual(acked.incident.status, "open")
			assert.isNotNull(acked.incident.acknowledgedAt)
			assert.strictEqual(acked.incident.acknowledgedByUserId, dana.userId)
			assert.strictEqual(acked.incident.acknowledgedByName, "Dana Kim")
			assert.strictEqual(acked.incident.acknowledgedVia, "web")

			yield* TestClock.adjust(Duration.minutes(3))
			const unacked = yield* acks.unacknowledge(ORG, OPEN, slackClick)
			assert.isTrue(unacked.changed)
			assert.isNull(unacked.incident.acknowledgedAt)
			assert.isNull(unacked.incident.acknowledgedVia)

			const events = yield* acks.listEvents(ORG, OPEN)
			assert.deepStrictEqual(
				Arr.map(events, (event) => [event.type, event.actorName, event.source]),
				[
					["acknowledged", "Dana Kim", "web"],
					["unacknowledged", "sam", "slack"],
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("writes one event when the incident is already in the requested state", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acks = yield* AlertIncidentAckService

			yield* acks.acknowledge(ORG, OPEN, dana)
			const again = yield* acks.acknowledge(ORG, OPEN, slackClick)
			assert.isFalse(again.changed)
			// The first acknowledger stays on record.
			assert.strictEqual(again.incident.acknowledgedByName, "Dana Kim")

			const notAcked = yield* acks
				.unacknowledge(ORG, OPEN, dana)
				.pipe(Effect.andThen(acks.unacknowledge(ORG, OPEN, dana)))
			assert.isFalse(notAcked.changed)
			assert.lengthOf(yield* acks.listEvents(ORG, OPEN), 2)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses a resolved incident and hides other orgs' incidents", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acks = yield* AlertIncidentAckService

			const resolved = yield* Effect.flip(acks.acknowledge(ORG, RESOLVED, dana))
			assert.strictEqual(resolved._tag, "@maple/http/errors/AlertIncidentResolvedError")

			const foreign = yield* Effect.flip(acks.acknowledge(OTHER_ORG, OPEN, dana))
			assert.strictEqual(foreign._tag, "@maple/http/errors/AlertIncidentNotFoundError")
			const foreignEvents = yield* Effect.flip(acks.listEvents(OTHER_ORG, OPEN))
			assert.strictEqual(foreignEvents._tag, "@maple/http/errors/AlertIncidentNotFoundError")
			assert.lengthOf(yield* acks.listEvents(ORG, OPEN), 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
