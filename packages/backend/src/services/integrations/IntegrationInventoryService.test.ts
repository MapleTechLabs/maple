import * as PG from "@maple-dev/effect-orm/postgres"
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	AwsConnections,
	GcpConnectors,
	GcpResources,
	OAuthConnections,
	RailwayConnections,
	RailwayEnvironments,
	ScrapeTargets,
	SupabaseConnections,
	SupabaseProjects,
	VercelConnections,
	VercelProjects,
} from "@maple/db/tables"
import {
	AwsAccountId,
	AwsConnectionId,
	GcpConnectorId,
	GcpProjectId,
	GcpScopeType,
	OrgId,
	ScrapeTargetId,
	SourceId,
	SupabaseConnectionId,
	SupabaseProjectId,
	SupabaseProjectRef,
	UserId,
} from "@maple/primitives"
import { AwsMetricStream } from "@maple/domain/aws"
import { Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import {
	cleanupTestDbs,
	createTestDb,
	insertTestSource,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { IntegrationInventoryService } from "./IntegrationInventoryService"

const createdDbs: TestDb[] = []
afterEach(async () => {
	await cleanupTestDbs(createdDbs)
})

const asOrgId = Schema.decodeSync(OrgId)
const asTargetId = Schema.decodeSync(ScrapeTargetId)
const asSourceId = Schema.decodeSync(SourceId)
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
const MINUTE = 60_000

/** An integration source whose own row reads healthy: data and a poll a minute ago. */
const healthySource = (testDb: TestDb, orgId: string, platform: string) =>
	Effect.promise(async () => {
		const id = await insertTestSource(testDb, { orgId, platform })
		await testDb.pglite.query(
			"UPDATE sources SET last_poll_ok_at = $1, last_used_at = $1 WHERE id = $2",
			[new Date(NOW - MINUTE).toISOString(), id],
		)
		return asSourceId(id)
	})

const gcpConnector = (id: string, orgId: OrgId, sourceId: SourceId, scopeId: string) => ({
	id: Schema.decodeSync(GcpConnectorId)(id),
	orgId,
	sourceId,
	scopeType: Schema.decodeSync(GcpScopeType)("project"),
	scopeId: Schema.decodeSync(GcpProjectId)(scopeId),
	projectId: Schema.decodeSync(GcpProjectId)(scopeId),
	logsEnabled: true,
	metricsEnabled: true,
	secretCiphertext: "c",
	secretIv: "i",
	secretTag: "t",
	secretHash: `hash_${id}`,
	lastReceivedAt: NOW - 2 * MINUTE,
	setupReportedAt: NOW - 60 * MINUTE,
	appliedLogsEnabled: true,
	appliedMetricsEnabled: true,
	lastMetricsReceivedAt: NOW - 2 * MINUTE,
	resourcesSyncedAt: NOW - 20 * MINUTE,
	createdBy: "user_1",
	createdAt: NOW - 24 * 60 * MINUTE,
	updatedAt: NOW,
})

const railwayConnection = (orgId: string, sourceId: SourceId) => ({
	id: `rw_${orgId}`,
	orgId: asOrgId(orgId),
	sourceId,
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
			const [railwayA, railwayB, exporterB] = yield* Effect.promise(() =>
				Promise.all([
					// Its poller last succeeded a minute ago.
					insertTestSource(testDb, { orgId: "org_a", platform: "railway" }).then(async (id) => {
						await testDb.pglite.query("UPDATE sources SET last_poll_ok_at = $1 WHERE id = $2", [
							new Date(NOW - 60_000).toISOString(),
							id,
						])
						return asSourceId(id)
					}),
					insertTestSource(testDb, { orgId: "org_b", platform: "railway" }).then(asSourceId),
					insertTestSource(testDb, { orgId: "org_b", platform: "prometheus" }).then(asSourceId),
				]),
			)
			yield* database.execute((db) =>
				Effect.all([
					db.run(
						PG.insertInto(RailwayConnections).values([
							railwayConnection("org_a", railwayA),
							railwayConnection("org_b", railwayB),
						]),
					),
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
							sourceId: exporterB,
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
				Arr.map(inventory.integrations, (i) => i.provider),
				["railway"],
			)
			const railway = inventory.integrations[0]
			assert.strictEqual(railway?.account, "org_a-workspace")
			assert.strictEqual(railway?.status, "healthy")
			assert.strictEqual(railway?.resources[0]?.note, "2 services")
		}).pipe(Effect.provide(IntegrationInventoryService.layer.pipe(Layer.provideMerge(testDb.layer))))
	})

	it.effect(
		"reports connected Google Cloud, AWS and Supabase from their own tables, for that org only",
		() => {
			const testDb = createTestDb(createdDbs)
			const orgId = asOrgId("org_cloud")
			const otherOrg = asOrgId("org_other")
			const gcpId = "11111111-1111-4111-8111-111111111111"
			const supabaseId = Schema.decodeSync(SupabaseConnectionId)("33333333-3333-4333-8333-333333333333")
			return Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				const gcpSource = yield* healthySource(testDb, "org_cloud", "gcp")
				const otherGcpSource = yield* healthySource(testDb, "org_other", "gcp")
				const awsSource = yield* healthySource(testDb, "org_cloud", "aws")
				const supabaseSource = yield* healthySource(testDb, "org_cloud", "supabase")
				const database = yield* Database
				yield* database.execute((db) =>
					Effect.all([
						db.run(
							PG.insertInto(GcpConnectors).values([
								gcpConnector(gcpId, orgId, gcpSource, "acme-prod"),
								gcpConnector(
									"22222222-2222-4222-8222-222222222222",
									otherOrg,
									otherGcpSource,
									"other-prod",
								),
							]),
						),
						db.run(
							PG.insertInto(GcpResources).values(
								Arr.map(
									[
										[
											"//cloudresourcemanager.googleapis.com/projects/1",
											"cloudresourcemanager.googleapis.com/Project",
										],
										[
											"//run.googleapis.com/projects/acme-prod/locations/us/services/api",
											"run.googleapis.com/Service",
										],
										[
											"//run.googleapis.com/projects/acme-prod/locations/us/services/web",
											"run.googleapis.com/Service",
										],
									],
									([name, assetType]) => ({
										connectorId: Schema.decodeSync(GcpConnectorId)(gcpId),
										orgId,
										name: name ?? "",
										assetType: assetType ?? "",
										projectId: "acme-prod",
										labels: {},
										lastSeenAt: NOW - 20 * MINUTE,
									}),
								),
							),
						),
						db.run(
							PG.insertInto(AwsConnections).values({
								id: Schema.decodeSync(AwsConnectionId)(
									"44444444-4444-4444-8444-444444444444",
								),
								orgId,
								sourceId: awsSource,
								accountId: Schema.decodeSync(AwsAccountId)("123456789012"),
								modules: [],
								grantedModules: [],
								templateVersion: 2,
								verifiedAt: NOW - 24 * 60 * MINUTE,
								lastCheckedAt: NOW - 30 * MINUTE,
								metricStream: Schema.decodeSync(AwsMetricStream)({
									regions: ["us-east-1"],
									namespaces: ["AWS/Lambda"],
								}),
								metricStreamChangedAt: NOW - 24 * 60 * MINUTE,
								streamLastReceivedAt: NOW - 10 * MINUTE,
								streamLastError: "Firehose delivery refused: bad secret",
								createdBy: "user_1",
								createdAt: NOW - 48 * 60 * MINUTE,
								updatedAt: NOW,
							}),
						),
						db.run(
							PG.insertInto(OAuthConnections).values({
								id: "oauth_supabase",
								orgId,
								provider: "supabase",
								externalUserId: "sb_user",
								connectedByUserId: Schema.decodeSync(UserId)("user_1"),
								accessTokenCiphertext: "c",
								accessTokenIv: "i",
								accessTokenTag: "t",
								createdAt: NOW - 24 * 60 * MINUTE,
								updatedAt: NOW,
							}),
						),
						db.run(
							PG.insertInto(SupabaseConnections).values({
								id: supabaseId,
								orgId,
								sourceId: supabaseSource,
								supabaseOrganizationId: "sb_org",
								supabaseOrganizationSlug: "acme",
								supabaseOrganizationName: "Acme",
								connectedByUserId: Schema.decodeSync(UserId)("user_1"),
								lastDiscoveryAt: NOW - 10 * MINUTE,
								createdAt: NOW - 24 * 60 * MINUTE,
								updatedAt: NOW,
							}),
						),
						db.run(
							PG.insertInto(SupabaseProjects).values(
								Arr.map(
									[
										{
											id: "55555555-5555-4555-8555-555555555555",
											ref: "abcdefghijklmnopqrst",
											name: "shop",
											removedAt: null,
										},
										// Gone upstream: discovery no longer lists it.
										{
											id: "66666666-6666-4666-8666-666666666666",
											ref: "tsrqponmlkjihgfedcba",
											name: "gone",
											removedAt: NOW - MINUTE,
										},
									],
									(project) => ({
										id: Schema.decodeSync(SupabaseProjectId)(project.id),
										orgId,
										connectionId: supabaseId,
										projectRef: Schema.decodeSync(SupabaseProjectRef)(project.ref),
										name: project.name,
										region: "eu-central-1",
										status: "ACTIVE_HEALTHY",
										lastSeenAt: NOW - 10 * MINUTE,
										removedAt: project.removedAt,
										createdAt: NOW - 24 * 60 * MINUTE,
										updatedAt: NOW,
									}),
								),
							),
						),
					]),
				)

				const inventory = yield* (yield* IntegrationInventoryService).list(orgId)
				const byProvider = (provider: string) =>
					Option.getOrUndefined(
						Arr.findFirst(inventory.integrations, (i) => i.provider === provider),
					)

				const gcp = byProvider("gcp")
				assert.strictEqual(gcp?.status, "healthy")
				assert.strictEqual(gcp?.account, "project acme-prod")
				assert.strictEqual(
					Option.getOrUndefined(Arr.findFirst(gcp?.resources ?? [], (r) => r.kind === "inventory"))
						?.note,
					"1 project, 2 resources",
				)

				const aws = byProvider("aws")
				assert.strictEqual(aws?.status, "failing")
				assert.strictEqual(aws?.account, "123456789012")
				assert.include(aws?.problem ?? "", "Firehose delivery refused")

				const supabase = byProvider("supabase")
				assert.strictEqual(supabase?.status, "healthy")
				assert.strictEqual(supabase?.account, "Acme")
				assert.deepStrictEqual(
					Arr.map(supabase?.resources ?? [], (r) => r.name),
					["shop"],
				)
				assert.notInclude(
					Arr.map(inventory.available, (a) => a.provider),
					"gcp",
				)
			}).pipe(Effect.provide(IntegrationInventoryService.layer.pipe(Layer.provideMerge(testDb.layer))))
		},
	)

	it.effect(
		"reports a Vercel drain the poller found missing and counts only the connection's projects",
		() => {
			const testDb = createTestDb(createdDbs)
			const orgId = asOrgId("org_v")
			return Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				const sourceId = asSourceId(
					yield* Effect.promise(() =>
						insertTestSource(testDb, { orgId: "org_v", platform: "vercel" }),
					),
				)
				const database = yield* Database
				yield* database.execute((db) =>
					Effect.all([
						db.run(
							PG.insertInto(VercelConnections).values({
								id: "vc_1",
								orgId,
								sourceId,
								teamId: "team_1",
								teamSlug: "acme",
								teamName: "Acme",
								tokenCiphertext: "c",
								tokenIv: "i",
								tokenTag: "t",
								connectedByUserId: "user_1",
								projectScope: "all",
								logDrainId: null,
								traceDrainId: "drn_1",
								logDrainState: { status: "missing", lastError: "Drain not found" },
								traceDrainState: { status: "enabled", lastError: null },
								lastSuccessAt: NOW - 60_000,
								createdAt: NOW,
								updatedAt: NOW,
							}),
						),
						db.run(
							PG.insertInto(VercelProjects).values(
								Arr.map(["p1", "p2", "p3"], (projectId) => ({
									id: `row_${projectId}`,
									orgId,
									// p3 is left from an earlier connection.
									connectionId: projectId === "p3" ? "vc_0" : "vc_1",
									projectId,
									name: projectId,
									createdAt: NOW,
									updatedAt: NOW,
								})),
							),
						),
					]),
				)
				const inventory = yield* (yield* IntegrationInventoryService).list(orgId)
				const vercel = Option.getOrUndefined(
					Arr.findFirst(inventory.integrations, (i) => i.provider === "vercel"),
				)
				assert.strictEqual(vercel?.account, "Acme (2 projects)")
				assert.strictEqual(vercel?.status, "failing")
				assert.strictEqual(vercel?.resources[0]?.lastError, "Drain not found")
			}).pipe(Effect.provide(IntegrationInventoryService.layer.pipe(Layer.provideMerge(testDb.layer))))
		},
	)
})
