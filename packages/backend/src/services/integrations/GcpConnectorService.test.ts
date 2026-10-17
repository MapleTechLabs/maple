import { afterEach, assert, beforeAll, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { hashIngestKey } from "@maple/db"
import { gcpConnectorResourceNames } from "@maple/domain/gcp"
import { type GcpConnectorId, GcpProjectId, GcpResourceNumber, OrgId, UserId } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import {
	GcpConnectorService,
	type CreateGcpConnectorInput,
	type GcpConnectorServiceApi,
} from "./GcpConnectorService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const LOOKUP_HMAC_KEY = "maple-test-lookup-secret"
const MAPLE_ACCOUNT = "collector@maple-prod.iam.gserviceaccount.com"

// Answers every Google call with a 500: only the access check tests call Google.
const unreachable: typeof fetch = async () => new Response(null, { status: 500 })

// A fresh layer per call: one test builds the service twice, under two configurations.
const makeLayer = (
	testDb: TestDb,
	mapleServiceAccount?: string,
	google: { readonly key?: string; readonly fetch: typeof fetch } = { fetch: unreachable },
) =>
	Layer.effect(GcpConnectorService, GcpConnectorService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, google.fetch)),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
					// Padded: the gateway trims this key before hashing, so the API must too.
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: ` ${LOOKUP_HMAC_KEY} `,
					MAPLE_INGEST_PUBLIC_URL: "https://ingest.test/",
					...(mapleServiceAccount === undefined
						? undefined
						: { MAPLE_GCP_SERVICE_ACCOUNT_EMAIL: mapleServiceAccount }),
					...(google.key === undefined ? undefined : { MAPLE_GCP_SERVICE_ACCOUNT_KEY: google.key }),
				}),
			),
		),
	)

const orgId = Schema.decodeUnknownSync(OrgId)("org_gcp")
const otherOrgId = Schema.decodeUnknownSync(OrgId)("org_other")
const userId = Schema.decodeUnknownSync(UserId)("user_1")
const project = Schema.decodeUnknownSync(GcpProjectId)
const number = Schema.decodeUnknownSync(GcpResourceNumber)

const projectScope = (id: string, flags?: Partial<CreateGcpConnectorInput>): CreateGcpConnectorInput => ({
	scopeType: "project",
	scopeId: project(id),
	projectId: project(id),
	logsEnabled: true,
	metricsEnabled: false,
	...flags,
})

const organizationScope: CreateGcpConnectorInput = {
	scopeType: "organization",
	scopeId: number("123456789012"),
	projectId: project("acme-host"),
	logsEnabled: true,
	metricsEnabled: true,
}

const scriptOptions = { applicationLogs: null }

// A key file for Maple's own service account; Google's token endpoint is stubbed.
let encodedKey = ""
beforeAll(async () => {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)
	const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64")
	encodedKey = Buffer.from(
		JSON.stringify({
			private_key_id: "key-1",
			private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
			client_email: MAPLE_ACCOUNT,
		}),
	).toString("base64")
})

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** Google, with the reader's sign-in and read answered as given. Records the reads it answers. */
const fakeGoogle = (answers: { readonly signIn: number; readonly read: number }) => {
	const reads: Array<{ readonly url: URL; readonly quotaProject: string | null }> = []
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		if (url.hostname === "oauth2.googleapis.com") return json(200, { access_token: "ya29.maple" })
		if (url.hostname === "iamcredentials.googleapis.com") {
			return answers.signIn === 200
				? json(200, { accessToken: "ya29.reader" })
				: json(answers.signIn, { error: { status: "PERMISSION_DENIED" } })
		}
		reads.push({ url, quotaProject: request.headers.get("x-goog-user-project") })
		return answers.read === 200
			? json(200, { results: [] })
			: json(answers.read, { error: { status: "PERMISSION_DENIED" } })
	}
	return { fetch, reads }
}

interface StoredConnector {
	readonly secret_ciphertext: string
	readonly secret_hash: string
	readonly created_by: string
}

