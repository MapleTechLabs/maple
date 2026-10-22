import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { CreateSourceRequest, OrgId, ScrapeTargetDeleteResponse, UserId } from "@maple/domain/http"
import { AwsAccountId, GcpProjectId, SourceId } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { AwsConnectionService } from "./AwsConnectionService"
import { GcpConnectorService } from "./GcpConnectorService"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { RailwayMetricsService } from "./RailwayMetricsService"
import { ScrapeTargetsService } from "./ScrapeTargetsService"
import { SourceRemovalService } from "./SourceRemovalService"
import { SupabaseConnectionService } from "./SupabaseConnectionService"
import { VcsRepository } from "./vcs/VcsRepository"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		MCP_PORT: "3473",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	}),
)

const org = Schema.decodeUnknownSync(OrgId)("org_a")
const user = Schema.decodeUnknownSync(UserId)("user_a")
const decodeSourceId = Schema.decodeUnknownSync(SourceId)

const projectId = Schema.decodeUnknownSync(GcpProjectId)("acme-prod")
const accountId = Schema.decodeUnknownSync(AwsAccountId)("123456789012")

const die = () => Effect.die("not used by SourceRemovalService")

/** Integration services that record each disconnect they are asked for. */
const makeLayer = (testDb: TestDb, calls: string[]) => {
	const record = (call: string) => Effect.sync(() => void calls.push(call))
	const disconnected = (platform: string) => () => Effect.as(record(platform), { disconnected: true })
	const integrations = Layer.mergeAll(
		Layer.succeed(ScrapeTargetsService, {
			list: die,
			get: die,
			create: die,
			update: die,
			delete: (_orgId, targetId) =>
				Effect.as(record(`prometheus:${targetId}`), new ScrapeTargetDeleteResponse({ id: targetId })),
			deleteManaged: die,
			listAllEnabled: die,
			authHeaders: die,
			recordScrapeResults: die,
			listChecks: die,
			probe: die,
		}),
		Layer.succeed(GcpConnectorService, {
			status: die,
			resources: die,
			create: die,
			update: die,
			scripts: die,
			confirmRemoval: die,
			delete: (_orgId, connectorId) =>
				Effect.as(record(`gcp:${connectorId}`), {
					connector: {
						id: connectorId,
						scopeType: "project",
						scopeId: projectId,
						projectId,
						logsEnabled: true,
						metricsEnabled: true,
						createdAt: 0,
						lastLogReceivedAt: null,
						lastLogError: null,
						appliedLogsEnabled: true,
						appliedMetricsEnabled: true,
						setupReportedAt: 0,
						lastMetricsReceivedAt: null,
						lastMetricsError: null,
						discoveredProjectCount: 1,
						lastResourcesError: null,
					},
					cleanupScript: "gcloud logging sinks delete maple",
				}),
		}),
		Layer.succeed(AwsConnectionService, {
			status: die,
			create: die,
			update: die,
			setup: die,
			check: die,
			checkDue: die,
			delete: (_orgId, connectionId) =>
				Effect.as(record(`aws:${connectionId}`), {
					connection: {
						id: connectionId,
						accountId,
						roleArn: "arn:aws:iam::123456789012:role/MapleIntegration-abc",
						externalId: "external",
						modules: [],
						grantedModules: null,
						templateVersion: null,
						setupOutdated: false,
						verifiedAt: null,
						lastCheckedAt: null,
						lastCheckError: null,
						createdAt: 0,
					},
					cleanupScript: "aws cloudformation delete-stack",
				}),
		}),
		Layer.succeed(CloudflareOAuthService, {
			startConnect: die,
			completeConnect: die,
			getStatus: die,
			getValidAccessToken: die,
			disconnect: disconnected("cloudflare"),
			markConnectionRevoked: die,
		}),
		Layer.succeed(RailwayMetricsService, {
			getStatus: die,
			connect: die,
			disconnect: disconnected("railway"),
			sync: die,
			pollOrg: die,
			pollAllOrgs: die,
		}),
		Layer.succeed(PlanetScaleConnectionService, {
			getStatus: die,
			finalizeOrgSelection: die,
			setMetricsToken: die,
			disconnect: disconnected("planetscale"),
			loadConnection: die,
			loadConnectionById: die,
			webhookConfig: die,
		}),
		Layer.succeed(SupabaseConnectionService, {
			getStatus: die,
			finalizeConnect: die,
			sync: die,
			updateProject: die,
			disconnect: disconnected("supabase"),
			discoverOrg: die,
			discoverAllOrgs: die,
		}),
	)
	const sources = SourcesService.layer.pipe(Layer.provide(Env.layer), Layer.provide(config))
	return Layer.effect(SourceRemovalService, SourceRemovalService.make).pipe(
		Layer.provideMerge(sources),
		Layer.provide(VcsRepository.layer),
		Layer.provide(integrations),
		Layer.provideMerge(testDb.layer),
	)
}

