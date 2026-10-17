import { OrgId } from "@maple/domain"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { Effect, Fiber, Queue, Schema, Stream } from "effect"
import { describe, expect, test } from "vitest"
import type { AlertRuleRow } from "@maple/web-data/collections/alerts"
import { init, Message, ruleCounts, subscriptions, update } from "./index"

const orgA = Schema.decodeSync(OrgId)("org_a")
const orgB = Schema.decodeSync(OrgId)("org_b")

const rule = (id: string, orgId: string): AlertRuleRow => ({
	id,
	org_id: orgId,
	name: id,
	notes: null,
	notification_template_json: null,
	enabled: true,
	severity: "warning",
	service_names_json: [],
	exclude_service_names_json: [],
	environments_json: [],
	tags_json: [],
	signal_type: "error_rate",
	comparator: "gt",
	threshold: 1,
	threshold_upper: null,
	window_minutes: 5,
	minimum_sample_count: 1,
	consecutive_breaches_required: 1,
	consecutive_healthy_required: 1,
	renotify_interval_minutes: 60,
	apdex_threshold_ms: null,
	query_builder_draft_json: null,
	raw_query_sql: null,
	reducer: "identity",
	group_by: null,
	destination_ids_json: [],
	query_spec_json: null,
	sample_count_strategy: null,
	no_data_behavior: "skip",
	last_scheduled_at: null,
	created_at: "2026-10-01T00:00:00.000Z",
	updated_at: "2026-10-01T00:00:00.000Z",
	created_by: "user",
	updated_by: "user",
})

/** A local stand-in for one org's synced `alert_rules` collection. */
const rulesOf = (orgId: string, count: number) =>
	createCollection(
		// Keyed `string | number` like the Electric collections.
		localOnlyCollectionOptions<AlertRuleRow, string | number>({
			getKey: (row) => row.id,
			initialData: Array.from({ length: count }, (_, index) => rule(`${orgId}-${index}`, orgId)),
		}),
	)

/** Runs a stream into a queue on its own fiber, as the Subscription runtime does. */
const subscribe = (stream: Stream.Stream<Message>) =>
	Effect.gen(function* () {
		const received = yield* Queue.unbounded<Message>()
		const fiber = yield* Effect.forkChild(
			Stream.runForEach(stream, (message) => Queue.offer(received, message)),
		)
		return { received, fiber }
	})

const next = (received: Queue.Queue<Message>) => Queue.take(received).pipe(Effect.timeout("1 second"))

describe("alert rules liveQuery", () => {
	test("emits the org's rows when ready and again after every change", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const rules = rulesOf("org_a", 2)
				const { received } = yield* subscribe(ruleCounts(orgA, rules))
				expect(yield* next(received)).toEqual(Message.UpdatedAlertRules({ orgId: orgA, count: 2 }))
				rules.insert(rule("org_a-new", "org_a"))
				expect(yield* next(received)).toEqual(Message.UpdatedAlertRules({ orgId: orgA, count: 3 }))
			}),
		))

	test("an org switch re-keys the Subscription: the old live query is released, the new one reads the new org", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const before = { ...init().model, session: "SignedIn" as const, orgId: orgA }
				const after = { ...before, orgId: orgB }
				const deps = subscriptions.alertRules.modelToDependencies
				expect(deps(before)).not.toEqual(deps(after))

				const rulesA = rulesOf("org_a", 2)
				const first = yield* subscribe(ruleCounts(orgA, rulesA))
				yield* next(first.received)
				expect(rulesA.subscriberCount).toBeGreaterThan(0)
				yield* Fiber.interrupt(first.fiber)
				yield* Effect.sleep("10 millis")
				expect(rulesA.subscriberCount).toBe(0)

				const second = yield* subscribe(ruleCounts(orgB, rulesOf("org_b", 3)))
				expect(yield* next(second.received)).toEqual(
					Message.UpdatedAlertRules({ orgId: orgB, count: 3 }),
				)
				// An emission the old Subscription queued before it stopped is dropped by update.
				const late = update(after, Message.UpdatedAlertRules({ orgId: orgA, count: 2 }))
				expect(late.model.alertRuleCount).toBeNull()
			}),
		))
})