describe("GcpConnectorService", () => {
	it.effect("stores a connector whose secret hash is the one the ingest gateway computes", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, projectScope("acme-prod"))
			assert.strictEqual(connector.scopeId, "acme-prod")
			assert.strictEqual(connector.projectId, "acme-prod")
			assert.isNull(connector.lastLogReceivedAt)
			assert.isNull(connector.lastLogError)
			assert.isNull(connector.appliedLogsEnabled)
			assert.isNull(connector.setupReportedAt)

			const { setupScript } = yield* gcp.scripts(orgId, connector.id, scriptOptions)
			const endpoint = /PUSH_ENDPOINT='([^']+)'/.exec(setupScript)?.[1]
			assert.isDefined(endpoint)
			const url = new URL(endpoint!)
			assert.strictEqual(
				url.origin + url.pathname,
				`https://ingest.test/v1/logpush/gcp/${connector.id}`,
			)
			const secret = url.searchParams.get("secret")!
			assert.match(secret, /^maple_gcp_[A-Za-z0-9_-]{32}$/)

			const row = yield* Effect.promise(() =>
				queryFirstRow<StoredConnector>(testDb, "SELECT * FROM gcp_connectors WHERE id = $1", [
					connector.id,
				]),
			)
			assert.strictEqual(row!.secret_hash, hashIngestKey(secret, LOOKUP_HMAC_KEY))
			assert.notInclude(row!.secret_ciphertext, secret)
			assert.strictEqual(row!.created_by, userId)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("connects a scope once per organization, whatever its host project", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			yield* gcp.create(orgId, userId, organizationScope)
			const duplicate = yield* Effect.flip(
				gcp.create(orgId, userId, { ...organizationScope, projectId: project("another-host") }),
			)
			assert.strictEqual(duplicate._tag, "@maple/http/errors/GcpScopeAlreadyConnectedError")

			// A folder with the same number is a different scope, and so is a project inside it.
			yield* gcp.create(orgId, userId, { ...organizationScope, scopeType: "folder" })
			yield* gcp.create(orgId, userId, projectScope("acme-host"))
			yield* gcp.create(otherOrgId, userId, organizationScope)
			assert.lengthOf((yield* gcp.status(orgId)).connectors, 3)
		}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT)))
	})

	it.effect("requires one capability to stay on and refuses metrics without a Google identity", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			assert.isFalse((yield* gcp.status(orgId)).metricsAvailable)

			const nothing = yield* Effect.flip(
				gcp.create(orgId, userId, projectScope("acme-prod", { logsEnabled: false })),
			)
			assert.strictEqual(nothing._tag, "@maple/http/errors/IntegrationsValidationError")
			const metrics = yield* Effect.flip(
				gcp.create(orgId, userId, projectScope("acme-prod", { metricsEnabled: true })),
			)
			assert.strictEqual(metrics._tag, "@maple/http/errors/GcpMetricsUnavailableError")

			const connector = yield* gcp.create(orgId, userId, projectScope("acme-prod"))
			const turnOn = yield* Effect.flip(gcp.update(orgId, connector.id, { metricsEnabled: true }))
			assert.strictEqual(turnOn._tag, "@maple/http/errors/GcpMetricsUnavailableError")
			const turnOff = yield* Effect.flip(gcp.update(orgId, connector.id, { logsEnabled: false }))
			assert.strictEqual(turnOff._tag, "@maple/http/errors/IntegrationsValidationError")
			// An empty patch changes nothing.
			assert.deepStrictEqual(yield* gcp.update(orgId, connector.id, {}), connector)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("switches capabilities, and the scripts follow the stored flags", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			assert.isTrue((yield* gcp.status(orgId)).metricsAvailable)
			const connector = yield* gcp.create(orgId, userId, organizationScope)
			const both = yield* gcp.scripts(orgId, connector.id, {
				applicationLogs: ["cloud_run", "cloud_functions", "app_engine", "gke"],
			})
			assert.include(both.setupScript, `MAPLE_SERVICE_ACCOUNT='${MAPLE_ACCOUNT}'`)
			assert.notInclude(both.setupScript, "k8s_container")
			assert.include(both.setupScript, '--organization="$SCOPE_ID" --include-children')
			assert.include(both.setupScript, "PROJECT_ID='acme-host'")
			assert.include(both.setupScript, "MAPLE_URL='http://127.0.0.1:3471/integrations?integration=gcp'")
			// Both scripts tell Maple that they ran, so both carry the secret.
			assert.include(both.cleanupScript, "?secret=maple_gcp_")

			const metricsOnly = yield* gcp.update(orgId, connector.id, { logsEnabled: false })
			assert.deepStrictEqual(metricsOnly, { ...connector, logsEnabled: false })
			const afterOptOut = yield* gcp.scripts(orgId, connector.id, scriptOptions)
			assert.notInclude(afterOptOut.setupScript, "LOG_FILTER")
			assert.include(afterOptOut.setupScript, "gcloud logging sinks delete")

			const logsOnly = yield* gcp.update(orgId, connector.id, {
				logsEnabled: true,
				metricsEnabled: false,
			})
			assert.deepStrictEqual(logsOnly, { ...connector, metricsEnabled: false })
			assert.deepStrictEqual((yield* gcp.status(orgId)).connectors, [logsOnly])
		}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT)))
	})

	it.effect("forgets the last push when log forwarding is switched back on", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, organizationScope)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE gcp_connectors SET last_received_at = $1, last_error = $2,
					   applied_logs_enabled = true, setup_reported_at = $1 WHERE id = $3`,
					["2026-10-08T09:12:00.000Z", "payload was not a LogEntry", connector.id],
				),
			)
			// What a setup run reported describes Google Cloud, so no switch changes it.
			const reported = {
				...connector,
				appliedLogsEnabled: true,
				setupReportedAt: Date.parse("2026-10-08T09:12:00.000Z"),
			}
			const lastPush = {
				lastLogReceivedAt: Date.parse("2026-10-08T09:12:00.000Z"),
				lastLogError: "payload was not a LogEntry",
			}

			// Kept while logs stay on, and while they are off.
			const stillOn = yield* gcp.update(orgId, connector.id, { logsEnabled: true })
			assert.deepStrictEqual(stillOn, { ...reported, ...lastPush })
			const off = yield* gcp.update(orgId, connector.id, { logsEnabled: false })
			assert.deepStrictEqual(off, { ...reported, ...lastPush, logsEnabled: false })

			const backOn = yield* gcp.update(orgId, connector.id, { logsEnabled: true })
			assert.deepStrictEqual(backOn, reported)
			assert.deepStrictEqual((yield* gcp.status(orgId)).connectors, [reported])
		}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT)))
	})

	it.effect("reports what the ingest gateway recorded for the last push", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, projectScope("acme-prod"))
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE gcp_connectors SET last_received_at = $1, last_error = $2 WHERE id = $3",
					["2026-10-08T09:12:00.000Z", "payload was not a LogEntry", connector.id],
				),
			)
			assert.deepStrictEqual((yield* gcp.status(orgId)).connectors, [
				{
					...connector,
					lastLogReceivedAt: Date.parse("2026-10-08T09:12:00.000Z"),
					lastLogError: "payload was not a LogEntry",
				},
			])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reports what the poller recorded and how many projects it found", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, organizationScope)
			assert.deepInclude(connector, {
				lastMetricsReceivedAt: null,
				lastMetricsError: null,
				discoveredProjectCount: 0,
				lastResourcesError: null,
			})
			const other = yield* gcp.create(orgId, userId, projectScope("acme-prod"))
			// What the poller writes: its state on the connector, and the scope's inventory.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE gcp_connectors
					 SET metrics_watermark_at = $1, last_metrics_received_at = $1, last_metrics_error = $2,
					     resources_synced_at = $1, last_resources_error = $3
					 WHERE id = $4`,
					[
						"2026-10-08T09:10:00.000Z",
						"2 of 46 metric queries failed.",
						"incomplete",
						connector.id,
					],
				),
			)
			for (const [name, assetType] of [
				[
					"//cloudresourcemanager.googleapis.com/projects/111",
					"cloudresourcemanager.googleapis.com/Project",
				],
				[
					"//cloudresourcemanager.googleapis.com/projects/222",
					"cloudresourcemanager.googleapis.com/Project",
				],
				[
					"//run.googleapis.com/projects/shop/locations/eu/services/api",
					"run.googleapis.com/Service",
				],
			]) {
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`INSERT INTO gcp_resources (connector_id, org_id, name, asset_type, project_id, labels, last_seen_at)
						 VALUES ($1, $2, $3, $4, 'shop', '{}', now())`,
						[connector.id, orgId, name, assetType],
					),
				)
			}
			const polled = {
				...connector,
				lastMetricsReceivedAt: Date.parse("2026-10-08T09:10:00.000Z"),
				lastMetricsError: "2 of 46 metric queries failed.",
				discoveredProjectCount: 2,
				lastResourcesError: "incomplete",
			}
			// Both were created in the same test-clock instant, so their order is by id.
			assert.sameDeepMembers([...(yield* gcp.status(orgId)).connectors], [polled, other])

			// Switching metrics off leaves the poller's state as it is.
			assert.deepStrictEqual(yield* gcp.update(orgId, connector.id, { metricsEnabled: false }), {
				...polled,
				metricsEnabled: false,
			})
			// Back on, the connection waits for its first metrics again; the poller continues
			// from its watermark.
			assert.deepStrictEqual(yield* gcp.update(orgId, connector.id, { metricsEnabled: true }), {
				...polled,
				lastMetricsReceivedAt: null,
				lastMetricsError: null,
			})
			const kept = yield* Effect.promise(() =>
				queryFirstRow<{ metrics_watermark_at: Date | null }>(
					testDb,
					"SELECT metrics_watermark_at FROM gcp_connectors WHERE id = $1",
					[connector.id],
				),
			)
			assert.strictEqual(kept?.metrics_watermark_at?.getTime(), Date.parse("2026-10-08T09:10:00.000Z"))

			// The inventory goes with its connector.
			yield* gcp.delete(orgId, connector.id)
			const left = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(testDb, "SELECT count(*)::int AS count FROM gcp_resources"),
			)
			assert.strictEqual(left?.count, 0)
		}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT)))
	})

	it.effect(
		"lists the organization's inventory once per resource, filtered, with facets over all of it",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const gcp = yield* GcpConnectorService
				const metrics = { metricsEnabled: true }
				const wide = yield* gcp.create(orgId, userId, organizationScope)
				// A project inside the organization: both connectors list its resources.
				const narrow = yield* gcp.create(orgId, userId, projectScope("acme-shop", metrics))
				// Metrics were switched off after a sync: what it listed is stale.
				const stopped = yield* gcp.create(orgId, userId, projectScope("acme-old"))
				const foreign = yield* gcp.create(otherOrgId, userId, projectScope("elsewhere", metrics))

				const PROJECT = "cloudresourcemanager.googleapis.com/Project"
				const RUN = "run.googleapis.com/Service"
				const SQL = "sqladmin.googleapis.com/Instance"
				const api = "//run.googleapis.com/projects/acme-shop/locations/europe-west1/services/api"
				const seen: ReadonlyArray<readonly [{ id: string }, string, string, string, string]> = [
					[wide, orgId, "//cloudresourcemanager.googleapis.com/projects/111", PROJECT, "acme-shop"],
					[wide, orgId, "//cloudresourcemanager.googleapis.com/projects/222", PROJECT, "acme-blog"],
					[wide, orgId, api, RUN, "acme-shop"],
					[
						wide,
						orgId,
						"//sqladmin.googleapis.com/projects/acme-blog/instances/db",
						SQL,
						"acme-blog",
					],
					[
						narrow,
						orgId,
						"//cloudresourcemanager.googleapis.com/projects/111",
						PROJECT,
						"acme-shop",
					],
					[narrow, orgId, api, RUN, "acme-shop"],
					[stopped, orgId, "//run.googleapis.com/projects/acme-old/services/old", RUN, "acme-old"],
					[
						foreign,
						otherOrgId,
						"//run.googleapis.com/projects/elsewhere/services/x",
						RUN,
						"elsewhere",
					],
				]
				for (const [connector, org, name, assetType, projectId] of seen) {
					yield* Effect.promise(() =>
						executeSql(
							testDb,
							`INSERT INTO gcp_resources
						   (connector_id, org_id, name, asset_type, project_id, location, display_name, state, labels, last_seen_at)
						 VALUES ($1, $2, $3, $4, $5, 'europe-west1', 'shown', 'ACTIVE', '{"team":"core"}', now())`,
							[connector.id, org, name, assetType, projectId],
						),
					)
				}

				const all = yield* gcp.resources(orgId, {})
				assert.strictEqual(all.total, 4)
				assert.deepStrictEqual(
					all.resources.map((resource) => resource.name),
					[
						"//cloudresourcemanager.googleapis.com/projects/111",
						"//cloudresourcemanager.googleapis.com/projects/222",
						api,
						"//sqladmin.googleapis.com/projects/acme-blog/instances/db",
					],
				)
				assert.deepStrictEqual(all.types, [
					{ assetType: PROJECT, count: 2 },
					{ assetType: RUN, count: 1 },
					{ assetType: SQL, count: 1 },
				])
				assert.deepStrictEqual(all.projects, ["acme-blog", "acme-shop"])

				const services = yield* gcp.resources(orgId, { assetType: RUN })
				assert.deepStrictEqual(services.resources, [
					{
						name: api,
						assetType: RUN,
						projectId: "acme-shop",
						location: "europe-west1",
						displayName: "shown",
						state: "ACTIVE",
						labels: { team: "core" },
						details: null,
					},
				])
				assert.strictEqual(services.total, 1)

				// A Cloud SQL instance carries the settings the sync read.
				const settings = {
					databaseVersion: "POSTGRES_15",
					edition: "ENTERPRISE",
					tier: "db-custom-4-16384",
					cpus: 4,
					memoryGb: 16,
					availabilityType: "REGIONAL",
					primary: null,
					diskSizeGb: 100,
					queryInsightsEnabled: true,
					maxConnections: 500,
					maxConnectionsSource: "default",
				} as const
				yield* Effect.promise(() =>
					executeSql(testDb, `UPDATE gcp_resources SET details = $1 WHERE asset_type = $2`, [
						JSON.stringify(settings),
						SQL,
					]),
				)
				const [instance] = (yield* gcp.resources(orgId, { assetType: SQL })).resources
				assert.deepStrictEqual(instance?.details, settings)
				// The filter's options do not narrow with it.
				assert.deepStrictEqual(services.types, all.types)
				assert.deepStrictEqual(services.projects, all.projects)

				assert.strictEqual((yield* gcp.resources(orgId, { projectId: "acme-blog" })).total, 2)
				const none = yield* gcp.resources(orgId, { assetType: RUN, projectId: "acme-blog" })
				assert.deepStrictEqual([none.total, none.resources], [0, []])

				// A workload's page asks for its one resource by the last segment of the name.
				const named = yield* gcp.resources(orgId, {
					assetType: RUN,
					projectId: "acme-shop",
					name: "api",
				})
				assert.deepStrictEqual(
					[named.total, named.resources.map((resource) => resource.name)],
					[1, [api]],
				)
				// A segment in the middle of the name is not the resource's name.
				assert.strictEqual((yield* gcp.resources(orgId, { name: "services" })).total, 0)
				assert.strictEqual((yield* gcp.resources(orgId, { name: "ap" })).total, 0)

				const theirs = yield* gcp.resources(otherOrgId, {})
				assert.deepStrictEqual(
					theirs.resources.map((resource) => resource.projectId),
					["elsewhere"],
				)
			}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT)))
		},
	)

	it.effect("refuses to render a secret that was moved onto another connector's row", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const source = yield* gcp.create(orgId, userId, projectScope("acme-prod"))
			const target = yield* gcp.create(orgId, userId, projectScope("acme-staging"))
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE gcp_connectors AS t
					 SET secret_ciphertext = s.secret_ciphertext, secret_iv = s.secret_iv, secret_tag = s.secret_tag
					 FROM gcp_connectors AS s WHERE s.id = $1 AND t.id = $2`,
					[source.id, target.id],
				),
			)
			const error = yield* Effect.flip(gcp.scripts(orgId, target.id, scriptOptions))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsPersistenceError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("renders the setup without a script: signed pushes, the script's filter, no secret", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, organizationScope)
			const scripts = yield* gcp.scripts(orgId, connector.id, { applicationLogs: ["cloud_run"] })
			const names = gcpConnectorResourceNames(connector.id)
			const pushEndpoint = `https://ingest.test/v1/logpush/gcp/${connector.id}`
			assert.strictEqual(scripts.plan.logs?.pushEndpoint, pushEndpoint)
			// The account the ingest gateway accepts this connector's pushes from.
			assert.strictEqual(
				scripts.plan.logs?.pushServiceAccountEmail,
				`${names.pushServiceAccountId}@acme-host.iam.gserviceaccount.com`,
			)
			const scriptFilter = /^LOG_FILTER='(.*)'$/m.exec(scripts.setupScript)?.[1]
			assert.strictEqual(scripts.plan.logs?.logFilter, scriptFilter)
			assert.strictEqual(scripts.plan.reader?.mapleServiceAccountEmail, MAPLE_ACCOUNT)
			assert.match(scripts.terraform, new RegExp(`^  push_endpoint += "${pushEndpoint}"$`, "m"))
			assert.notMatch(scripts.terraform, /maple_gcp_|secret=/)
			// Alchemy can't grant roles on an organization.
			assert.isNull(scripts.alchemy)

			const logsOnly = yield* gcp.update(orgId, connector.id, { metricsEnabled: false })
			const withoutReader = yield* gcp.scripts(orgId, logsOnly.id, scriptOptions)
			assert.isNull(withoutReader.plan.reader)
			assert.notMatch(withoutReader.alchemy ?? "", /maple_gcp_|secret=/)
			assert.include(withoutReader.alchemy ?? "", `const PUSH_ENDPOINT = "${pushEndpoint}"`)
		}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT)))
	})

	it.effect("checks access as the read-only account and records it once Google answers", () => {
		const testDb = createTestDb(trackedDbs)
		const google = fakeGoogle({ signIn: 200, read: 200 })
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, organizationScope)
			assert.deepStrictEqual(yield* gcp.checkAccess(orgId, connector.id), {
				ok: true,
				message: null,
				failedStep: null,
			})
			assert.deepStrictEqual(
				google.reads.map(({ url, quotaProject }) => [url.pathname, quotaProject]),
				[["/v1/organizations/123456789012:searchAllResources", "acme-host"]],
			)
			const [checked] = (yield* gcp.status(orgId)).connectors
			assert.isTrue(checked?.appliedMetricsEnabled)
			assert.isNotNull(checked?.setupReportedAt)
		}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT, { key: encodedKey, fetch: google.fetch })))
	})

	it.effect("says what is missing when Google refuses the read-only account", () => {
		const testDb = createTestDb(trackedDbs)
		// Each Google answer is its own deployment over the same database: layers are built once
		// per provide, and a nested one would share the outer one's.
		const deployment = (answers: { readonly signIn: number; readonly read: number }) =>
			makeLayer(testDb, MAPLE_ACCOUNT, { key: encodedKey, fetch: fakeGoogle(answers).fetch })
		return Effect.gen(function* () {
			const connector = yield* GcpConnectorService.use((gcp) =>
				gcp.create(orgId, userId, organizationScope),
			).pipe(Effect.provide(deployment({ signIn: 200, read: 200 })))
			const reader = `${gcpConnectorResourceNames(connector.id).serviceAccountId}@acme-host.iam.gserviceaccount.com`
			const check = (answers: { readonly signIn: number; readonly read: number }) =>
				GcpConnectorService.use((gcp) => gcp.checkAccess(orgId, connector.id)).pipe(
					Effect.provide(deployment(answers)),
				)

			const signIn = yield* check({ signIn: 403, read: 200 })
			assert.isFalse(signIn.ok)
			assert.include(signIn.message, `Maple can't sign in as ${reader}`)
			assert.strictEqual(signIn.failedStep, "reader_token_creator")

			const read = yield* check({ signIn: 200, read: 403 })
			assert.isFalse(read.ok)
			assert.strictEqual(read.failedStep, "reader_roles")
			assert.include(
				read.message,
				"roles/monitoring.viewer and roles/cloudasset.viewer on the organization",
			)
			// Nothing is recorded for a check that failed.
			const [stored] = yield* GcpConnectorService.use((gcp) => gcp.status(orgId)).pipe(
				Effect.provide(deployment({ signIn: 200, read: 200 })),
				Effect.map((status) => status.connectors),
			)
			assert.isNull(stored?.appliedMetricsEnabled)
		})
	})

	it.effect("confirms a removal: the log sink on the caller's word, the reader once it is gone", () => {
		const testDb = createTestDb(trackedDbs)
		const deployment = (signIn: number) =>
			makeLayer(testDb, MAPLE_ACCOUNT, {
				key: encodedKey,
				fetch: fakeGoogle({ signIn, read: 200 }).fetch,
			})
		const run = <A, E>(signIn: number, use: (gcp: GcpConnectorServiceApi) => Effect.Effect<A, E>) =>
			GcpConnectorService.use(use).pipe(Effect.provide(deployment(signIn)))
		const applied = (id: GcpConnectorId) =>
			run(200, (gcp) => gcp.status(orgId)).pipe(
				Effect.map(({ connectors }) => {
					const found = connectors.find((connector) => connector.id === id)
					return [found?.appliedLogsEnabled, found?.appliedMetricsEnabled]
				}),
			)
		return Effect.gen(function* () {
			const connector = yield* run(200, (gcp) => gcp.create(orgId, userId, organizationScope))
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE gcp_connectors SET applied_logs_enabled = true, applied_metrics_enabled = true WHERE id = $1",
					[connector.id],
				),
			)

			// Log forwarding off: nothing in Google Cloud tells, so the check records it.
			yield* run(200, (gcp) => gcp.update(orgId, connector.id, { logsEnabled: false }))
			const logsOff = yield* run(200, (gcp) => gcp.checkAccess(orgId, connector.id))
			assert.isTrue(logsOff.ok)
			assert.deepStrictEqual(yield* applied(connector.id), [false, true])

			// Metrics off while Maple can still sign in: the account is still there.
			yield* run(200, (gcp) =>
				gcp.update(orgId, connector.id, { logsEnabled: true, metricsEnabled: false }),
			)
			const stillThere = yield* run(200, (gcp) => gcp.checkAccess(orgId, connector.id))
			assert.isFalse(stillThere.ok)
			assert.strictEqual(stillThere.failedStep, "reader_account")
			assert.deepStrictEqual(yield* applied(connector.id), [false, true])

			// Google refuses the sign-in: the account is gone.
			const gone = yield* run(404, (gcp) => gcp.checkAccess(orgId, connector.id))
			assert.isTrue(gone.ok)
			assert.deepStrictEqual(yield* applied(connector.id), [false, false])
		})
	})

	it.effect("refuses the access check without Maple's own key", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, organizationScope)
			const noKey = yield* Effect.flip(gcp.checkAccess(orgId, connector.id))
			assert.strictEqual(noKey._tag, "@maple/http/errors/GcpMetricsUnavailableError")
		}).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT)))
	})

	it.effect("scopes updates, scripts and deletion to the owning organization", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, projectScope("acme-prod"))

			for (const foreign of [
				gcp.update(otherOrgId, connector.id, { logsEnabled: true }),
				gcp.scripts(otherOrgId, connector.id, scriptOptions),
				gcp.delete(otherOrgId, connector.id),
			]) {
				const error = yield* Effect.flip(foreign)
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsNotFoundError")
			}
			const check = yield* Effect.flip(gcp.checkAccess(otherOrgId, connector.id))
			assert.strictEqual(check._tag, "@maple/http/errors/IntegrationsNotFoundError")

			const deleted = yield* gcp.delete(orgId, connector.id)
			assert.deepStrictEqual(deleted.connector, connector)
			assert.include(deleted.cleanupScript, gcpConnectorResourceNames(connector.id).sink)
			assert.notMatch(deleted.cleanupScript, /maple_gcp_[A-Za-z0-9_-]{32}/)
			assert.deepStrictEqual((yield* gcp.status(orgId)).connectors, [])
			const again = yield* Effect.flip(gcp.delete(orgId, connector.id))
			assert.strictEqual(again._tag, "@maple/http/errors/IntegrationsNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