const insertSource = (testDb: TestDb, id: string, platform: string) =>
	executeSql(
		testDb,
		`INSERT INTO sources (id, org_id, name, platform, kind, created_at, updated_at)
		 VALUES ($1, $2, $3, $3, 'integration', now(), now())`,
		[id, org, platform],
	)

const sourceCount = (testDb: TestDb, id: string) =>
	Effect.promise(() =>
		queryFirstRow<{ count: number }>(testDb, "SELECT count(*)::int AS count FROM sources WHERE id = $1", [
			id,
		]),
	).pipe(Effect.map((row) => row?.count ?? 0))

const SOURCE_A = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a01"
const SOURCE_B = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a02"
const TARGET_1 = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4b01"
const TARGET_2 = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4b02"
const TARGET_OTHER = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4b03"
const INSTALLATION_A = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4c01"
const INSTALLATION_B = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4c02"

describe("SourceRemovalService", () => {
	it.effect("deletes a Prometheus source by deleting only the scrape targets sending as it", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: string[] = []
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				await insertSource(testDb, SOURCE_A, "prometheus")
				await insertSource(testDb, SOURCE_B, "prometheus")
				for (const [target, source] of [
					[TARGET_1, SOURCE_A],
					[TARGET_2, SOURCE_A],
					[TARGET_OTHER, SOURCE_B],
				]) {
					await executeSql(
						testDb,
						`INSERT INTO scrape_targets (id, org_id, source_id, name, url, created_at, updated_at)
						 VALUES ($1, $2, $3, 'node', 'http://node:9100/metrics', now(), now())`,
						[target, org, source],
					)
				}
			})
			const removal = yield* SourceRemovalService
			const removed = yield* removal.remove(org, decodeSourceId(SOURCE_A))

			assert.strictEqual(removed.source.platform, "prometheus")
			assert.strictEqual(removed.cleanupScript, null)
			assert.deepStrictEqual(calls.toSorted(), [`prometheus:${TARGET_1}`, `prometheus:${TARGET_2}`])
			assert.strictEqual(yield* sourceCount(testDb, SOURCE_A), 0)
			assert.strictEqual(yield* sourceCount(testDb, SOURCE_B), 1)
		}).pipe(Effect.provide(makeLayer(testDb, calls)))
	})

	it.effect("deletes one GitHub installation's source and leaves the org's other installation", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: string[] = []
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				for (const [installation, source, login] of [
					[INSTALLATION_A, SOURCE_A, "acme"],
					[INSTALLATION_B, SOURCE_B, "acme-labs"],
				]) {
					await insertSource(testDb, source, "github")
					await executeSql(
						testDb,
						`INSERT INTO vcs_installations (id, org_id, source_id, provider, external_installation_id,
							account_login, account_type, external_account_id, status, installed_by_user_id, created_at, updated_at)
						 VALUES ($1, $2, $3, 'github', $4, $4, 'Organization', $4, 'active', 'user_a', now(), now())`,
						[installation, org, source, login],
					)
				}
			})
			const removal = yield* SourceRemovalService
			yield* removal.remove(org, decodeSourceId(SOURCE_A))

			const installations = yield* Effect.promise(() =>
				queryFirstRow<{ ids: string }>(
					testDb,
					"SELECT string_agg(id, ',') AS ids FROM vcs_installations",
				),
			)
			assert.strictEqual(installations?.ids, INSTALLATION_B)
			assert.strictEqual(yield* sourceCount(testDb, SOURCE_A), 0)
			assert.strictEqual(yield* sourceCount(testDb, SOURCE_B), 1)
			assert.deepStrictEqual(calls, [])
		}).pipe(Effect.provide(makeLayer(testDb, calls)))
	})

	it.effect("disconnects a one-per-org integration only while it still sends as the source", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: string[] = []
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				await insertSource(testDb, SOURCE_A, "railway")
				await executeSql(
					testDb,
					`INSERT INTO railway_connections (id, org_id, source_id, token_ciphertext, token_iv, token_tag,
						connected_by_user_id, created_at, updated_at)
					 VALUES ('conn_1', $1, $2, 'c', 'i', 't', 'user_a', now(), now())`,
					[org, SOURCE_A],
				)
				// A Cloudflare source left behind by a connection that is already gone.
				await insertSource(testDb, SOURCE_B, "cloudflare")
			})
			const removal = yield* SourceRemovalService
			yield* removal.remove(org, decodeSourceId(SOURCE_A))
			yield* removal.remove(org, decodeSourceId(SOURCE_B))

			assert.deepStrictEqual(calls, ["railway"])
			assert.strictEqual(yield* sourceCount(testDb, SOURCE_A), 0)
			assert.strictEqual(yield* sourceCount(testDb, SOURCE_B), 0)
		}).pipe(Effect.provide(makeLayer(testDb, calls)))
	})

	it.effect(
		"deletes a Google Cloud source by deleting its connector and answers with the cleanup script",
		() => {
			const testDb = createTestDb(trackedDbs)
			const calls: string[] = []
			const connector = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4d01"
			return Effect.gen(function* () {
				yield* Effect.promise(async () => {
					await insertSource(testDb, SOURCE_A, "gcp")
					await executeSql(
						testDb,
						`INSERT INTO gcp_connectors (id, org_id, source_id, scope_type, scope_id, project_id, secret_ciphertext,
						secret_iv, secret_tag, secret_hash, created_by, created_at, updated_at)
					 VALUES ($1, $2, $3, 'project', 'acme-prod', 'acme-prod', 'c', 'i', 't', 'h', 'user_a', now(), now())`,
						[connector, org, SOURCE_A],
					)
				})
				const removal = yield* SourceRemovalService
				const removed = yield* removal.remove(org, decodeSourceId(SOURCE_A))

				assert.deepStrictEqual(calls, [`gcp:${connector}`])
				assert.strictEqual(removed.cleanupScript, "gcloud logging sinks delete maple")
				assert.strictEqual(yield* sourceCount(testDb, SOURCE_A), 0)
			}).pipe(Effect.provide(makeLayer(testDb, calls)))
		},
	)

	it.effect("deletes an AWS source by deleting its connection and answers with the cleanup script", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: string[] = []
		const connection = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4e01"
		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				await insertSource(testDb, SOURCE_A, "aws")
				await executeSql(
					testDb,
					`INSERT INTO aws_connections (id, org_id, source_id, account_id, external_id, modules, created_by,
						created_at, updated_at)
					 VALUES ($1, $2, $3, '123456789012', 'external', '[]', 'user_a', now(), now())`,
					[connection, org, SOURCE_A],
				)
			})
			const removal = yield* SourceRemovalService
			const removed = yield* removal.remove(org, decodeSourceId(SOURCE_A))

			assert.deepStrictEqual(calls, [`aws:${connection}`])
			assert.strictEqual(removed.cleanupScript, "aws cloudformation delete-stack")
			assert.strictEqual(yield* sourceCount(testDb, SOURCE_A), 0)
		}).pipe(Effect.provide(makeLayer(testDb, calls)))
	})

	it.effect("deletes a token source directly and refuses the default source", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: string[] = []
		return Effect.gen(function* () {
			const sources = yield* SourcesService
			const removal = yield* SourceRemovalService
			const created = yield* sources.create(
				org,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "Checkout" }),
			)
			const removed = yield* removal.remove(org, created.source.id)
			assert.strictEqual(removed.source.id, created.source.id)
			assert.strictEqual(yield* sourceCount(testDb, created.source.id), 0)

			const defaultSource = (yield* sources.list(org)).find((source) => source.kind === "default")
			assert.isDefined(defaultSource)
			const refused = yield* removal.remove(org, defaultSource.id).pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/SourceValidationError")
			assert.deepStrictEqual(calls, [])
		}).pipe(Effect.provide(makeLayer(testDb, calls)))
	})
})
