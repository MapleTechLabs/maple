/**
 * `@maple` on a pull request over a real PGlite: which mentions are answered, what the reply
 * agent is told, where the answer is posted, and when a fix is committed and when it is not.
 *
 * The provider is a fake at the `VcsProviderRegistry` seam, the Durable Object at the
 * `WorkerEnvironment` seam; each records what it was asked to do.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	GitCommitSha,
	type PullRequestCommentJob,
	type PullRequestHead,
	PrReviewReplyId,
} from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { Effect, Layer, Option, Schema } from "effect"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	asOrgId,
	asUserId,
	testRepoLayer,
	upsertReposFor,
} from "@maple/backend/services/integrations/vcs/__tests__/harness"
import type { VcsProviderClient } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import {
	VcsProviderRegistry,
	type VcsProviderRegistryApi,
} from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { ENABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { PrReviewService } from "./PrReviewService"
import { applyEdits, editablePath, PrReviewConversationService } from "./PrReviewConversationService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const sha = Schema.decodeUnknownSync(GitCommitSha)
const HEAD = sha("1111111111111111111111111111111111111111")
const BASE = sha("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
const orgId = asOrgId("org_reply")

interface Recorded {
	readonly begun: Array<string>
	readonly posted: Array<{ body: string; threadRootId?: string }>
	readonly commits: Array<{
		branch: string
		parentSha: string
		files: ReadonlyArray<{ path: string; content: string }>
	}>
	readonly reactions: Array<string>
}

const record = (): Recorded => ({ begun: [], posted: [], commits: [], reactions: [] })

const head = (overrides: Partial<PullRequestHead> = {}): PullRequestHead => ({
	number: 612,
	title: "Add the orders route",
	url: "https://github.com/octo/repo/pull/612",
	body: null,
	authorLogin: "octocat",
	state: "open",
	draft: false,
	headSha: HEAD,
	headRef: "feat/orders",
	baseSha: BASE,
	baseRef: "main",
	headRepoFullName: "octo/repo",
	...overrides,
})

const layerFor = (
	testDb: TestDb,
	recorded: Recorded,
	options: {
		readonly permission?: string
		readonly pr?: PullRequestHead
		readonly files?: Readonly<Record<string, string>>
	} = {},
) => {
	const unused = () => Effect.die("not used by the conversation service")
	const provider: VcsProviderClient = {
		id: "github",
		webhookToJobs: unused,
		fetchRepositories: unused,
		fetchCommits: unused,
		fetchBranches: unused,
		fetchCommit: unused,
		fetchPullRequests: unused,
		fetchPullRequest: unused,
		fetchPullRequestFiles: unused,
		fetchPullRequestContext: unused,
		fetchReviewThreads: () => Effect.succeed([]),
		resolveReviewThread: unused,
		fetchChangesSince: unused,
		fetchPullRequestHead: () => Effect.succeed(options.pr ?? head()),
		postPullRequestReply: (_installation, _repo, input) =>
			Effect.sync(() => {
				recorded.posted.push({
					body: input.body,
					...(input.threadRootId === undefined ? undefined : { threadRootId: input.threadRootId }),
				})
				return { url: `https://github.com/octo/repo/pull/612#reply-${recorded.posted.length}` }
			}),
		reactToComment: (_installation, _repo, input) =>
			Effect.sync(() => {
				recorded.reactions.push(`${input.commentId}:${input.content}`)
			}),
		fetchCommenterPermission: () => Effect.succeed(options.permission ?? "write"),
		commitFiles: (_installation, _repo, input) =>
			Effect.sync(() => {
				recorded.commits.push({
					branch: input.branch,
					parentSha: input.parentSha,
					files: input.files,
				})
				return { sha: "cccccccccccccccccccccccccccccccccccccccc", htmlUrl: null }
			}),
		publishPullRequestReview: unused,
		searchCode: unused,
		resolveRef: unused,
		fetchCloneCredentials: unused,
		fetchSourceFile: (_installation, _repo, path) =>
			Effect.succeed(
				options.files?.[path] === undefined
					? Option.none()
					: Option.some({
							path,
							sha: "blob",
							htmlUrl: "",
							size: 0,
							content: options.files[path] ?? "",
						}),
			),
	}
	const registry = Layer.succeed(VcsProviderRegistry, {
		ids: ["github"],
		resolve: () => Effect.succeed(provider),
	} satisfies VcsProviderRegistryApi)
	const workerEnv = Layer.succeed(WorkerEnvironment, {
		ChatSession: {
			idFromName: (name: string) => name,
			get: () => ({
				beginTurn: async (input: { text: string }) => {
					recorded.begun.push(input.text)
					return { cursor: 0, messageId: "m" }
				},
				abort: async () => undefined,
			}),
		},
	})
	const base = Layer.mergeAll(
		testRepoLayer(testDb),
		registry,
		testDb.layer,
		workerEnv,
		OrganizationFeatureFlagsService.fixed(ENABLED_ORGANIZATION_FEATURE_FLAGS),
	)
	return Layer.effect(PrReviewConversationService, PrReviewConversationService.make).pipe(
		Layer.provideMerge(Layer.effect(PrReviewService, PrReviewService.make)),
		Layer.provideMerge(base),
	)
}

const seed = Effect.gen(function* () {
	const repo = yield* VcsRepository
	yield* repo.upsertInstallation({
		orgId,
		provider: "github",
		externalInstallationId: "42",
		accountLogin: "octo",
		accountType: "organization",
		externalAccountId: "100",
		accountAvatarUrl: null,
		repositorySelection: "all",
		installedByUserId: asUserId("user_1"),
	})
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
	const stored = Option.getOrThrow(yield* repo.resolveRepository(orgId, "github", "7"))
	yield* repo.setPrReviewEnabled(orgId, stored.id, true)
})

const comment = (overrides: Partial<PullRequestCommentJob> = {}): PullRequestCommentJob => ({
	kind: "pull-request-comment",
	provider: "github",
	externalInstallationId: "42",
	externalRepoId: "7",
	repoFullName: "octo/repo",
	number: 612,
	commentId: "900",
	surface: "conversation",
	authorLogin: "octocat",
	authorAssociation: "MEMBER",
	body: "@maple why does this need a lock?",
	url: "https://github.com/octo/repo/pull/612#issuecomment-900",
	...overrides,
})

describe("editablePath and applyEdits", () => {
	it("refuses paths outside the repository, git internals and CI workflows", () => {
		assert.isDefined(editablePath("../etc/passwd"))
		assert.isDefined(editablePath("/abs.ts"))
		assert.isDefined(editablePath(".github/workflows/ci.yml"))
		assert.isDefined(editablePath(".git/config"))
		assert.isUndefined(editablePath("./src/a.ts"))
	})

	it("replaces text that occurs once, and refuses missing or ambiguous text", () => {
		assert.deepEqual(applyEdits("a b c", [{ oldText: "b", newText: "B" }]), { content: "a B c" })
		assert.deepEqual(applyEdits("x x", [{ oldText: "x", newText: "y" }]), {
			error: "the text to replace occurs more than once; quote more of it",
		})
		assert.property(applyEdits("abc", [{ oldText: "z", newText: "y" }]), "error")
		assert.deepEqual(applyEdits(undefined, [{ oldText: "", newText: "new file" }]), {
			content: "new file",
		})
	})
})

describe("PrReviewConversationService", () => {
	it.effect("answers a member's question on the thread it came from", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded = record()
		return Effect.gen(function* () {
			yield* seed
			const conversations = yield* PrReviewConversationService
			const outcome = yield* conversations.onPullRequestComment(
				orgId,
				comment({ surface: "review_thread", threadRootId: "800", commentId: "901" }),
			)
			assert.equal(outcome.outcome, "started")
			assert.deepEqual(recorded.reactions, ["901:eyes"])
			assert.include(recorded.begun[0]!, "@octocat mentioned you on pull request #612")
			assert.include(recorded.begun[0]!, "> @maple why does this need a lock?")
			yield* conversations.submitReply(
				orgId,
				outcome.replyId!,
				"Because two writers race on the cursor.",
			)
			assert.deepEqual(recorded.posted, [
				{ body: "Because two writers race on the cursor.", threadRootId: "800" },
			])
			// Nothing staged on an ask, and a second submission posts nothing.
			assert.include(
				yield* conversations.stageEdit(orgId, outcome.replyId!, {
					path: "a.ts",
					oldText: "a",
					newText: "b",
				}),
				"only made when someone asks",
			)
			yield* conversations.submitReply(orgId, outcome.replyId!, "again")
			assert.lengthOf(recorded.posted, 1)
			// A redelivery of the same comment is answered once.
			assert.equal(
				(yield* conversations.onPullRequestComment(orgId, comment({ commentId: "901" }))).skipReason,
				"duplicate",
			)
		}).pipe(Effect.provide(layerFor(testDb, recorded)))
	})

	it.effect("ignores people outside the repository and comments on disabled repositories", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded = record()
		return Effect.gen(function* () {
			const conversations = yield* PrReviewConversationService
			assert.equal((yield* conversations.onPullRequestComment(orgId, comment())).skipReason, "disabled")
			yield* seed
			assert.equal(
				(yield* conversations.onPullRequestComment(orgId, comment({ authorAssociation: "NONE" })))
					.skipReason,
				"not_collaborator",
			)
			assert.lengthOf(recorded.begun, 0)
		}).pipe(Effect.provide(layerFor(testDb, recorded)))
	})

	it.effect("commits a fix's staged edits to the pull request's branch, on top of the head it read", () => {
		const testDb = createTestDb(trackedDbs)
		const recorded = record()
		return Effect.gen(function* () {
			yield* seed
			const conversations = yield* PrReviewConversationService
			const outcome = yield* conversations.onPullRequestComment(
				orgId,
				comment({ body: "@maple fix the null check" }),
			)
			assert.equal(outcome.outcome, "started")
			assert.include(recorded.begun[0]!, "They asked you to fix it")
			const replyId = outcome.replyId!
			assert.include(
				yield* conversations.stageEdit(orgId, replyId, {
					path: ".github/workflows/ci.yml",
					oldText: "a",
					newText: "b",
				}),
				"CI workflows are never edited",
			)
			assert.include(
				yield* conversations.stageEdit(orgId, replyId, {
					path: "src/a.ts",
					oldText: "if (x) {",
					newText: "if (x != null) {",
				}),
				"Staged edit 1",
			)
			yield* conversations.submitReply(orgId, replyId, "Guarded the null case.")
			assert.deepEqual(recorded.commits, [
				{
					branch: "feat/orders",
					parentSha: HEAD,
					files: [{ path: "src/a.ts", content: "const a = 1\nif (x != null) {\n}\n" }],
				},
			])
			assert.include(recorded.posted[0]!.body, "Guarded the null case.")
			assert.include(recorded.posted[0]!.body, "Pushed `ccccccc` to `feat/orders`.")
		}).pipe(
			Effect.provide(
				layerFor(testDb, recorded, { files: { "src/a.ts": "const a = 1\nif (x) {\n}\n" } }),
			),
		)
	})

	it.effect("refuses a fix without write access, on a fork, or when the branch moved", () => {
		const recordedA = record()
		const noWrite = Effect.gen(function* () {
			yield* seed
			const conversations = yield* PrReviewConversationService
			const outcome = yield* conversations.onPullRequestComment(
				orgId,
				comment({ body: "@maple fix it" }),
			)
			assert.equal(outcome.outcome, "failed")
			assert.include(recordedA.posted[0]!.body, "write access")
			assert.lengthOf(recordedA.begun, 0)
		}).pipe(Effect.provide(layerFor(createTestDb(trackedDbs), recordedA, { permission: "read" })))

		const recordedB = record()
		const fork = Effect.gen(function* () {
			yield* seed
			const conversations = yield* PrReviewConversationService
			const outcome = yield* conversations.onPullRequestComment(
				orgId,
				comment({ body: "@maple fix it" }),
			)
			assert.equal(outcome.outcome, "failed")
			assert.include(recordedB.posted[0]!.body, "fork")
		}).pipe(
			Effect.provide(
				layerFor(createTestDb(trackedDbs), recordedB, {
					pr: head({ headRepoFullName: "someone/repo" }),
				}),
			),
		)

		const recordedC = record()
		const moved = { current: head() }
		const movedBranch = Effect.gen(function* () {
			yield* seed
			const conversations = yield* PrReviewConversationService
			const outcome = yield* conversations.onPullRequestComment(
				orgId,
				comment({ body: "@maple fix it" }),
			)
			yield* conversations.stageEdit(orgId, outcome.replyId!, {
				path: "src/a.ts",
				oldText: "x",
				newText: "y",
			})
			moved.current = head({ headSha: sha("2222222222222222222222222222222222222222") })
			yield* conversations.submitReply(orgId, outcome.replyId!, "Done.")
			assert.lengthOf(recordedC.commits, 0)
			assert.include(recordedC.posted[0]!.body, "the branch moved")
		}).pipe(
			Effect.provide(
				Layer.suspend(() =>
					layerFor(createTestDb(trackedDbs), recordedC, {
						files: { "src/a.ts": "x" },
						get pr() {
							return moved.current
						},
					}),
				),
			),
		)
		return noWrite.pipe(Effect.andThen(fork), Effect.andThen(movedBranch))
	})

	it("decodes reply ids as UUIDs", () => {
		assert.isTrue(Schema.is(PrReviewReplyId)("00000000-0000-4000-8000-000000000000"))
	})
})
