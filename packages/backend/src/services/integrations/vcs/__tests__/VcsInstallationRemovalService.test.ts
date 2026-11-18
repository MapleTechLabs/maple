import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Array as Arr, String as Str } from "effect"
import type { OrgId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { VcsInstallationRemovalService } from "@maple/backend/services/integrations/vcs/VcsInstallationRemovalService"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import {
	asOrgId,
	asUserId,
	fakeGithubHttp,
	GITHUB_APP_CONFIG,
	registryOverHttp,
	testRepoLayer,
} from "./harness"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = asOrgId("org_leaving")
const OTHER_ORG = asOrgId("org_staying")

/** A GitHub that answers each installation DELETE as `uninstall` says, recording the ids asked for. */
const github = (deleted: Array<string>, uninstall: (installationId: string) => Response) =>
	fakeGithubHttp(({ url, method }) => {
		const path = new URL(url).pathname
		if (method !== "DELETE") return Response.json([])
		const installationId = Str.replace("/app/installations/", "")(path)
		deleted.push(installationId)
		return uninstall(installationId)
	})

/** The real provider and App client over the fake GitHub, and the real rows. */
const removalOver = (testDb: TestDb, http: ReturnType<typeof fakeGithubHttp>) => {
	// The same App config the registry's Env carries: the two share one memoized Env layer.
	const repo = testRepoLayer(testDb, GITHUB_APP_CONFIG)
	return Layer.effect(VcsInstallationRemovalService, VcsInstallationRemovalService.make).pipe(
		Layer.provide(registryOverHttp(http)),
		Layer.provideMerge(repo),
	)
}

const install = (orgId: OrgId, externalInstallationId: string) =>
	VcsRepository.use((repo) =>
		repo.upsertInstallation({
			orgId,
			provider: "github",
			externalInstallationId,
			accountLogin: `octo-${externalInstallationId}`,
			accountType: "organization",
			externalAccountId: `1${externalInstallationId}`,
			accountAvatarUrl: null,
			repositorySelection: "all",
			installedByUserId: asUserId("user_1"),
		}),
	)

const installationsOf = (orgId: OrgId) =>
	VcsRepository.use((repo) => repo.listInstallationsByOrg(orgId)).pipe(
		Effect.map((rows) => Arr.map(rows, (row) => row.externalInstallationId)),
	)

describe("VcsInstallationRemovalService.uninstallForDeletedOrganization", () => {
	it.effect("uninstalls the App from the deleted org's accounts and no one else's", () => {
		const testDb = createTestDb(trackedDbs)
		const deleted: Array<string> = []
		return Effect.gen(function* () {
			yield* install(ORG, "41")
			yield* install(ORG, "42")
			yield* install(OTHER_ORG, "77")
			const removal = yield* VcsInstallationRemovalService

			const result = yield* removal.uninstallForDeletedOrganization(ORG)

			assert.deepStrictEqual(result, { uninstalled: 2 })
			assert.sameMembers(deleted, ["41", "42"])
		}).pipe(
			Effect.provide(
				removalOver(
					testDb,
					github(deleted, () => new Response(null, { status: 204 })),
				),
			),
		)
	})

	it.effect("tries every installation when GitHub refuses one, and reports the refusal", () => {
		const testDb = createTestDb(trackedDbs)
		const deleted: Array<string> = []
		const refuse41 = (installationId: string) =>
			installationId === "41"
				? new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 })
				: new Response(null, { status: 204 })
		return Effect.gen(function* () {
			yield* install(ORG, "41")
			yield* install(ORG, "42")
			const removal = yield* VcsInstallationRemovalService

			const failure = yield* removal.uninstallForDeletedOrganization(ORG).pipe(Effect.flip)

			assert.strictEqual(failure._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.sameMembers(deleted, ["41", "42"])
			// The rows are the org purge's to remove, not this call's.
			assert.sameMembers(yield* installationsOf(ORG), ["41", "42"])
		}).pipe(Effect.provide(removalOver(testDb, github(deleted, refuse41))))
	})

	it.effect("counts an installation GitHub no longer has as uninstalled", () => {
		const testDb = createTestDb(trackedDbs)
		const deleted: Array<string> = []
		const gone = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
		return Effect.gen(function* () {
			yield* install(ORG, "41")
			const removal = yield* VcsInstallationRemovalService
			assert.deepStrictEqual(yield* removal.uninstallForDeletedOrganization(ORG), { uninstalled: 1 })
		}).pipe(Effect.provide(removalOver(testDb, github(deleted, gone))))
	})
})
