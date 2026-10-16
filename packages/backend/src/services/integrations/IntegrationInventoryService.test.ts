import * as PG from "@maple-dev/effect-orm/postgres"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { RailwayConnections, RailwayEnvironments, ScrapeTargets } from "@maple/db/tables"
import { OrgId, ScrapeTargetId } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { IntegrationInventoryService } from "./IntegrationInventoryService"

const createdDbs: TestDb[] = []
afterEach(async () => {
	await cleanupTestDbs(createdDbs)
})

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asTargetId = Schema.decodeUnknownSync(ScrapeTargetId)
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)

const railwayConnection = (orgId: string) => ({
	id: `rw_${orgId}`,
	orgId: asOrgId(orgId),
	tokenCiphertext: "c",
	tokenIv: "i",
	tokenTag: "t",
	workspaceNames: `${orgId}-workspace`,
	connectedByUserId: "user_1",
	lastSuccessAt: NOW - 60_000,
	createdAt: NOW,
	updatedAt: NOW,
})

describe("IntegrationInventoryService", () => {
	it.effect("reads only the requested org's integrations and counts Railway services", () => {
		const testDb = createTestDb(createdDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const database = yield* Database
			yield* database.execute((db) =>
				Effect.all([
					db.run(PG.insertInto(RailwayConnections).values([railwayConnection("org_a"), railwayConnection("org_b")])),
					db.run(
						PG.insertInto(RailwayEnvironments).values({
							id: "env_1",
							orgId: asOrgId("org_a"),
							connectionId: "rw_org_a",
							projectId: "p1",
							projectName: "shop",
							environmentId: "e1",
							environmentName: "production",
							servicesJson: JSON.stringify({ s1: "api", s2: "worker" }),
							lastSuccessAt: NOW - 60_000,
							createdAt: NOW,
							updatedAt: NOW,
						}),
					),
					db.run(
						PG.insertInto(ScrapeTargets).values({
							id: asTargetId("6f1c2a52-6b0e-4d7e-9a7e-0c1d2e3f4a5b"),
							orgId: asOrgId("org_b"),
							name: "other org exporter",
							url: "https://b.example/metrics",
							createdAt: NOW,
							updatedAt: NOW,
						}),
					),
				]),
			)

			const inventory = yield* (yield* IntegrationInventoryService).list(asOrgId("org_a"))

			assert.deepStrictEqual(
				inventory.integrations.map((i) => i.provider),
				["railway"],
			)
			const railway = inventory.integrations[0]
			assert.strictEqual(railway?.account, "org_a-workspace")
			assert.strictEqual(railway?.status, "healthy")
			assert.strictEqual(railway?.resources[0]?.note, "2 services")
		}).pipe(
			Effect.provide(IntegrationInventoryService.layer.pipe(Layer.provideMerge(testDb.layer))),
		)
	})
})
