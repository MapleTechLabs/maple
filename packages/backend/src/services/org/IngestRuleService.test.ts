import { afterEach, describe, expect, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import type { IngestRuleSpec } from "@maple/domain/ingest-rules"
import { Effect, Layer, Schema } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { IngestRuleService } from "./IngestRuleService"
import { OrganizationFeatureFlagsService } from "./OrganizationFeatureFlagsService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const makeLayer = (
	flags: Layer.Layer<OrganizationFeatureFlagsService> = OrganizationFeatureFlagsService.allEnabled,
) =>
	Layer.effect(IngestRuleService, IngestRuleService.make).pipe(
		Layer.provide(Layer.mergeAll(createTestDb(createdDbs).layer, flags)),
	)

const ORG = Schema.decodeUnknownSync(OrgId)("org_rules")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_other")

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
			expect(rules.map((rule) => [rule.name, rule.position])).toEqual([
				["Drop debug", 0],
				["Mask emails", 1],
			])
			expect(rules[1]?.spec).toEqual(maskEmails)

			yield* service.update(ORG, second.id, { position: 0 })
			yield* service.update(ORG, first.id, { position: 5, enabled: false })
			const reordered = yield* service.list(ORG)
			expect(reordered.map((rule) => [rule.name, rule.enabled])).toEqual([
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

	it.effect("stops at the per-org rule cap, even for creates sent together", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			yield* Effect.forEach(
				Array.from({ length: 48 }, (_, index) => index),
				(index) => service.create(ORG, { name: `Rule ${index}`, spec: maskEmails }),
			)
			const results = yield* Effect.all(
				[1, 2, 3].map((index) =>
					service.create(ORG, { name: `Late ${index}`, spec: maskEmails }).pipe(Effect.result),
				),
				{ concurrency: "unbounded" },
			)
			expect(results.filter((result) => result._tag === "Success")).toHaveLength(2)
			const rules = yield* service.list(ORG)
			expect(rules).toHaveLength(50)
			expect(new Set(rules.map((rule) => rule.position)).size).toBe(50)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses to create rules for an org that is not rolled out", () =>
		Effect.gen(function* () {
			const service = yield* IngestRuleService
			const refused = yield* service
				.create(ORG, { name: "Drop debug", spec: dropDebug })
				.pipe(Effect.flip)
			expect(refused._tag).toBe("@maple/http/errors/IngestRuleForbiddenError")
			expect(yield* service.list(ORG)).toEqual([])
		}).pipe(
			Effect.provide(
				makeLayer(OrganizationFeatureFlagsService.fixed(DISABLED_ORGANIZATION_FEATURE_FLAGS)),
			),
		),
	)

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
})
