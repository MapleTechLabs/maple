import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	AlertDestinationId,
	AlertRuleId,
	AlertRuleUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Array as Arr, Effect, Schema, String as Str } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertRules } from "@maple/db/tables"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { makeAlertRuleNormalizer } from "../AlertRuleModel"
import { makeAlertRulePersistence } from "../AlertRulesService"
import type { AlertRuntimeApi } from "../AlertRuntime"
import {
	DEFAULT_ANOMALY_RULE_PROTECTED_MESSAGE,
	DEFAULT_ANOMALY_RULE_SCOPE_MESSAGE,
	DEFAULT_ANOMALY_RULE_SYSTEM_MESSAGE,
	defaultAnomalyRuleFields,
} from "./anomaly-rule"

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)
const asRuleId = Schema.decodeUnknownSync(AlertRuleId)

const ORG = asOrgId("org_anomaly_rules")
const USER = asUserId("user_anomaly_rules")
const ADMIN_ROLES = [asRoleName("org:admin")]
const NOW = Date.parse("2026-11-06T12:00:00.000Z")
const DEFAULT_RULE_ID = asRuleId("00000000-0000-4000-8000-0000000000aa")
const DESTINATION_ID = Schema.decodeSync(AlertDestinationId)("00000000-0000-4000-8000-0000000000d1")

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

/** A runtime handing out sequential rule ids, so several rules can be created in one test. */
const makeRuntime = Effect.sync((): AlertRuntimeApi => {
	let next = 0
	return {
		now: Effect.succeed(NOW),
		makeUuid: () => asRuleId(`00000000-0000-4000-8000-${Str.padStart(12, "0")(String(100 + next++))}`),
		deliveryTimeoutMs: () => 15_000,
		schedulerTickBudgetMs: () => 25_000,
		schedulerEvalTimeoutMs: () => 15_000,
		schedulerSpreadMs: () => 0,
	}
})

const anomalyRequest = (fields: Partial<ConstructorParameters<typeof AlertRuleUpsertRequest>[0]> = {}) =>
	new AlertRuleUpsertRequest({
		name: "Anomalies",
		signalType: "anomaly",
		comparator: "lt",
		windowMinutes: 5,
		...fields,
	})

