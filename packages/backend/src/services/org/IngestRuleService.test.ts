import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import type { IngestRuleSpec } from "@maple/domain/ingest-rules"
import { Effect, Layer, Schema, Array as Arr } from "effect"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { IngestRuleService } from "./IngestRuleService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = (testDb: TestDb = createTestDb(createdDbs)) =>
	Layer.effect(IngestRuleService, IngestRuleService.make).pipe(Layer.provide(testDb.layer))

const ORG = Schema.decodeSync(OrgId)("org_rules")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")

const dropDebug: IngestRuleSpec = {
	signals: ["logs"],
	conditions: [{ field: "severity", op: "lt", value: "info" }],
	action: { _tag: "drop", keepPercent: 0 },
}
const maskEmails: IngestRuleSpec = {
	signals: ["logs", "traces"],
	conditions: [],
	action: {
		_tag: "redact",
		keys: [],
		detectors: ["email"],
		patterns: [],
		scopes: ["attributes"],
		method: "mask",
	},
}

describe("IngestRuleService", () => {
	it.effect("appends rules in position order and keeps them per org", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			const first = yield* service.create(ORG, { name: "Drop debug", spec: dropDebug })
			const second = yield* service.create(ORG, { name: " Mask emails ", spec: maskEmails })
			yield* service.create(OTHER_ORG, { name: "Other", spec: maskEmails })

			const rules = yield* service.list(ORG)
			expect(Arr.map(rules, (rule) => [rule.name, rule.position])).toEqual([
				["Drop debug", 0],
				["Mask emails", 1],
			])
			expect(rules[1]?.spec).toEqual(maskEmails)

			yield* service.update(ORG, second.id, { position: 0 })
			yield* service.update(ORG, first.id, { position: 5, enabled: false })
			const reordered = yield* service.list(ORG)
			expect(Arr.map(reordered, (rule) => [rule.name, rule.enabled])).toEqual([
				["Mask emails", true],
				["Drop debug", false],
			])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("rejects an invalid spec with every problem listed", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			const error = yield* service
				.create(ORG, { name: "Bad", spec: { ...dropDebug, conditions: [] } })
				.pipe(Effect.flip)
			expect(error._tag).toBe("@maple/http/errors/IngestRuleValidationError")
			expect(
				error._tag === "@maple/http/errors/IngestRuleValidationError" ? error.problems : [],
			).toEqual(["a drop rule needs at least one condition"])
			expect(yield* service.list(ORG)).toEqual([])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("rejects a blank name or a fractional position whoever calls it", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			const blank = yield* service.create(ORG, { name: "  ", spec: dropDebug }).pipe(Effect.flip)
			expect(
				blank._tag === "@maple/http/errors/IngestRuleValidationError" ? blank.problems : [],
			).toEqual(["the name must be 1 to 120 characters"])
			const rule = yield* service.create(ORG, { name: "Drop debug", spec: dropDebug })
			const moved = yield* service.update(ORG, rule.id, { position: 1.5 }).pipe(Effect.flip)
			expect(
				moved._tag === "@maple/http/errors/IngestRuleValidationError" ? moved.problems : [],
			).toEqual(["position is a whole number from 0 to 10000"])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("never derives a position past the maximum the API accepts", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			yield* service.create(ORG, { name: "Last", position: 10_000, spec: dropDebug })
			const next = yield* service.create(ORG, { name: "Next", spec: maskEmails })
			expect(next.position).toBe(10_000)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("reorders every rule at once and refuses a partial or foreign list", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			const first = yield* service.create(ORG, { name: "First", spec: dropDebug })
			const second = yield* service.create(ORG, { name: "Second", spec: maskEmails })
			const other = yield* service.create(OTHER_ORG, { name: "Other", spec: maskEmails })
			const reordered = yield* service.reorder(ORG, [second.id, first.id])
			expect(Arr.map(reordered, (rule) => [rule.name, rule.position])).toEqual([
				["Second", 0],
				["First", 1],
			])
			const partial = yield* service.reorder(ORG, [first.id]).pipe(Effect.flip)
			const foreign = yield* service.reorder(ORG, [first.id, other.id]).pipe(Effect.flip)
			expect([partial._tag, foreign._tag]).toEqual([
				"@maple/http/errors/IngestRuleValidationError",
				"@maple/http/errors/IngestRuleValidationError",
			])
			expect(Arr.map(yield* service.list(ORG), (rule) => rule.name)).toEqual(["Second", "First"])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("stops at the per-org rule cap, even for creates sent together", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			yield* Effect.forEach(
				Array.from({ length: 48 }, (_, index) => index),
				(index) => service.create(ORG, { name: `Rule ${index}`, spec: maskEmails }),
			)
			const results = yield* Effect.forEach(
				[1, 2, 3],
				(index) =>
					service.create(ORG, { name: `Late ${index}`, spec: maskEmails }).pipe(Effect.result),
				{ concurrency: "unbounded" },
			)
			expect(Arr.filter(results, (result) => result._tag === "Success")).toHaveLength(2)
			const rules = yield* service.list(ORG)
			expect(rules).toHaveLength(50)
			expect(new Set(Arr.map(rules, (rule) => rule.position)).size).toBe(50)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses a create or update that takes the org's regexes past the budget together", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			// Each rule fits alone; the gateway compiles them all at once.
			const heavy = (count: number): IngestRuleSpec => ({
				signals: ["logs"],
				conditions: [],
				action: {
					_tag: "redact",
					keys: [],
					detectors: [],
					patterns: Array.from({ length: count }, () => "\\d{170}"),
					scopes: ["attributes"],
					method: "mask",
				},
			})
			const first = yield* service.create(ORG, { name: "Heavy 1", spec: heavy(5) })
			const refused = yield* service.create(ORG, { name: "Heavy 2", spec: heavy(5) }).pipe(Effect.flip)
			expect(refused._tag).toBe("@maple/http/errors/IngestRuleValidationError")
			expect(refused.message).toMatch(
				/^the regexes across this organization's ingest rules are too large/,
			)

			const second = yield* service.create(ORG, { name: "Light", spec: heavy(4) })
			const grown = yield* service.update(ORG, second.id, { spec: heavy(5) }).pipe(Effect.flip)
			expect(grown._tag).toBe("@maple/http/errors/IngestRuleValidationError")
			// The rule's own old spec does not count against its new one.
			yield* service.update(ORG, first.id, { spec: heavy(5), name: "Heavy 1b" })
			yield* service.create(OTHER_ORG, { name: "Other", spec: heavy(5) })
			expect(Arr.map(yield* service.list(ORG), (rule) => rule.name)).toEqual(["Heavy 1b", "Light"])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("lets an org stored past the regex budget shrink a rule but not grow one", () => {
		const testDb = createTestDb(createdDbs)
		const patterns = (count: number): IngestRuleSpec => ({
			...maskEmails,
			action: {
				...maskEmails.action,
				detectors: [],
				patterns: Array.from({ length: count }, () => "\\d{170}"),
			},
		})
		return Effect.gen(function* () {
			const service = yield* IngestRuleService
			const first = yield* service.create(ORG, { name: "First", spec: patterns(5) })
			const second = yield* service.create(ORG, { name: "Second", spec: patterns(4) })
			// Rows stored before the budget existed: 10 heavy patterns over two rules.
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE org_ingest_rules SET spec_json = $1 WHERE id = $2", [
					JSON.stringify(patterns(5)),
					second.id,
				]),
			)
			const grown = yield* service.update(ORG, first.id, { spec: patterns(6) }).pipe(Effect.flip)
			expect(grown._tag).toBe("@maple/http/errors/IngestRuleValidationError")
			yield* service.update(ORG, first.id, { spec: patterns(5), name: "First, unchanged" })
			const shrunk = yield* service.update(ORG, second.id, { spec: patterns(4) })
			expect(shrunk.spec).toEqual(patterns(4))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("cannot read, update or delete another org's rule", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			const rule = yield* service.create(ORG, { name: "Drop debug", spec: dropDebug })
			const read = yield* service.get(OTHER_ORG, rule.id).pipe(Effect.flip)
			const updated = yield* service.update(OTHER_ORG, rule.id, { enabled: false }).pipe(Effect.flip)
			const deleted = yield* service.delete(OTHER_ORG, rule.id).pipe(Effect.flip)
			expect([read._tag, updated._tag, deleted._tag]).toEqual([
				"@maple/http/errors/IngestRuleNotFoundError",
				"@maple/http/errors/IngestRuleNotFoundError",
				"@maple/http/errors/IngestRuleNotFoundError",
			])
			expect((yield* service.get(ORG, rule.id)).enabled).toBe(true)
			yield* service.delete(ORG, rule.id)
			expect(yield* service.list(ORG)).toEqual([])
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("sums the gateway's hourly counters per rule and per signal inside the window", () => {
		const testDb = createTestDb(createdDbs)
		const hour = Date.UTC(2026, 9, 28, 10)
		const insert = (rule: string, bucket: number, signal: string, dropped: number, bytes: number) =>
			Effect.promise(() =>
				executeSql(
					testDb,
					"INSERT INTO org_ingest_rule_stats (org_id, rule_id, bucket, signal, matched, dropped, dropped_bytes, redacted_values) VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $5, $6, 0)",
					[ORG, rule, bucket, signal, dropped, bytes],
				),
			)
		return Effect.gen(function* () {
			const service = yield* IngestRuleService
			const rule = yield* service.create(ORG, { name: "Drop debug", spec: dropDebug })
			yield* insert(rule.id, hour, "logs", 10, 1000)
			yield* insert(rule.id, hour + 3_600_000, "logs", 5, 500)
			yield* insert(rule.id, hour - 3_600_000, "logs", 99, 9900)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"INSERT INTO org_ingest_rule_stats (org_id, rule_id, bucket, signal, matched, dropped, dropped_bytes, redacted_values) VALUES ($1, $2, to_timestamp($3 / 1000.0), 'logs', 7, 7, 700, 0)",
					[OTHER_ORG, rule.id, hour],
				),
			)
			const window = yield* service.stats(ORG, hour, hour + 2 * 3_600_000)
			expect(window.rules).toEqual([
				{ ruleId: rule.id, matched: 15, dropped: 15, droppedBytes: 1500, redactedValues: 0 },
			])
			expect(window.signals).toEqual([
				{ signal: "logs", matched: 15, dropped: 15, droppedBytes: 1500, redactedValues: 0 },
			])
			expect(window.hourly).toEqual([
				{ ruleId: rule.id, bucket: hour, matched: 10 },
				{ ruleId: rule.id, bucket: hour + 3_600_000, matched: 5 },
			])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
