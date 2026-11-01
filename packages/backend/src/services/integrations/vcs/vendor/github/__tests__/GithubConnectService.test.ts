import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	IntegrationsValidationError,
	PrReviewOrgSettings,
	PrReviewRepositoryConfig,
	type VcsSyncJob,
} from "@maple/domain/http"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { makeRecordingTracer, spansNamed } from "@maple/backend/testing/recording-tracer"
import { GithubAppClient } from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import type { HttpClient } from "effect/http"
import { OAuthStateRepository } from "@maple/backend/services/auth/OAuthStateRepository"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import {
	asOrgId,
	asUserId,
	fakeGithubHttp,
	findError,
	GITHUB_APP_CONFIG,
	jsonResponse,
	markInstStatusFor,
	markRemovedFor,
	recordingQueue,
	repoFor,
	reposOfInstallation,
	scriptedHttp,
	testEnv,
	upsertCommitsFor,
	upsertReposFor,
} from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { decodeGitCommitSha } from "@maple/backend/services/integrations/vcs/__tests__/fixtures"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const installationResponse = (id = 42, login = "octo") =>
	jsonResponse({
		id,
		account: {
			login,
			id: 100,
			type: "Organization",
			avatar_url: "https://avatars.githubusercontent.com/u/100",
		},
		repository_selection: "all",
	})

// completeConnect needs this `code` to connect a new installation.
const TEST_CODE = "test-oauth-code"

// The signed-in Maple user and org finishing the connect, the ones that started it.
const INITIATOR = { orgId: asOrgId("org_test"), userId: asUserId("user_1") }

// The OAuth calls a connect makes, in order: token exchange, then the user's installs.
const oauthTokenResponse = () => jsonResponse({ access_token: "user-token", token_type: "bearer" })
const userInstallationsResponse =
	(ids: ReadonlyArray<number> = [42]) =>
	() =>
		jsonResponse({ total_count: ids.length, installations: ids.map((id) => ({ id })) })

// The user's membership in the installation's org ("octo").
const orgMembershipResponse =
	(role: string = "admin", state: string = "active") =>
	() =>
		jsonResponse({ state, role })

// The 4 calls a successful connect makes: OAuth token, user's installs (incl. 42), the
// installation detail, then the user's org role. `rest` adds any responders after.
const connectResponders = (...rest: Array<() => Response>) => [
	oauthTokenResponse,
	userInstallationsResponse([42]),
	installationResponse,
	orgMembershipResponse(),
	...rest,
]

// Wire GithubConnectService over an in-memory PGlite (real repo + state repo), a
// real GithubAppClient backed by the stubbed HttpClient, and a recording queue.
const connectLayer = (
	testDb: TestDb,
	http: Layer.Layer<HttpClient.HttpClient>,
	sent: Array<VcsSyncJob>,
	decorateRepo?: (repo: VcsRepository["Service"]) => VcsRepository["Service"],
) => {
	const env = testEnv(GITHUB_APP_CONFIG)
	const data = Layer.mergeAll(
		VcsRepository.layer,
		OAuthStateRepository.layer,
		Layer.succeed(VcsSyncQueue, recordingQueue(sent)),
	).pipe(Layer.provide(testDb.layer), Layer.provide(env))
	const githubAppClient = Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
		Layer.provide(http),
		Layer.provide(env),
	)
	const service = Layer.effect(
		GithubConnectService,
		Effect.gen(function* () {
			const repo = yield* VcsRepository
			return yield* GithubConnectService.make.pipe(
				Effect.provideService(VcsRepository, decorateRepo?.(repo) ?? repo),
			)
		}),
	).pipe(Layer.provide(Layer.mergeAll(env, githubAppClient, data, SecureRandom.layerWebCrypto)))
	return Layer.mergeAll(service, data)
}

const startAuthorize = (service: GithubConnectService["Service"]) =>
	service.startConnect(INITIATOR.orgId, INITIATOR.userId, {
		callbackUrl: "https://api.example.com/api/integrations/github/callback",
	})