describe("anomaly rule normalization", () => {
	it.effect("pins the evaluation fields and turns each tier's value into its severity code", () =>
		Effect.gen(function* () {
			const { normalizeRule } = makeAlertRuleNormalizer(yield* makeRuntime)
			const rule = yield* normalizeRule(
				ORG,
				anomalyRequest({
					serviceNames: ["checkout"],
					environments: ["production"],
					anomalySignals: ["error_rate", "error_rate", "latency_p95"],
					thresholds: [
						{
							severity: "warning",
							value: 40,
							upper: null,
							recoveryValue: 10,
							destinationIds: [],
						},
						{
							severity: "critical",
							value: 90,
							upper: null,
							recoveryValue: null,
							destinationIds: [DESTINATION_ID],
						},
					],
					consecutiveBreachesRequired: 4,
					consecutiveHealthyRequired: 5,
					minimumSampleCount: 50,
					alertOnNoData: true,
					windowMinutes: 60,
					evaluationIntervalMinutes: 10,
				}),
			)
			assert.strictEqual(rule.comparator, "gte")
			assert.deepStrictEqual(
				Arr.map(rule.thresholds, (tier) => [
					tier.severity,
					tier.value,
					tier.upper,
					tier.recoveryValue,
				]),
				[
					["warning", 1, null, null],
					["critical", 2, null, null],
				],
			)
			assert.deepStrictEqual(rule.anomalySignals, ["error_rate", "latency_p95"])
			assert.deepStrictEqual(rule.serviceNames, ["checkout"])
			assert.deepStrictEqual(rule.environments, ["production"])
			assert.deepStrictEqual(rule.excludeServiceNames, [])
			assert.isNull(rule.groupBy)
			assert.strictEqual(rule.consecutiveBreachesRequired, 1)
			assert.isNull(rule.breachesOutOf)
			assert.strictEqual(rule.consecutiveHealthyRequired, 1)
			assert.strictEqual(rule.minimumSampleCount, 0)
			assert.isFalse(rule.alertOnNoData)
			assert.strictEqual(rule.evaluationIntervalMinutes, 1)
			assert.strictEqual(rule.windowMinutes, 5)
			// No query: the evaluator reads the detector's incidents.
			assert.isNull(rule.compiledPlan.query)
			assert.isNull(rule.compiledPlan.rawSql)
		}),
	)

	it.effect("lets only the unscoped default go unrouted, and a disabled scoped rule", () =>
		Effect.gen(function* () {
			const { normalizeRule } = makeAlertRuleNormalizer(yield* makeRuntime)
			const unscoped = yield* normalizeRule(ORG, anomalyRequest({ severity: "critical" }))
			assert.deepStrictEqual(unscoped.destinationIds, [])
			assert.deepStrictEqual(
				Arr.map(unscoped.thresholds, (tier) => [tier.severity, tier.value]),
				[["critical", 2]],
			)

			const scoped = anomalyRequest({ severity: "critical", serviceNames: ["checkout"] })
			const refused = yield* Effect.flip(normalizeRule(ORG, scoped))
			assert.include(refused.message, "A scoped anomaly rule needs a destination on at least one tier")
			const paused = yield* normalizeRule(
				ORG,
				new AlertRuleUpsertRequest({ ...scoped, enabled: false }),
			)
			assert.isFalse(paused.enabled)
			// A preview of the same rule is not held to it.
			yield* normalizeRule(ORG, scoped, { forPreview: true })
		}),
	)

	it.effect("rejects anomalySignals on any other signal type", () =>
		Effect.gen(function* () {
			const { normalizeRule } = makeAlertRuleNormalizer(yield* makeRuntime)
			const error = yield* Effect.flip(
				normalizeRule(
					ORG,
					new AlertRuleUpsertRequest({
						name: "Errors",
						signalType: "error_rate",
						comparator: "gt",
						threshold: 0.05,
						severity: "warning",
						windowMinutes: 5,
						anomalySignals: ["error_rate"],
						destinationIds: [],
					}),
					{ forPreview: true },
				),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/AlertValidationError")
			assert.include(error.message, "anomalySignals is only supported for anomaly alerts")
		}),
	)

	it.effect("rejects excluded services, which anomaly scope cannot honour", () =>
		Effect.gen(function* () {
			const { normalizeRule } = makeAlertRuleNormalizer(yield* makeRuntime)
			const error = yield* Effect.flip(
				normalizeRule(ORG, anomalyRequest({ excludeServiceNames: ["checkout"] }), {
					forPreview: true,
				}),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/AlertValidationError")
			assert.include(error.message, "excludeServiceNames is not supported for anomaly alerts")
		}),
	)
})

describe("default anomaly rule", () => {
	const makePersistence = Effect.gen(function* () {
		const database = yield* Database
		return makeAlertRulePersistence({ database, runtime: yield* makeRuntime })
	})

	/** The default rule as production makes it: the backfill's row, never `createRule`. */
	const seedDefaultRule = Effect.gen(function* () {
		const database = yield* Database
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(AlertRules).values({
					...defaultAnomalyRuleFields(ORG),
					id: DEFAULT_RULE_ID,
					lastScheduledAt: null,
					createdAt: NOW,
					updatedAt: NOW,
					createdBy: USER,
					updatedBy: USER,
				}),
			),
		)
	}).pipe(Effect.orDie)

	const seedDestination = (testDb: TestDb) =>
		Effect.promise(() =>
			executeSql(
				testDb,
				`insert into alert_destinations (id, org_id, name, type, config_json, secret_ciphertext, secret_iv, secret_tag, created_at, updated_at, created_by, updated_by)
				 values ($1, $2, 'Hook', 'webhook', '{}'::jsonb, '', '', '', now(), now(), 'u', 'u')`,
				[DESTINATION_ID, ORG],
			),
		)

	const routed = { destinationIds: [DESTINATION_ID] }

	it.effect("refuses an unscoped rule from the API, with or without a default already there", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			const rules = yield* makePersistence
			const unscoped = (name: string, enabled = true) =>
				Effect.flip(rules.createRule(ORG, USER, ADMIN_ROLES, anomalyRequest({ name, enabled })))
			assert.strictEqual((yield* unscoped("Mine")).message, DEFAULT_ANOMALY_RULE_SYSTEM_MESSAGE)
			assert.strictEqual(
				(yield* unscoped("Paused", false)).message,
				DEFAULT_ANOMALY_RULE_SYSTEM_MESSAGE,
			)
			assert.deepStrictEqual((yield* rules.listRules(ORG)).rules, [])

			yield* seedDefaultRule
			assert.strictEqual((yield* unscoped("Second")).message, DEFAULT_ANOMALY_RULE_SYSTEM_MESSAGE)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("refuses editing a scoped rule into an unscoped one", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* seedDestination(testDb)
			const rules = yield* makePersistence
			const scoped = yield* rules.createRule(
				ORG,
				USER,
				ADMIN_ROLES,
				anomalyRequest({ name: "Latency only", anomalySignals: ["latency_p95"], ...routed }),
			)
			assert.deepStrictEqual(scoped.anomalySignals, ["latency_p95"])
			const widened = yield* Effect.flip(
				rules.upsertRuleRow(
					ORG,
					USER,
					scoped.id,
					anomalyRequest({ name: "Latency only", ...routed }),
				),
			)
			assert.strictEqual(widened.message, DEFAULT_ANOMALY_RULE_SYSTEM_MESSAGE)
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect("never counts the default rule against the active rule cap, whatever rule is written", () => {
		const testDb = createTestDb(createdDbs)
		const errorRateRule = (name: string) =>
			new AlertRuleUpsertRequest({
				name,
				signalType: "error_rate",
				comparator: "gt",
				threshold: 0.05,
				severity: "warning",
				windowMinutes: 5,
				destinationIds: [DESTINATION_ID],
			})
		return Effect.gen(function* () {
			yield* seedDestination(testDb)
			const rules = yield* makePersistence
			yield* seedDefaultRule
			const template = yield* rules.createRule(ORG, USER, ADMIN_ROLES, errorRateRule("r0"))
			// 98 more copies of it: 99 counted rules beside the default.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_rules
					 select (jsonb_populate_record(r, jsonb_build_object('id', gen_random_uuid()::text, 'name', 'r' || n))).*
					 from alert_rules r, generate_series(1, 98) n where r.id = $1`,
					[template.id],
				),
			)

			const hundredth = yield* rules.createRule(ORG, USER, ADMIN_ROLES, errorRateRule("r99"))
			assert.strictEqual(hundredth.name, "r99")
			const over = yield* Effect.flip(rules.createRule(ORG, USER, ADMIN_ROLES, errorRateRule("r100")))
			assert.include(over.message, "at most 100 active alert rules")
		}).pipe(Effect.provide(testDb.layer))
	})

	it.effect(
		"keeps the default enabled, unscoped and undeletable, but lets it be renamed and routed",
		() => {
			const testDb = createTestDb(createdDbs)
			return Effect.gen(function* () {
				yield* seedDestination(testDb)
				yield* seedDefaultRule
				const rules = yield* makePersistence
				const edit = (fields: Partial<ConstructorParameters<typeof AlertRuleUpsertRequest>[0]>) =>
					rules.upsertRuleRow(
						ORG,
						USER,
						DEFAULT_RULE_ID,
						anomalyRequest({ name: "Default", ...fields }),
					)

				const deleted = yield* Effect.flip(rules.deleteRule(ORG, ADMIN_ROLES, DEFAULT_RULE_ID))
				assert.strictEqual(deleted.message, DEFAULT_ANOMALY_RULE_PROTECTED_MESSAGE)
				assert.strictEqual(
					(yield* Effect.flip(edit({ enabled: false }))).message,
					DEFAULT_ANOMALY_RULE_PROTECTED_MESSAGE,
				)
				assert.strictEqual(
					(yield* Effect.flip(
						rules.upsertRuleRow(
							ORG,
							USER,
							DEFAULT_RULE_ID,
							new AlertRuleUpsertRequest({
								name: "Default",
								signalType: "error_rate",
								comparator: "gt",
								threshold: 0.05,
								severity: "warning",
								windowMinutes: 5,
								...routed,
							}),
						),
					)).message,
					DEFAULT_ANOMALY_RULE_PROTECTED_MESSAGE,
				)
				assert.strictEqual(
					(yield* Effect.flip(edit({ serviceNames: ["api"], ...routed }))).message,
					DEFAULT_ANOMALY_RULE_SCOPE_MESSAGE,
				)

				const renamed = yield* edit({ name: "Everything anomalous", ...routed })
				assert.strictEqual(renamed.name, "Everything anomalous")
				assert.isTrue(renamed.enabled)
				assert.deepStrictEqual(renamed.destinationIds, [DESTINATION_ID])

				// A scoped anomaly rule is an ordinary rule: it can be disabled and deleted.
				const scopedRule = yield* rules.createRule(
					ORG,
					USER,
					ADMIN_ROLES,
					anomalyRequest({ name: "Checkout", serviceNames: ["checkout"], ...routed }),
				)
				const paused = yield* rules.upsertRuleRow(
					ORG,
					USER,
					scopedRule.id,
					anomalyRequest({ name: "Checkout", serviceNames: ["checkout"], enabled: false }),
				)
				assert.isFalse(paused.enabled)
				const gone = yield* rules.deleteRule(ORG, ADMIN_ROLES, scopedRule.id)
				assert.strictEqual(gone.id, scopedRule.id)
			}).pipe(Effect.provide(testDb.layer))
		},
	)
})