describe("connecting an existing GitHub installation", () => {
	it.effect(
		"discovers an independently installed app and connects only the explicitly selected account",
		() => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders(installationResponse))
			return Effect.gen(function* () {
				const service = yield* GithubConnectService
				const repo = yield* VcsRepository
				const started = yield* startAuthorize(service)
				const url = new URL(started.redirectUrl)
				assert.strictEqual(url.pathname, "/login/oauth/authorize")
				assert.strictEqual(url.searchParams.get("state"), started.state)
				assert.strictEqual(url.searchParams.get("client_id"), "Iv1.testclientid")
				assert.strictEqual(
					url.searchParams.get("redirect_uri"),
					"https://api.example.com/api/integrations/github/callback",
				)
				const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
				assert.deepStrictEqual(
					selection.installations.map((installation) => [
						installation.id,
						installation.accountLogin,
					]),
					[["42", "octo"]],
				)
				assert.strictEqual((yield* service.getStatus(INITIATOR.orgId)).connected, false)
				assert.strictEqual(sent.length, 0)

				yield* service.selectInstallation("42", selection.state, INITIATOR)
				const installed = Option.getOrThrow(yield* repo.resolveInstallation("github", "42"))
				assert.strictEqual(installed.orgId, INITIATOR.orgId)
				assert.strictEqual(installed.installedByUserId, INITIATOR.userId)
				const connected = yield* service.getStatus(INITIATOR.orgId)
				assert.strictEqual(connected.connected, true)
				assert.strictEqual(connected.repositoryDiscovery?._tag, "Pending")
				assert.isString(connected.repositoryDiscovery?.requestId)
				assert.deepStrictEqual(sent, [
					{
						kind: "installation-sync",
						provider: "github",
						externalInstallationId: "42",
						reason: "created",
						requestId: connected.repositoryDiscovery?.requestId,
					},
				])
				const replay = findError(
					yield* service.selectInstallation("42", selection.state, INITIATOR).pipe(Effect.exit),
				)
				assert.ok(replay instanceof IntegrationsValidationError)
				assert.strictEqual(sent.length, 1)
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		},
	)

	it.effect("offers every administered installation without choosing the first one", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = fakeGithubHttp((request) => {
			const url = new URL(request.url)
			if (url.pathname === "/login/oauth/access_token") return oauthTokenResponse()
			if (url.pathname === "/user/installations") return userInstallationsResponse([42, 43])()
			if (url.pathname === "/app/installations/42") return installationResponse()
			if (url.pathname === "/app/installations/43") return installationResponse(43, "second")
			return orgMembershipResponse()()
		})
		return Effect.gen(function* () {
			const service = yield* GithubConnectService
			const started = yield* startAuthorize(service)
			const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
			assert.deepStrictEqual(
				selection.installations.map((installation) => installation.id),
				["42", "43"],
			)
			assert.strictEqual(sent.length, 0)
			yield* service.selectInstallation("43", selection.state, INITIATOR)
			const repo = yield* VcsRepository
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(
				Option.getOrThrow(yield* repo.resolveInstallation("github", "43")).accountLogin,
				"second",
			)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	for (const role of [
		{ name: "member", response: orgMembershipResponse("member"), needsApproval: [], unavailable: 1 },
		{
			name: "unverifiable",
			response: () => jsonResponse({}, { status: 403 }),
			needsApproval: ["octo"],
			unavailable: 0,
		},
	]) {
		it.effect(`offers nothing to connect when GitHub does not prove account admin (${role.name})`, () => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp([
				oauthTokenResponse,
				userInstallationsResponse(),
				installationResponse,
				role.response,
			])
			return Effect.gen(function* () {
				const service = yield* GithubConnectService
				const started = yield* startAuthorize(service)
				const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
				assert.deepStrictEqual(selection.installations, [])
				assert.deepStrictEqual(selection.needsApproval, role.needsApproval)
				assert.strictEqual(selection.unavailable, role.unavailable)
				assert.ok(
					findError(
						yield* service.selectInstallation("42", selection.state, INITIATOR).pipe(Effect.exit),
					) instanceof IntegrationsValidationError,
				)
				assert.strictEqual((yield* service.getStatus(INITIATOR.orgId)).connected, false)
				assert.strictEqual(sent.length, 0)
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		})
	}

	it.effect("skips an installation GitHub fails to read and still offers the rest", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = fakeGithubHttp((request) => {
			const url = new URL(request.url)
			if (url.pathname === "/login/oauth/access_token") return oauthTokenResponse()
			if (url.pathname === "/user/installations") return userInstallationsResponse([42, 43])()
			if (url.pathname === "/app/installations/42") return jsonResponse({}, { status: 500 })
			if (url.pathname === "/app/installations/43") return installationResponse(43, "second")
			return orgMembershipResponse()()
		})
		return Effect.gen(function* () {
			const service = yield* GithubConnectService
			const started = yield* startAuthorize(service)
			const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
			assert.deepStrictEqual(
				selection.installations.map((installation) => installation.id),
				["43"],
			)
			assert.strictEqual(selection.unavailable, 1)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("an installation another Maple org owns is unavailable, never an approval to chase", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = fakeGithubHttp((request) => {
			const url = new URL(request.url)
			if (url.pathname === "/login/oauth/access_token") return oauthTokenResponse()
			if (url.pathname === "/user/installations") return userInstallationsResponse([42])()
			if (url.pathname === "/app/installations/42") return installationResponse()
			return jsonResponse({}, { status: 403 })
		})
		return Effect.gen(function* () {
			const service = yield* GithubConnectService
			const repo = yield* VcsRepository
			yield* repo.upsertInstallation({
				orgId: asOrgId("other-org"),
				provider: "github",
				externalInstallationId: "42",
				accountLogin: "octo",
				accountType: "organization",
				externalAccountId: "100",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: INITIATOR.userId,
			})
			const started = yield* startAuthorize(service)
			const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
			assert.deepStrictEqual(selection.installations, [])
			assert.deepStrictEqual(selection.needsApproval, [])
			assert.strictEqual(selection.unavailable, 1)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("with no installation, the install URL carries a state the install return redeems", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		let installed: ReadonlyArray<number> = []
		const http = fakeGithubHttp((request) => {
			const url = new URL(request.url)
			if (url.pathname === "/login/oauth/access_token") return oauthTokenResponse()
			if (url.pathname === "/user/installations") return userInstallationsResponse(installed)()
			if (url.pathname === "/app/installations/42") return installationResponse()
			return orgMembershipResponse()()
		})
		return Effect.gen(function* () {
			const service = yield* GithubConnectService
			const started = yield* startAuthorize(service)
			const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
			assert.deepStrictEqual(selection.installations, [])
			assert.strictEqual(selection.unavailable, 0)
			const installUrl = new URL(selection.installUrl)
			assert.strictEqual(installUrl.pathname, "/apps/maple-test-app/installations/new")
			const installState = installUrl.searchParams.get("state") ?? ""
			assert.notStrictEqual(installState, selection.state)
			// The install state belongs to the install return only; discovery refuses it.
			assert.ok(
				findError(
					yield* service
						.discoverInstallations(TEST_CODE, installState, INITIATOR)
						.pipe(Effect.exit),
				) instanceof IntegrationsValidationError,
			)
			installed = [42]
			yield* service.completeConnect("42", installState, TEST_CODE, INITIATOR)
			assert.strictEqual((yield* service.getStatus(INITIATOR.orgId)).connected, true)
			assert.strictEqual(sent.length, 1)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	for (const other of [
		{ ...INITIATOR, userId: asUserId("other-user") },
		{ ...INITIATOR, orgId: asOrgId("other-org") },
	]) {
		it.effect(`selection belongs to its initiating user and org (${other.userId}/${other.orgId})`, () => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders(installationResponse))
			return Effect.gen(function* () {
				const service = yield* GithubConnectService
				const started = yield* startAuthorize(service)
				const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
				const error = findError(
					yield* service.selectInstallation("42", selection.state, other).pipe(Effect.exit),
				)
				assert.ok(error instanceof IntegrationsValidationError)
				assert.strictEqual(sent.length, 0)
				yield* service.selectInstallation("42", selection.state, INITIATOR)
				assert.strictEqual((yield* service.getStatus(INITIATOR.orgId)).connected, true)
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		})
	}

	for (const refusal of ["expired", "unlisted", "install-state"] as const) {
		it.effect(`refuses ${refusal} selection authority without binding`, () => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders())
			return Effect.gen(function* () {
				const service = yield* GithubConnectService
				const started = yield* startAuthorize(service)
				const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
				if (refusal === "expired") yield* TestClock.adjust("11 minutes")
				const attempt =
					refusal === "install-state"
						? service.completeConnect("42", selection.state, undefined, INITIATOR)
						: service.selectInstallation(
								refusal === "unlisted" ? "999" : "42",
								selection.state,
								INITIATOR,
							)
				assert.ok(findError(yield* attempt.pipe(Effect.exit)) instanceof IntegrationsValidationError)
				assert.strictEqual((yield* service.getStatus(INITIATOR.orgId)).connected, false)
				assert.strictEqual(sent.length, 0)
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		})
	}

	it.effect("refuses an installation claimed by another Maple organization after discovery", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const service = yield* GithubConnectService
			const repo = yield* VcsRepository
			const started = yield* startAuthorize(service)
			const selection = yield* service.discoverInstallations(TEST_CODE, started.state, INITIATOR)
			yield* repo.upsertInstallation({
				orgId: asOrgId("other-org"),
				provider: "github",
				externalInstallationId: "42",
				accountLogin: "octo",
				accountType: "organization",
				externalAccountId: "100",
				accountAvatarUrl: null,
				repositorySelection: "all",
				installedByUserId: INITIATOR.userId,
			})
			assert.ok(
				findError(
					yield* service.selectInstallation("42", selection.state, INITIATOR).pipe(Effect.exit),
				) instanceof IntegrationsValidationError,
			)
			assert.strictEqual(
				Option.getOrThrow(yield* repo.resolveInstallation("github", "42")).orgId,
				asOrgId("other-org"),
			)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})
})

describe("GithubConnectService", () => {
	for (const initialStatus of ["active", "disconnected"] as const) {
		it.effect(
			`getStatus keeps an ${initialStatus} installation correlated with its discovery snapshot while the worker completes`,
			() => {
				const testDb = createTestDb(trackedDbs)
				const sent: Array<VcsSyncJob> = []
				let completeDuringRead = false
				const decorateRepo = (repo: VcsRepository["Service"]) => {
					const completeDiscovery = Effect.gen(function* () {
						if (!completeDuringRead) return
						completeDuringRead = false
						const installation = Option.getOrThrow(
							yield* repo.resolveInstallation("github", "42"),
						)
						const job = sent[0]
						assert.ok(
							installation !== undefined &&
								job?.kind === "installation-sync" &&
								job.requestId !== undefined,
						)
						yield* repo.markInstallationStatus(installation.id, "active")
						yield* repo.upsertRepositories(installation, [
							{
								externalRepoId: "7",
								owner: "octo",
								name: "repo",
								fullName: "octo/repo",
								defaultBranch: "main",
								htmlUrl: "https://github.com/octo/repo",
								isPrivate: true,
								isArchived: false,
							},
						])
						yield* repo.finishRepositoryDiscovery(installation.id, {
							_tag: "Complete",
							requestId: job.requestId,
						})
					})
					return {
						...repo,
						listInstallationsByOrg: (...args: Parameters<typeof repo.listInstallationsByOrg>) =>
							repo
								.listInstallationsByOrg(...args)
								.pipe(
									Effect.tap(() =>
										initialStatus === "disconnected" ? completeDiscovery : Effect.void,
									),
								),
						listRepositoriesByInstallation: (
							...args: Parameters<typeof repo.listRepositoriesByInstallation>
						) =>
							repo
								.listRepositoriesByInstallation(...args)
								.pipe(
									Effect.tap(() =>
										initialStatus === "active" ? completeDiscovery : Effect.void,
									),
								),
					}
				}
				return Effect.gen(function* () {
					const service = yield* GithubConnectService
					const repo = yield* VcsRepository
					const start = yield* service.startConnect(INITIATOR.orgId, INITIATOR.userId, {
						callbackUrl: "https://api.example.com/callback",
						mode: "install",
					})
					yield* service.completeConnect("42", start.state, TEST_CODE, INITIATOR)
					const installation = Option.getOrThrow(yield* repo.resolveInstallation("github", "42"))
					yield* repo.markInstallationStatus(installation.id, initialStatus)
					completeDuringRead = true
					const during = yield* service.getStatus(INITIATOR.orgId)
					assert.strictEqual(
						during.state,
						initialStatus === "active" ? "connected" : "disconnected",
					)
					assert.strictEqual(during.repositoryDiscovery?._tag, "Pending")
					if (initialStatus === "active") assert.lengthOf(during.repositories, 0)
					const after = yield* service.getStatus(INITIATOR.orgId)
					assert.strictEqual(after.connected, true)
					assert.strictEqual(after.repositoryDiscovery?._tag, "Complete")
					assert.strictEqual(after.repositories[0]?.fullName, "octo/repo")
				}).pipe(
					Effect.provide(
						connectLayer(testDb, scriptedHttp(connectResponders()), sent, decorateRepo),
					),
				)
			},
		)
	}
	it.effect("startConnect mints a state row and returns the GitHub install URL with state", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const { redirectUrl, state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://api.localhost/api/integrations/github/callback",
				mode: "install",
			})
			assert.ok(state.length > 0)
			assert.ok(redirectUrl.startsWith("https://github.com/apps/maple-test-app/installations/new"))
			assert.ok(redirectUrl.includes(`state=${state}`))
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("completeConnect upserts the installation and enqueues a created sync job", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/api/integrations/github/callback",
				mode: "install",
				returnTo: "https://web.localhost/integrations?integration=github",
			})

			const result = yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
			assert.strictEqual(result.orgId, orgId)
			assert.strictEqual(result.returnTo, "https://web.localhost/integrations?integration=github")

			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(found))
			assert.strictEqual(found.value.orgId, orgId)
			assert.strictEqual(found.value.accountLogin, "octo")
			assert.strictEqual(found.value.accountType, "organization")
			assert.strictEqual(found.value.externalAccountId, "100")
			assert.strictEqual(found.value.repositorySelection, "all")
			assert.strictEqual(found.value.installedByUserId, userId)
			assert.strictEqual(found.value.status, "active")

			assert.strictEqual(sent.length, 1)
			const job = sent[0]!
			assert.strictEqual(job.kind, "installation-sync")
			if (job.kind !== "installation-sync") return
			assert.strictEqual(job.provider, "github")
			assert.strictEqual(job.externalInstallationId, "42")
			assert.strictEqual(job.reason, "created")
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("completeConnect surfaces a 404 installation as a validation error", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(
			connectResponders()
				.slice(0, 2)
				.concat(() => jsonResponse({ message: "Not Found" }, { status: 404 })),
		)
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})

			const exit = yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)

			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isNone(found))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("completeConnect refuses a new binding when no OAuth code is supplied", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})

			// No `code` argument → rejected before any installation row is written.
			const exit = yield* svc.completeConnect("42", state, undefined, INITIATOR).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("completeConnect rejects when the user cannot administer the installation", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		// User administers installation 99, not the requested 42.
		const http = scriptedHttp([oauthTokenResponse, userInstallationsResponse([99]), installationResponse])
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})

			const exit = yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	const adminCases = [
		{
			name: "an org member who is not an admin",
			account: "Organization",
			membership: orgMembershipResponse("member"),
			bound: false,
		},
		{
			name: "a pending org admin invite",
			account: "Organization",
			membership: orgMembershipResponse("admin", "pending"),
			bound: false,
		},
		{
			name: "an org role the App cannot read",
			account: "Organization",
			membership: () =>
				jsonResponse({ message: "Resource not accessible by integration" }, { status: 403 }),
			bound: false,
		},
		{
			name: "an active org admin",
			account: "Organization",
			membership: orgMembershipResponse(),
			bound: true,
		},
		{
			name: "another user's personal account",
			account: "User",
			membership: () => jsonResponse({ id: 7, login: "someone" }),
			bound: false,
		},
		{
			name: "the user's own personal account",
			account: "User",
			membership: () => jsonResponse({ id: 100, login: "octo" }),
			bound: true,
		},
	] as const

	for (const c of adminCases) {
		it.effect(
			`completeConnect with the installation listed for the user and ${c.name}: bound=${c.bound}`,
			() => {
				const testDb = createTestDb(trackedDbs)
				const sent: Array<VcsSyncJob> = []
				const roleUrls: Array<string> = []
				const http = fakeGithubHttp((request) => {
					const path = new URL(request.url).pathname
					if (path.endsWith("/access_token")) return oauthTokenResponse()
					if (path === "/user/installations") return userInstallationsResponse([42])()
					if (path === "/app/installations/42")
						return jsonResponse({
							id: 42,
							account: { login: "octo", id: 100, type: c.account },
							repository_selection: "all",
						})
					roleUrls.push(path)
					return c.membership()
				})
				return Effect.gen(function* () {
					const svc = yield* GithubConnectService
					const repo = yield* VcsRepository
					const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
						callbackUrl: "https://tunnel.example/cb",
						mode: "install",
					})
					const exit = yield* svc
						.completeConnect("42", state, TEST_CODE, INITIATOR)
						.pipe(Effect.exit)
					assert.deepStrictEqual(roleUrls, [
						c.account === "Organization" ? "/user/memberships/orgs/octo" : "/user",
					])
					assert.strictEqual(
						Option.isSome(yield* repo.resolveInstallation("github", "42")),
						c.bound,
					)
					assert.strictEqual(sent.length, c.bound ? 1 : 0)
					if (!c.bound) assert.ok(findError(exit) instanceof IntegrationsValidationError)
				}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
			},
		)
	}

	// The refusal answers 200, so the connect span must say why: alerts count these attributes.
	const refusalCases = [
		{
			name: "a 403 on the org role read is refused as unverifiable, with what to do next",
			membership: () =>
				jsonResponse({ message: "Resource not accessible by integration" }, { status: 403 }),
			outcome: "installation_admin_unverifiable",
			copy: "approve the app's pending permission request",
		},
		{
			name: "a plain org member is refused as not an admin",
			membership: orgMembershipResponse("member"),
			outcome: "installation_not_administrable",
			copy: "Only an admin of this GitHub account",
		},
	] as const

	for (const c of refusalCases) {
		it.effect(`completeConnect: ${c.name}`, () => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp([
				oauthTokenResponse,
				userInstallationsResponse([42]),
				installationResponse,
				c.membership,
			])
			return Effect.gen(function* () {
				const { spans, tracer } = makeRecordingTracer()
				const svc = yield* GithubConnectService
				const repo = yield* VcsRepository
				const { state } = yield* svc.startConnect(INITIATOR.orgId, INITIATOR.userId, {
					callbackUrl: "https://tunnel.example/cb",
					mode: "install",
				})
				const exit = yield* svc
					.completeConnect("42", state, TEST_CODE, INITIATOR)
					.pipe(Effect.withTracer(tracer), Effect.exit)

				const error = findError(exit)
				assert.ok(error instanceof IntegrationsValidationError)
				assert.include(error.message, c.copy)
				assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
				assert.strictEqual(sent.length, 0)
				const [span] = spansNamed(spans, "GithubConnectService.completeConnect")
				assert.isDefined(span)
				assert.strictEqual(span.attributes.get("maple.vcs.connect.refused"), true)
				assert.strictEqual(span.attributes.get("vcs.connect.outcome"), c.outcome)
				assert.deepStrictEqual(
					span.events.map(([name, , attributes]) => [name, attributes["vcs.connect.outcome"]]),
					[["maple.vcs.connect.refused", c.outcome]],
				)
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		})
	}

	it.effect("completeConnect allows a same-org reconnect without an OAuth code", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		// The reconnect only re-reads the installation detail.
		const http = scriptedHttp(connectResponders(installationResponse))
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")

			// First connect (with code) establishes the org-owned installation row.
			const first = yield* svc.startConnect(orgId, asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})
			yield* svc.completeConnect("42", first.state, TEST_CODE, INITIATOR)
			assert.ok(Option.isSome(yield* repo.resolveInstallation("github", "42")))
			const oldDiscovery = (yield* svc.getStatus(orgId)).repositoryDiscovery
			const installation = Option.getOrThrow(yield* repo.resolveInstallation("github", "42"))
			yield* repo.markInstallationStatus(installation.id, "disconnected")

			// Second connect from the SAME org, no code → still allowed (reconnect).
			const second = yield* svc.startConnect(orgId, asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})
			const result = yield* svc.completeConnect("42", second.state, undefined, INITIATOR)
			assert.strictEqual(result.orgId, orgId)
			const found = yield* repo.resolveInstallation("github", "42")
			assert.ok(Option.isSome(found))
			assert.strictEqual(found.value.orgId, orgId)
			const reconnecting = yield* svc.getStatus(orgId)
			assert.strictEqual(reconnecting.connected, false)
			assert.strictEqual(reconnecting.repositoryDiscovery?._tag, "Pending")
			assert.notStrictEqual(reconnecting.repositoryDiscovery?.requestId, oldDiscovery?.requestId)

			// First connect enqueues "created"; the reconnect enqueues "updated".
			const reasons = sent.flatMap((j) => (j.kind === "installation-sync" ? [j.reason] : []))
			assert.deepStrictEqual(reasons, ["created", "updated"])
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("completeConnect refuses a valid state finished by a different Maple user", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})
			// Someone else's browser came back with the initiator's state and their own install.
			const exit = yield* svc
				.completeConnect("42", state, TEST_CODE, {
					orgId: asOrgId("org_other"),
					userId: asUserId("user_2"),
				})
				.pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("completeConnect rejects an unrecognized state without calling GitHub", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const exit = yield* svc
				.completeConnect("42", "not-a-real-state", undefined, INITIATOR)
				.pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	// State TTL is 10 min; it.effect freezes the clock so we advance with TestClock.
	it.effect("completeConnect rejects an expired state and connects nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})

			// Advance past the 10-minute STATE_TTL_MS before the callback returns.
			yield* TestClock.adjust("11 minutes")

			const exit = yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("completeConnect consumes the state — a replay is rejected", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const { state } = yield* svc.startConnect(asOrgId("org_test"), asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})

			// First callback succeeds and enqueues exactly one created sync job.
			yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
			assert.strictEqual(sent.length, 1)

			// Replaying the now-consumed state is rejected; no second job is enqueued.
			const exit = yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.strictEqual(sent.length, 1)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect("disconnect purges the installation with its repos + commits and is idempotent", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			// Connect, then seed repos + commits the way the sync engine would.
			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/api/integrations/github/callback",
				mode: "install",
			})
			yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const SHA = "a".repeat(40)
			yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: SHA,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
					branch: "main",
				},
			])

			const result = yield* svc.disconnect(orgId)
			assert.strictEqual(result.disconnected, true)
			assert.ok(Option.isNone(yield* repo.resolveInstallation("github", "42")))
			assert.strictEqual((yield* reposOfInstallation(repo, "42", "all")).length, 0)
			assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA))))

			// A user-initiated disconnect fully removes the row, so status reverts to the
			// pristine "never connected" state; a second disconnect is a no-op.
			const status = yield* svc.getStatus(orgId)
			assert.strictEqual(status.connected, false)
			assert.strictEqual(status.state, "not_connected")
			const second = yield* svc.disconnect(orgId)
			assert.strictEqual(second.disconnected, false)
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	it.effect(
		"getStatus surfaces a webhook-disconnected installation as deactivated (not deleted), keeping account + repos",
		() => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders())
			return Effect.gen(function* () {
				const svc = yield* GithubConnectService
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_test")
				const userId = asUserId("user_1")

				const { state } = yield* svc.startConnect(orgId, userId, {
					callbackUrl: "https://tunnel.example/api/integrations/github/callback",
					mode: "install",
				})
				yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
				yield* upsertReposFor(repo, "42", [
					{
						externalRepoId: "7",
						owner: "octo",
						name: "repo",
						fullName: "octo/repo",
						defaultBranch: "main",
						htmlUrl: "https://github.com/octo/repo",
						isPrivate: true,
						isArchived: false,
					},
				])

				// Simulate the `installation.deleted` webhook outcome: the row is marked
				// disconnected (soft), never purged.
				yield* markInstStatusFor(repo, "42", "disconnected")

				const status = yield* svc.getStatus(orgId)
				// Not the pristine first-run state: it reports *why* it went quiet, keeps the
				// account label, and still lists the preserved repositories.
				assert.strictEqual(status.connected, false)
				assert.strictEqual(status.state, "disconnected")
				assert.strictEqual(status.accountLogin, "octo")
				assert.strictEqual(status.repositories.length, 1)
				// The installation row is still present — nothing was hard-deleted.
				assert.ok(Option.isSome(yield* repo.resolveInstallation("github", "42")))
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		},
	)

	it.effect(
		"getStatus surfaces a suspended installation as state 'suspended' (distinct from disconnected), keeping account + repos",
		() => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders())
			return Effect.gen(function* () {
				const svc = yield* GithubConnectService
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_test")
				const userId = asUserId("user_1")

				const { state } = yield* svc.startConnect(orgId, userId, {
					callbackUrl: "https://tunnel.example/api/integrations/github/callback",
					mode: "install",
				})
				yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
				yield* upsertReposFor(repo, "42", [
					{
						externalRepoId: "7",
						owner: "octo",
						name: "repo",
						fullName: "octo/repo",
						defaultBranch: "main",
						htmlUrl: "https://github.com/octo/repo",
						isPrivate: true,
						isArchived: false,
					},
				])

				// Simulate the `installation.suspend` webhook outcome: the row is marked
				// suspended (soft), never purged — distinct from disconnected/deleted.
				yield* markInstStatusFor(repo, "42", "suspended")

				const status = yield* svc.getStatus(orgId)
				assert.strictEqual(status.connected, false)
				// The suspended status maps to its own state so the dashboard can tell the
				// user to reactivate (not reinstall), unlike "disconnected".
				assert.strictEqual(status.state, "suspended")
				assert.strictEqual(status.accountLogin, "octo")
				assert.strictEqual(status.repositories.length, 1)
				assert.ok(Option.isSome(yield* repo.resolveInstallation("github", "42")))
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		},
	)

	it.effect(
		"deleteRepository purges only that repo + its commits; getStatus surfaces removed repos",
		() => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders())
			return Effect.gen(function* () {
				const svc = yield* GithubConnectService
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_test")
				const userId = asUserId("user_1")

				const { state } = yield* svc.startConnect(orgId, userId, {
					callbackUrl: "https://tunnel.example/api/integrations/github/callback",
					mode: "install",
				})
				yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)

				// Two repos: "7" (to delete) and "8" (kept), each with a commit.
				yield* upsertReposFor(repo, "42", [
					{
						externalRepoId: "7",
						owner: "octo",
						name: "repo",
						fullName: "octo/repo",
						defaultBranch: "main",
						htmlUrl: "https://github.com/octo/repo",
						isPrivate: true,
						isArchived: false,
					},
					{
						externalRepoId: "8",
						owner: "octo",
						name: "other",
						fullName: "octo/other",
						defaultBranch: "main",
						htmlUrl: "https://github.com/octo/other",
						isPrivate: false,
						isArchived: false,
					},
				])
				const SHA_7 = "a".repeat(40)
				const SHA_8 = "b".repeat(40)
				const seedCommit = (repoId: string, sha: string) =>
					upsertCommitsFor(repo, orgId, repoId, [
						{
							sha,
							message: "m",
							authorName: null,
							authorEmail: null,
							authorLogin: null,
							authorAvatarUrl: null,
							authoredAt: null,
							committedAt: 1,
							htmlUrl: `https://github.com/octo/r/commit/${sha}`,
							branch: "main",
						},
					])
				yield* seedCommit("7", SHA_7)
				yield* seedCommit("8", SHA_8)

				// Resolve repo "7"'s Maple id — the dashboard's delete handle — then mark
				// it removed so it's the provider-removed repo the user deletes.
				const repo7 = yield* repo.resolveRepository(orgId, "github", "7")
				assert.ok(Option.isSome(repo7))
				const repo7Id = repo7.value.id
				yield* markRemovedFor(repo, orgId, "7")
				// getStatus surfaces removed repos (scope "all") by Maple id, with status.
				const before = yield* svc.getStatus(orgId)
				const removed = before.repositories.find((r) => r.id === repo7Id)
				assert.ok(removed)
				assert.strictEqual(removed.status, "removed")

				const result = yield* svc.deleteRepository(orgId, repo7Id)
				assert.strictEqual(result.deleted, true)

				assert.ok(Option.isNone(yield* repo.resolveRepository(orgId, "github", "7")))
				assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA_7))))
				assert.ok(Option.isSome(yield* repo.resolveRepository(orgId, "github", "8")))
				assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA_8))))

				// Deleting the same (now-absent) id again is a no-op (idempotent).
				const again = yield* svc.deleteRepository(orgId, repo7Id)
				assert.strictEqual(again.deleted, false)
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		},
	)

	it.effect("deleteRepository refuses to delete an active repo and leaves its data intact", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		const http = scriptedHttp(connectResponders())
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const orgId = asOrgId("org_test")
			const userId = asUserId("user_1")

			const { state } = yield* svc.startConnect(orgId, userId, {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})
			yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			const SHA = "a".repeat(40)
			yield* upsertCommitsFor(repo, orgId, "7", [
				{
					sha: SHA,
					message: "m",
					authorName: null,
					authorEmail: null,
					authorLogin: null,
					authorAvatarUrl: null,
					authoredAt: null,
					committedAt: 1,
					htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
					branch: "main",
				},
			])

			// The repo is still active → delete is rejected; row + commit untouched.
			const repo7 = yield* repo.resolveRepository(orgId, "github", "7")
			assert.ok(Option.isSome(repo7))
			const exit = yield* svc.deleteRepository(orgId, repo7.value.id).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
			assert.ok(Option.isSome(yield* repo.resolveRepository(orgId, "github", "7")))
			assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA))))
		}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
	})

	const connectedRepo = (svc: GithubConnectService["Service"], repo: VcsRepository["Service"]) =>
		Effect.gen(function* () {
			const orgId = asOrgId("org_test")
			const { state } = yield* svc.startConnect(orgId, asUserId("user_1"), {
				callbackUrl: "https://tunnel.example/cb",
				mode: "install",
			})
			yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
			yield* upsertReposFor(repo, "42", [
				{
					externalRepoId: "7",
					owner: "octo",
					name: "repo",
					fullName: "octo/repo",
					defaultBranch: "main",
					htmlUrl: "https://github.com/octo/repo",
					isPrivate: true,
					isArchived: false,
				},
			])
			return { orgId, repository: yield* repoFor(repo, orgId, "7") }
		})

	it.effect("CI traces are on for a new connection and an admin can turn them off and back on", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { orgId } = yield* connectedRepo(svc, repo)
			assert.strictEqual((yield* svc.getStatus(orgId)).ciTracesEnabled, true)
			assert.strictEqual((yield* svc.setCiTracesEnabled(orgId, false)).enabled, false)
			assert.strictEqual((yield* svc.getStatus(orgId)).ciTracesEnabled, false)
			yield* svc.setCiTracesEnabled(orgId, true)
			assert.strictEqual((yield* svc.getStatus(orgId)).ciTracesEnabled, true)
		}).pipe(Effect.provide(connectLayer(testDb, scriptedHttp(connectResponders()), sent)))
	})

	it.effect("setCiTracesEnabled refuses an organization without a GitHub connection", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const exit = yield* svc.setCiTracesEnabled(asOrgId("org_none"), false).pipe(Effect.exit)
			assert.ok(findError(exit) instanceof IntegrationsValidationError)
		}).pipe(Effect.provide(connectLayer(testDb, scriptedHttp(connectResponders()), sent)))
	})

	it.effect("setPrReviewEnabled turns reviews on for a flagged organization", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { orgId, repository } = yield* connectedRepo(svc, repo)
			assert.strictEqual(repository.prReviewEnabled, false)
			const result = yield* svc.setPrReviewEnabled(orgId, repository.id, true)
			assert.strictEqual(result.enabled, true)
			assert.strictEqual((yield* repoFor(repo, orgId, "7")).prReviewEnabled, true)
		}).pipe(Effect.provide(connectLayer(testDb, scriptedHttp(connectResponders()), sent)))
	})

	it.effect("setPrReviewConfig keeps every setting the form sends", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { orgId, repository } = yield* connectedRepo(svc, repo)
			yield* svc.setPrReviewConfig(
				orgId,
				repository.id,
				new PrReviewRepositoryConfig({
					dailyLimit: 20,
					automaticReviewLimit: 3,
					feedbackScope: "off",
				}),
			)
			const stored = yield* svc.getPrReviewConfig(orgId, repository.id)
			assert.strictEqual(stored.dailyLimit, 20)
			assert.strictEqual(stored.automaticReviewLimit, 3)
			assert.strictEqual(stored.feedbackScope, "off")
		}).pipe(Effect.provide(connectLayer(testDb, scriptedHttp(connectResponders()), sent)))
	})

	it.effect("stores the organization's review model and clears it back to the default", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { orgId } = yield* connectedRepo(svc, repo)
			const actor = asUserId("user_admin")
			assert.strictEqual((yield* svc.getPrReviewSettings(orgId)).model, undefined)
			yield* svc.setPrReviewSettings(
				orgId,
				new PrReviewOrgSettings({ model: "openai/gpt-6-luna" }),
				actor,
			)
			assert.strictEqual((yield* svc.getPrReviewSettings(orgId)).model, "openai/gpt-6-luna")
			yield* svc.setPrReviewSettings(orgId, new PrReviewOrgSettings({}), actor)
			assert.strictEqual((yield* svc.getPrReviewSettings(orgId)).model, undefined)
		}).pipe(Effect.provide(connectLayer(testDb, scriptedHttp(connectResponders()), sent)))
	})

	it.effect("stores organization default rules, cleaned, and merges them under a repository's own", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<VcsSyncJob> = []
		return Effect.gen(function* () {
			const svc = yield* GithubConnectService
			const repo = yield* VcsRepository
			const { orgId, repository } = yield* connectedRepo(svc, repo)
			const actor = asUserId("user_admin")
			const saved = yield* svc.setPrReviewSettings(
				orgId,
				new PrReviewOrgSettings({
					model: "openai/gpt-6-luna",
					defaults: new PrReviewRepositoryConfig({
						instructions: "  Org rule  ",
						ignorePaths: [" dist/ ", "dist/", ""],
						minInlineSeverity: "critical",
					}),
				}),
				actor,
			)
			assert.strictEqual(saved.defaults?.instructions, "Org rule")
			assert.deepStrictEqual(saved.defaults?.ignorePaths, ["dist/"])
			const stored = yield* svc.getPrReviewSettings(orgId)
			assert.strictEqual(stored.model, "openai/gpt-6-luna")
			assert.strictEqual(stored.defaults?.minInlineSeverity, "critical")

			yield* svc.setPrReviewConfig(
				orgId,
				repository.id,
				new PrReviewRepositoryConfig({ instructions: "Repo rule", minInlineSeverity: "info" }),
			)
			const effective = yield* repo.getEffectivePrReviewConfig(orgId, repository.id)
			assert.strictEqual(effective.instructions, "Org rule\n\nRepo rule")
			assert.strictEqual(effective.minInlineSeverity, "info")
			assert.deepStrictEqual(effective.ignorePaths, ["dist/"])
		}).pipe(Effect.provide(connectLayer(testDb, scriptedHttp(connectResponders()), sent)))
	})

	it.effect(
		"setTrackedBranch validates the branch, no-ops on the current one, and wipes+resyncs on change",
		() => {
			const testDb = createTestDb(trackedDbs)
			const sent: Array<VcsSyncJob> = []
			const http = scriptedHttp(connectResponders())
			return Effect.gen(function* () {
				const svc = yield* GithubConnectService
				const repo = yield* VcsRepository
				const orgId = asOrgId("org_test")
				const userId = asUserId("user_1")

				const { state } = yield* svc.startConnect(orgId, userId, {
					callbackUrl: "https://tunnel.example/cb",
					mode: "install",
				})
				yield* svc.completeConnect("42", state, TEST_CODE, INITIATOR)
				yield* upsertReposFor(repo, "42", [
					{
						externalRepoId: "7",
						owner: "octo",
						name: "repo",
						fullName: "octo/repo",
						defaultBranch: "main",
						htmlUrl: "https://github.com/octo/repo",
						isPrivate: true,
						isArchived: false,
					},
				])
				const r = yield* repoFor(repo, orgId, "7")
				// The tracked branch is seeded to the repo's default.
				assert.strictEqual(r.trackedBranch, "main")
				yield* repo.upsertBranches(r, [
					{ name: "main", headSha: null },
					{ name: "release", headSha: null },
				])
				const SHA = "a".repeat(40)
				yield* upsertCommitsFor(repo, orgId, "7", [
					{
						sha: SHA,
						message: "m",
						authorName: null,
						authorEmail: null,
						authorLogin: null,
						authorAvatarUrl: null,
						authoredAt: null,
						committedAt: 1,
						htmlUrl: `https://github.com/octo/repo/commit/${SHA}`,
					},
				])

				// An unknown branch is rejected; nothing changes.
				const bad = yield* svc.setTrackedBranch(orgId, r.id, "nope").pipe(Effect.exit)
				assert.ok(findError(bad) instanceof IntegrationsValidationError)
				assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA))))

				// Selecting the current branch is a no-op: no wipe, no backfill enqueued.
				sent.length = 0
				const noop = yield* svc.setTrackedBranch(orgId, r.id, "main")
				assert.strictEqual(noop.backfillQueued, false)
				assert.ok(Option.isSome(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA))))
				assert.strictEqual(sent.filter((j) => j.kind === "sync-commits").length, 0)

				// Changing the branch wipes commits and enqueues a backfill.
				sent.length = 0
				const changed = yield* svc.setTrackedBranch(orgId, r.id, "release")
				assert.strictEqual(changed.trackedBranch, "release")
				assert.ok(changed.backfillQueued)
				assert.ok(Option.isNone(yield* repo.findCommitBySha(orgId, decodeGitCommitSha(SHA))))
				assert.strictEqual((yield* repoFor(repo, orgId, "7")).trackedBranch, "release")
				const backfills = sent.filter((j) => j.kind === "sync-commits")
				assert.strictEqual(backfills.length, 1)
				assert.strictEqual(
					backfills[0]!.kind === "sync-commits" ? backfills[0]!.branch : "",
					"release",
				)
			}).pipe(Effect.provide(connectLayer(testDb, http, sent)))
		},
	)
})
