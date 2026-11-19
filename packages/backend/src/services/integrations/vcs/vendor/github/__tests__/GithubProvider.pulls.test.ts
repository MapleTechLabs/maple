import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import {
	ConfigProvider,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Schema,
	Stream,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { TestClock } from "effect/testing"
import { GitCommitSha, type PullRequestReviewPublication, VcsInstallation } from "@maple/domain/http"
import { EnvTestLive } from "@maple/backend/testing/env-test-support"
import { GithubAppClient } from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import { fakeGithubHttp } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { GithubProvider } from "@maple/backend/services/integrations/vcs/vendor/github/GithubProvider"

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const envWith = (extra: Record<string, string> = {}) =>
	EnvTestLive.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					...extra,
					PORT: "3482",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					GITHUB_APP_ID: "123456",
					GITHUB_APP_PRIVATE_KEY: privateKey,
				}),
			),
		),
	)
const env = envWith()

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const tokenResponse = () => jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" })

const INSTALLATION = Schema.decodeSync(VcsInstallation)({
	id: "00000000-0000-4000-8000-000000000042",
	orgId: "org_test",
	provider: "github",
	externalInstallationId: "42",
	accountLogin: "octo",
	accountType: "organization",
	externalAccountId: "1",
	accountAvatarUrl: null,
	repositorySelection: "all",
	status: "active",
	suspendedAt: null,
	ciTracesEnabled: true,
	auditLogEnabled: true,
	repositoryDiscovery: null,
	installedByUserId: "user_1",
	createdAt: 0,
	updatedAt: 0,
})
const REPO = { externalRepoId: "1", owner: "octo", name: "shop" }

const apiPullRequest = (overrides: Record<string, unknown> = {}) => ({
	number: 612,
	title: "Guard the null customer id",
	html_url: "https://github.com/octo/shop/pull/612",
	state: "open",
	draft: false,
	updated_at: "2026-08-20T10:00:00Z",
	merged_at: null,
	merge_commit_sha: null,
	user: { login: "octocat", avatar_url: "https://avatars.example/octocat" },
	head: { ref: "fix/null-customer" },
	base: { ref: "main" },
	...overrides,
})

const providerLayer = (
	responses: ReadonlyArray<Response>,
	requests: Array<string> = [],
	bodies: Array<string> = [],
	authorizations: Array<string | undefined> = [],
	appEnv = env,
) => {
	let next = 0
	const http = fakeGithubHttp(({ url, body, headers }) => {
		requests.push(url)
		bodies.push(body ?? "")
		authorizations.push(headers["authorization"])
		return responses[next++]
	})
	return Layer.effect(GithubProvider, GithubProvider.make).pipe(
		Layer.provide(
			Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
				Layer.provide(http),
				Layer.provide(appEnv),
			),
		),
		Layer.provide(appEnv),
	)
}

describe("GithubProvider pull requests", () => {
	it.effect("lists one page, newest-updated first, and normalizes each state", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				jsonResponse([
					apiPullRequest(),
					// Merged: GitHub reports `state: "closed"` and only `merged_at`
					// separates it from a PR closed without merging.
					apiPullRequest({
						number: 611,
						state: "closed",
						merged_at: "2026-08-19T09:00:00Z",
						merge_commit_sha: Str.repeat(40)("a"),
					}),
					apiPullRequest({ number: 610, state: "closed", draft: true, user: null }),
				]),
			],
			requests,
		)

		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const prs = yield* provider.fetchPullRequests(INSTALLATION, REPO, { limit: 50 })

			assert.deepStrictEqual(
				Arr.map(prs, (pr) => [pr.number, pr.state]),
				[
					[612, "open"],
					[611, "merged"],
					[610, "closed"],
				],
			)
			assert.strictEqual(prs[1]?.mergedAtMs, Date.parse("2026-08-19T09:00:00Z"))
			assert.strictEqual(prs[1]?.mergeCommitSha, Str.repeat(40)("a"))
			assert.strictEqual(prs[0]?.authorLogin, "octocat")
			assert.strictEqual(prs[2]?.authorLogin, null, "a ghosted author is not a failure")
			assert.strictEqual(prs[2]?.isDraft, true)
			assert.strictEqual(prs[0]?.headRef, "fix/null-customer")

			const listUrl = requests[1]
			assert.match(listUrl, /\/repos\/octo\/shop\/pulls\?/)
			assert.match(listUrl, /state=all/)
			assert.match(listUrl, /sort=updated/)
			assert.match(listUrl, /direction=desc/)
			// One page only — a picker must not spend an installation's rate budget
			// walking a repository's whole pull-request history.
			assert.strictEqual(requests.length, 2)
		}).pipe(Effect.provide(layer))
	})

	it.effect("caps the requested page at one provider page", () =>
		Effect.gen(function* () {
			const requests: Array<string> = []
			const layer = providerLayer([tokenResponse(), jsonResponse([])], requests)
			yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				yield* provider.fetchPullRequests(INSTALLATION, REPO, { limit: 5_000 })
				assert.match(requests[1], /per_page=100/)
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("fetches one pull request by number", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[tokenResponse(), jsonResponse(apiPullRequest({ state: "closed", merged_at: null }))],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const pr = yield* provider.fetchPullRequest(INSTALLATION, REPO, 612)
			assert.isTrue(Option.isSome(pr))
			assert.strictEqual(Option.getOrThrow(pr).state, "closed")
			assert.match(requests[1], /\/repos\/octo\/shop\/pulls\/612$/)
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers none for a pull request number that does not exist", () =>
		// Someone mistyped, or pasted a URL for another repository. Routine, not a
		// provider failure — the caller keeps going with an unenriched link.
		Effect.gen(function* () {
			const layer = providerLayer([tokenResponse(), jsonResponse({ message: "Not Found" }, 404)])
			yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				const pr = yield* provider.fetchPullRequest(INSTALLATION, REPO, 99_999)
				assert.isTrue(Option.isNone(pr))
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("GithubProvider commits", () => {
	const sha = Schema.decodeSync(GitCommitSha)(Str.repeat(40)("b"))

	it.effect("answers none for a SHA GitHub has never seen", () =>
		// GitHub's 422 for a well-formed SHA that names nothing: a deploy reported
		// an unpushed or rewritten commit. Same "look elsewhere" as a 404, not an
		// integration failure to surface.
		Effect.gen(function* () {
			const layer = providerLayer([
				tokenResponse(),
				jsonResponse({ message: `No commit found for SHA: ${sha}` }, 422),
			])
			yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				const commit = yield* provider.fetchCommit(INSTALLATION, REPO, sha)
				assert.isTrue(Option.isNone(commit))
			}).pipe(Effect.provide(layer))
		}),
	)

	it.effect("still fails on a GitHub error that is not about the SHA", () =>
		Effect.gen(function* () {
			const layer = providerLayer([tokenResponse(), jsonResponse({ message: "Bad credentials" }, 401)])
			yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				const exit = yield* Effect.exit(provider.fetchCommit(INSTALLATION, REPO, sha))
				assert.isTrue(Exit.isFailure(exit))
			}).pipe(Effect.provide(layer))
		}),
	)
})

describe("GithubProvider publishing a review", () => {
	const HEAD = Schema.decodeSync(GitCommitSha)(Str.repeat(40)("c"))
	const MARKER = "<!-- maple-pr-review -->"
	const publication = (
		comments: PullRequestReviewPublication["comments"] = [],
	): PullRequestReviewPublication => ({
		number: 612,
		headSha: HEAD,
		checkName: "Maple / observability",
		title: "100/100 · Observability looks complete",
		summary: "summary",
		conclusion: "success",
		annotations: [],
		summaryComment: { marker: MARKER, body: `${MARKER}\n## Maple observability review: 100/100` },
		reviewBody: comments.length === 0 ? null : "notes",
		comments,
	})
	const noRunningCheck = () => jsonResponse({ check_runs: [] })
	const checkRun = () =>
		jsonResponse({ id: 1, status: "completed", html_url: "https://github.com/octo/shop/runs/1" }, 201)
	const files = (patches: Record<string, string | undefined>) =>
		jsonResponse(
			Arr.map(Rec.toEntries(patches), ([filename, patch]) => ({
				filename,
				status: "modified",
				additions: 1,
				deletions: 1,
				...(patch === undefined ? undefined : { patch }),
			})),
		)
	const written = (id: number) =>
		jsonResponse({ id, html_url: `https://github.com/octo/shop/pull/612#issuecomment-${id}` }, 201)

	it.effect("writes the summary comment even when there is nothing to say inline", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[tokenResponse(), noRunningCheck(), checkRun(), jsonResponse([]), written(5)],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, publication())
			assert.equal(published.commentUrl, "https://github.com/octo/shop/pull/612#issuecomment-5")
			assert.isNull(published.reviewUrl)
			assert.isTrue(
				Option.exists(Arr.last(requests), Str.endsWith("/repos/octo/shop/issues/612/comments")),
			)
			// No review at all: the comment carries the result.
			assert.isFalse(Arr.some(requests, (url) => Str.includes("/reviews")(url)))
		}).pipe(Effect.provide(layer))
	})

	it.effect("opens the check run as running, then completes that same run with the result", () => {
		const requests: Array<string> = []
		const bodies: Array<string> = []
		const running = { id: 7, status: "in_progress", html_url: "https://github.com/octo/shop/runs/7" }
		const layer = providerLayer(
			[
				tokenResponse(),
				noRunningCheck(),
				jsonResponse(running, 201),
				jsonResponse({ check_runs: [running] }),
				jsonResponse({ ...running, status: "completed" }),
				jsonResponse([]),
				written(5),
			],
			requests,
			bodies,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const started = yield* provider.writePullRequestCheck(INSTALLATION, REPO, {
				name: "Maple / observability",
				headSha: "abc123",
				state: { status: "in_progress" },
				title: "Reviewing",
				summary: "Maple is reviewing `abc123`.",
			})
			assert.equal(started.url, "https://github.com/octo/shop/runs/7")
			assert.include(requests[1], "/commits/abc123/check-runs?check_name=Maple%20%2F%20observability")
			assert.isTrue(Str.endsWith("/repos/octo/shop/check-runs")(requests[2]))
			assert.include(bodies[2], `"status":"in_progress"`)
			assert.notInclude(bodies[2], "conclusion")

			const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, publication())
			assert.equal(published.checkRunUrl, "https://github.com/octo/shop/runs/7")
			// The running one is moved on, not duplicated.
			assert.isTrue(Str.endsWith("/repos/octo/shop/check-runs/7")(requests[4]))
			assert.include(bodies[4], `"conclusion":"success"`)
			assert.notInclude(bodies[4], "head_sha")
		}).pipe(Effect.provide(layer))
	})

	it.effect("still posts the comment when the installation cannot write check runs", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				jsonResponse({ message: "Resource not accessible by integration" }, 403),
				jsonResponse([]),
				written(6),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, publication())
			assert.isNull(published.checkRunUrl)
			assert.equal(published.commentUrl, "https://github.com/octo/shop/pull/612#issuecomment-6")
		}).pipe(Effect.provide(layer))
	})

	it.effect("does not mistake a rate-limited 403 for a missing permission", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
					status: 403,
					headers: { "content-type": "application/json", "retry-after": "3600" },
				}),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const exit = yield* Effect.exit(
				provider.publishPullRequestReview(INSTALLATION, REPO, publication()),
			)
			assert.isTrue(Exit.isFailure(exit))
			// Nothing after the check run: a rate limit fails the publish so it is retried whole.
			assert.isFalse(Arr.some(requests, (url) => Str.includes("/comments")(url)))
		}).pipe(Effect.provide(layer))
	})

	it.effect("edits its own comment in place on a later push", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				noRunningCheck(),
				checkRun(),
				jsonResponse([
					{ id: 3, html_url: "x", body: "looks good to me", performed_via_github_app: null },
					{
						id: 77,
						html_url: "y",
						body: `${MARKER}\nold`,
						performed_via_github_app: { id: 123456 },
					},
				]),
				written(77),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, publication())
			assert.equal(published.commentUrl, "https://github.com/octo/shop/pull/612#issuecomment-77")
			assert.isTrue(
				Option.exists(Arr.last(requests), Str.endsWith("/repos/octo/shop/issues/comments/77")),
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("leaves a person's comment that quotes the marker alone", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				noRunningCheck(),
				checkRun(),
				jsonResponse([
					{
						id: 9,
						html_url: "z",
						body: `why does it say ${MARKER}?`,
						performed_via_github_app: null,
					},
				]),
				written(10),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			yield* provider.publishPullRequestReview(INSTALLATION, REPO, publication())
			assert.isTrue(
				Option.exists(Arr.last(requests), Str.endsWith("/repos/octo/shop/issues/612/comments")),
			)
			assert.isFalse(Arr.some(requests, (url) => Str.includes("/issues/comments/9")(url)))
		}).pipe(Effect.provide(layer))
	})

	it.effect("drops the inline notes when GitHub refuses a line, keeping the comment", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				noRunningCheck(),
				checkRun(),
				jsonResponse([]),
				written(5),
				files({ "a.ts": "@@ -999,1 +999,1 @@\n-old\n+new" }),
				jsonResponse({ message: "Line could not be resolved" }, 422),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const published = yield* provider.publishPullRequestReview(
				INSTALLATION,
				REPO,
				publication([{ path: "a.ts", line: 999, body: "add a span" }]),
			)
			assert.equal(published.commentUrl, "https://github.com/octo/shop/pull/612#issuecomment-5")
			assert.isNull(published.reviewUrl)
			// One review attempt only: an empty re-post would be noise under the summary comment.
			assert.equal(Arr.filter(requests, (url) => Str.endsWith("/pulls/612/reviews")(url)).length, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("posts the inline notes as a review after the comment", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				noRunningCheck(),
				checkRun(),
				jsonResponse([]),
				written(5),
				files({ "a.ts": "@@ -1,2 +1,3 @@\n one\n+two\n three" }),
				jsonResponse({
					id: 8,
					html_url: "https://github.com/octo/shop/pull/612#pullrequestreview-8",
				}),
				jsonResponse([{ id: 81, path: "a.ts", line: 3 }]),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const published = yield* provider.publishPullRequestReview(
				INSTALLATION,
				REPO,
				publication([{ path: "a.ts", line: 3, body: "add a span", key: "finding-1" }]),
			)
			assert.equal(published.reviewUrl, "https://github.com/octo/shop/pull/612#pullrequestreview-8")
			assert.isTrue(
				Option.exists(
					Arr.get(requests, requests.length - 2),
					Str.endsWith("/repos/octo/shop/pulls/612/reviews"),
				),
			)
			// The posted comment's id comes back under the key it was submitted with.
			assert.deepEqual(published.inlineComments, [{ key: "finding-1", commentId: "81" }])
		}).pipe(Effect.provide(layer))
	})
	it.effect("drops only the comments outside the diff and says so in the review", () => {
		const requests: Array<string> = []
		const bodies: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				noRunningCheck(),
				checkRun(),
				jsonResponse([]),
				written(5),
				files({ "a.ts": "@@ -1,2 +1,3 @@\n one\n+two\n three", "logo.png": undefined }),
				jsonResponse({
					id: 8,
					html_url: "https://github.com/octo/shop/pull/612#pullrequestreview-8",
				}),
				jsonResponse([{ id: 81, path: "a.ts", line: 2 }]),
			],
			requests,
			bodies,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const published = yield* provider.publishPullRequestReview(
				INSTALLATION,
				REPO,
				publication([
					{ path: "a.ts", line: 40, body: "outside", key: "finding-0" },
					{ path: "a.ts", line: 2, body: "inside", key: "finding-1" },
					{ path: "logo.png", line: 1, body: "binary", key: "finding-2" },
				]),
			)
			assert.deepEqual(published.inlineComments, [{ key: "finding-1", commentId: "81" }])
			const review = JSON.parse(bodies.at(-2) ?? "{}")
			assert.lengthOf(review.comments, 1)
			assert.include(review.body, "2 findings sit outside this diff")
		}).pipe(Effect.provide(layer))
	})

	describe("with an approval", () => {
		const appEnv = envWith({ GITHUB_APP_SLUG: "maple-review" })
		const posted = () => [tokenResponse(), noRunningCheck(), checkRun(), jsonResponse([]), written(5)]
		const pull = (overrides: Record<string, unknown> = {}) =>
			jsonResponse({
				number: 612,
				title: "Rename a label",
				html_url: "https://github.com/octo/shop/pull/612",
				user: { login: "octocat" },
				state: "open",
				draft: false,
				head: { sha: HEAD, ref: "chore/label", repo: { full_name: "octo/shop" } },
				base: { sha: Str.repeat(40)("b"), ref: "main", repo: { default_branch: "main" } },
				...overrides,
			})
		// The base the fixture pull request reports, which is the one the review read.
		const BASE = Schema.decodeSync(GitCommitSha)(Str.repeat(40)("b"))
		const approve = (baseSha: GitCommitSha | undefined = BASE): PullRequestReviewPublication => ({
			...publication(),
			approval: {
				action: "approve",
				body: "Approved by Maple's review.",
				...(baseSha === undefined ? undefined : { baseSha }),
			},
		})

		it.effect(
			"does not approve once the base is another commit than the review read, or was never recorded",
			() =>
				Effect.forEach(
					[Schema.decodeSync(GitCommitSha)(Str.repeat(40)("d")), null],
					(readBase) => {
						const requests: Array<string> = []
						const bodies: Array<string> = []
						return Effect.gen(function* () {
							const provider = yield* GithubProvider
							const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, {
								...publication(),
								approval: {
									action: "approve",
									body: "Approved by Maple's review.",
									...(readBase === null ? undefined : { baseSha: readBase }),
								},
							})
							assert.equal(published.approval, "base_moved")
							assert.isFalse(Arr.some(bodies, Str.includes("APPROVE")))
						}).pipe(
							Effect.provide(
								providerLayer([...posted(), pull()], requests, bodies, [], appEnv),
							),
						)
					},
					{ discard: true },
				),
		)

		it.effect("approves the reviewed head for an author who can push", () => {
			const requests: Array<string> = []
			const bodies: Array<string> = []
			const layer = providerLayer(
				[
					...posted(),
					pull(),
					jsonResponse({ permission: "write" }),
					jsonResponse([]),
					jsonResponse({
						id: 9,
						html_url: "https://github.com/octo/shop/pull/612#pullrequestreview-9",
					}),
				],
				requests,
				bodies,
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, approve())
				assert.equal(published.approval, "approved")
				assert.isTrue(
					Option.exists(Arr.last(requests), Str.endsWith("/repos/octo/shop/pulls/612/reviews")),
				)
				const review = JSON.parse(Arr.lastNonEmpty(bodies as [string, ...Array<string>]))
				assert.equal(review.event, "APPROVE")
				assert.equal(review.commit_id, HEAD)
				assert.deepEqual(review.comments, [])
			}).pipe(Effect.provide(layer))
		})

		it.effect("does not approve an author without push access", () => {
			const requests: Array<string> = []
			const layer = providerLayer(
				[...posted(), pull(), jsonResponse({ permission: "read" })],
				requests,
				[],
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, approve())
				assert.equal(published.approval, "untrusted_author")
				assert.isFalse(Arr.some(requests, Str.endsWith("/reviews")))
			}).pipe(Effect.provide(layer))
		})

		it.effect(
			"does not approve a head pushed past the one reviewed, a draft or a closed pull request",
			() =>
				Effect.forEach(
					[
						[{ head: { sha: Str.repeat(40)("d"), ref: "x", repo: null } }, "head_moved"],
						[{ draft: true }, "draft"],
						[{ state: "closed" }, "not_open"],
					] as const,
					([overrides, outcome]) => {
						const requests: Array<string> = []
						return Effect.gen(function* () {
							const provider = yield* GithubProvider
							const published = yield* provider.publishPullRequestReview(
								INSTALLATION,
								REPO,
								approve(),
							)
							assert.equal(published.approval, outcome)
							assert.isFalse(Arr.some(requests, Str.includes("/permission")))
							assert.isFalse(Arr.some(requests, Str.endsWith("/reviews")))
						}).pipe(
							Effect.provide(
								providerLayer([...posted(), pull(overrides)], requests, [], [], appEnv),
							),
						)
					},
					{ discard: true },
				),
		)

		it.effect(
			"does not approve a pull request into another branch, or one whose default branch is unknown",
			() =>
				Effect.forEach(
					[
						{
							base: {
								sha: Str.repeat(40)("b"),
								ref: "release",
								repo: { default_branch: "main" },
							},
						},
						{ base: { sha: Str.repeat(40)("b"), ref: "main" } },
					],
					(overrides) => {
						const requests: Array<string> = []
						return Effect.gen(function* () {
							const provider = yield* GithubProvider
							const published = yield* provider.publishPullRequestReview(
								INSTALLATION,
								REPO,
								approve(),
							)
							assert.equal(published.approval, "base_not_default")
							assert.isFalse(Arr.some(requests, Str.includes("/permission")))
							assert.isFalse(Arr.some(requests, Str.endsWith("/reviews")))
						}).pipe(
							Effect.provide(
								providerLayer([...posted(), pull(overrides)], requests, [], [], appEnv),
							),
						)
					},
					{ discard: true },
				),
		)

		it.effect("does not approve where it could not list every review to withdraw later", () => {
			const requests: Array<string> = []
			const bodies: Array<string> = []
			const fullPage = () =>
				jsonResponse(
					Arr.makeBy(100, (i) => ({ id: i, state: "COMMENTED", user: { login: "octocat" } })),
				)
			const layer = providerLayer(
				[...posted(), pull(), jsonResponse({ permission: "write" }), ...Arr.makeBy(10, fullPage)],
				requests,
				bodies,
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, approve())
				assert.equal(published.approval, "too_many_reviews")
				assert.isFalse(Arr.some(bodies, Str.includes("APPROVE")))
			}).pipe(Effect.provide(layer))
		})

		it.effect("does not approve close to the most reviews it can list, so its own stays findable", () => {
			const requests: Array<string> = []
			const bodies: Array<string> = []
			const reviews = (count: number) =>
				jsonResponse(
					Arr.makeBy(count, (i) => ({ id: i, state: "COMMENTED", user: { login: "octocat" } })),
				)
			// 999 reviews: every one is listed, and an approval would be the one that fills the list.
			const layer = providerLayer(
				[
					...posted(),
					pull(),
					jsonResponse({ permission: "write" }),
					...Arr.makeBy(9, () => reviews(100)),
					reviews(99),
				],
				requests,
				bodies,
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, approve())
				assert.equal(published.approval, "too_many_reviews")
				assert.isFalse(Arr.some(bodies, Str.includes("APPROVE")))
			}).pipe(Effect.provide(layer))
		})

		it.effect("keeps the published review when GitHub refuses the approval", () => {
			const layer = providerLayer(
				[
					...posted(),
					pull(),
					jsonResponse({ permission: "admin" }),
					jsonResponse([]),
					jsonResponse({ message: "Resource not accessible by integration" }, 403),
				],
				[],
				[],
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, approve())
				assert.equal(published.commentUrl, "https://github.com/octo/shop/pull/612#issuecomment-5")
				assert.isUndefined(published.approval)
			}).pipe(Effect.provide(layer))
		})

		it.effect("withdraws only its own standing approvals", () => {
			const requests: Array<string> = []
			const bodies: Array<string> = []
			const layer = providerLayer(
				[
					...posted(),
					jsonResponse([
						{ id: 1, state: "APPROVED", user: { login: "maple-review[bot]" } },
						{ id: 2, state: "APPROVED", user: { login: "octocat" } },
						{ id: 3, state: "DISMISSED", user: { login: "maple-review[bot]" } },
						{ id: 4, state: "COMMENTED", user: { login: "maple-review[bot]" } },
					]),
					jsonResponse({ id: 1, state: "DISMISSED" }),
				],
				requests,
				bodies,
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, {
					...publication(),
					approval: { action: "withdraw", reason: "the risk is medium" },
				})
				assert.equal(published.approval, "withdrawn")
				assert.deepEqual(Arr.filter(requests, Str.includes("/dismissals")), [
					"https://api.github.com/repos/octo/shop/pulls/612/reviews/1/dismissals",
				])
				assert.include(Arr.lastNonEmpty(bodies as [string, ...Array<string>]), "the risk is medium")
			}).pipe(Effect.provide(layer))
		})

		it.effect("spares its approval of the head a repeated push event names", () => {
			const requests: Array<string> = []
			const layer = providerLayer(
				[
					tokenResponse(),
					pull(),
					jsonResponse([
						{ id: 1, state: "APPROVED", user: { login: "maple-review[bot]" }, commit_id: "a" },
						{ id: 5, state: "APPROVED", user: { login: "maple-review[bot]" }, commit_id: HEAD },
					]),
					jsonResponse({ id: 1, state: "DISMISSED" }),
				],
				requests,
				[],
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const outcome = yield* provider.withdrawPullRequestApprovals(INSTALLATION, REPO, {
					number: 612,
					reason: "new commits were pushed since it approved",
					keepHead: HEAD,
				})
				assert.equal(outcome, "withdrawn")
				assert.deepEqual(Arr.filter(requests, Str.includes("/dismissals")), [
					"https://api.github.com/repos/octo/shop/pulls/612/reviews/1/dismissals",
				])
			}).pipe(Effect.provide(layer))
		})

		it.effect("leaves approvals alone for an event about a head the pull request moved past", () => {
			const requests: Array<string> = []
			const layer = providerLayer(
				[
					tokenResponse(),
					pull({
						head: {
							sha: Str.repeat(40)("d"),
							ref: "chore/label",
							repo: { full_name: "octo/shop" },
						},
					}),
				],
				requests,
				[],
				[],
				appEnv,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const outcome = yield* provider.withdrawPullRequestApprovals(INSTALLATION, REPO, {
					number: 612,
					reason: "new commits were pushed since it approved",
					keepHead: HEAD,
				})
				assert.equal(outcome, "stale")
				assert.isFalse(Arr.some(requests, Str.includes("/reviews")))
			}).pipe(Effect.provide(layer))
		})

		it.effect("fails rather than claim a withdrawal when the review list is cut short", () => {
			const fullPage = () =>
				jsonResponse(
					Arr.makeBy(100, (i) => ({ id: i, state: "COMMENTED", user: { login: "octocat" } })),
				)
			const layer = providerLayer([tokenResponse(), ...Arr.makeBy(10, fullPage)], [], [], [], appEnv)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const result = yield* provider
					.withdrawPullRequestApprovals(INSTALLATION, REPO, { number: 612, reason: "r" })
					.pipe(Effect.exit)
				assert.isTrue(Exit.isFailure(result))
			}).pipe(Effect.provide(layer))
		})

		it.effect("never approves when it could not find its own approval again to withdraw it", () => {
			const requests: Array<string> = []
			// No GITHUB_APP_SLUG: the App's reviews cannot be told from anyone else's.
			const layer = providerLayer(posted(), requests)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, approve())
				assert.equal(published.approval, "unsupported")
				assert.equal(requests.length, 5)
			}).pipe(Effect.provide(layer))
		})

		it.effect("asks nothing of GitHub when the repository did not turn approvals on", () => {
			const requests: Array<string> = []
			const layer = providerLayer(posted(), requests)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, publication())
				assert.isUndefined(published.approval)
				assert.equal(requests.length, 5)
			}).pipe(Effect.provide(layer))
		})
	})
})

describe("GithubProvider changes since an earlier review", () => {
	const OLD = Str.repeat(40)("1")
	const NEW = Str.repeat(40)("2")
	const BASE = Str.repeat(40)("3")
	const comparison = (status: string, files: ReadonlyArray<Record<string, unknown>>) =>
		jsonResponse({ status, files })
	const changed = (filename: string, patch: string) => ({ filename, status: "modified", patch })
	// The two base comparisons run concurrently, so answer by URL rather than by call order.
	const routedLayer = (routes: Record<string, Response>, requests: Array<string>) =>
		Layer.effect(GithubProvider, GithubProvider.make).pipe(
			Layer.provide(
				Layer.effect(GithubAppClient, GithubAppClient.make).pipe(
					Layer.provide(
						fakeGithubHttp(({ url }) => {
							requests.push(url)
							if (Str.endsWith("/access_tokens")(url)) return tokenResponse()
							const range = Str.split("/compare/")(new URL(url).pathname)[1] ?? ""
							return routes[range] ?? jsonResponse({ message: "Not Found" }, 404)
						}),
					),
					Layer.provide(env),
				),
			),
			Layer.provide(env),
		)

	it.effect("uses the forward comparison when the earlier head is an ancestor", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[tokenResponse(), comparison("ahead", [changed("src/a.ts", "@@ -1 +1 @@\n-x\n+y")])],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const delta = yield* provider.fetchChangesSince(INSTALLATION, REPO, {
				previousHead: OLD,
				head: NEW,
				base: BASE,
			})
			assert.deepStrictEqual(delta, { rewritten: false, paths: ["src/a.ts"] })
			assert.include(requests[1], `/compare/${OLD}...${NEW}`)
			assert.lengthOf(requests, 2)
		}).pipe(Effect.provide(layer))
	})

	it.effect("after a rebase, reports only files whose own change differs, not the base's", () => {
		const requests: Array<string> = []
		const layer = routedLayer(
			{
				// The forward diff carries everything the new base moved.
				[`${OLD}...${NEW}`]: comparison("diverged", [
					changed("src/a.ts", "@@ -1 +1 @@\n-x\n+y"),
					changed("base/moved.ts", "@@ -1 +1 @@\n-m\n+n"),
				]),
				[`${BASE}...${OLD}`]: comparison("ahead", [
					changed("src/a.ts", "@@ -10,2 +10,2 @@\n-x\n+y"),
					changed("src/b.ts", "@@ -1 +1 @@\n-p\n+q"),
				]),
				[`${BASE}...${NEW}`]: comparison("ahead", [
					changed("src/a.ts", "@@ -30,2 +30,2 @@\n-x\n+y"),
					changed("src/b.ts", "@@ -1 +1 @@\n-p\n+Q"),
				]),
			},
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const delta = yield* provider.fetchChangesSince(INSTALLATION, REPO, {
				previousHead: OLD,
				head: NEW,
				base: BASE,
			})
			assert.deepStrictEqual(delta, { rewritten: true, paths: ["src/b.ts"] })
			const compares = Arr.filter(requests, (url) => Str.includes("/compare/")(url))
			assert.deepStrictEqual(
				Arr.map(compares, (url) => Str.split("/compare/")(new URL(url).pathname)[1]).sort(),
				[`${BASE}...${NEW}`, `${BASE}...${OLD}`, `${OLD}...${NEW}`].sort(),
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("asks for everything when a rewritten history has no base, or a list is cut off", () => {
		const full = Array.from({ length: 300 }, (_, i) => changed(`f${i}.ts`, "@@ -1 +1 @@\n-a\n+b"))
		return Effect.gen(function* () {
			const noBase = yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				return yield* provider.fetchChangesSince(INSTALLATION, REPO, {
					previousHead: OLD,
					head: NEW,
					base: undefined,
				})
			}).pipe(Effect.provide(providerLayer([tokenResponse(), comparison("behind", [])])))
			assert.deepStrictEqual(noBase, { rewritten: true, paths: undefined })

			const cutOff = yield* Effect.gen(function* () {
				const provider = yield* GithubProvider
				return yield* provider.fetchChangesSince(INSTALLATION, REPO, {
					previousHead: OLD,
					head: NEW,
					base: BASE,
				})
			}).pipe(Effect.provide(providerLayer([tokenResponse(), comparison("ahead", full)])))
			assert.deepStrictEqual(cutOff, { rewritten: false, paths: undefined })
		})
	})
})

describe("GithubProvider reading why a CI job failed", () => {
	it.effect("reads the job's check-run annotations, keeping only those with a message", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				jsonResponse([
					{
						annotation_level: "failure",
						message: "expected 2 to be 3",
						title: "adds",
						path: "src/math.test.ts",
						start_line: 12,
					},
					{ annotation_level: "notice", message: null, path: ".github" },
				]),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const annotations = yield* provider.fetchWorkflowJobAnnotations(INSTALLATION, REPO, "555")
			assert.isTrue(
				Str.endsWith("/repos/octo/shop/check-runs/555/annotations?per_page=100&page=1")(requests[1]),
			)
			assert.deepStrictEqual(annotations, [
				{
					level: "failure",
					message: "expected 2 to be 3",
					title: "adds",
					path: "src/math.test.ts",
					startLine: 12,
				},
			])
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads past a page of warnings to the failure, and no further", () => {
		const requests: Array<string> = []
		const warning = { annotation_level: "warning", message: "Node 16 is deprecated" }
		const layer = providerLayer(
			[
				tokenResponse(),
				jsonResponse(Array.from({ length: 100 }, () => warning)),
				jsonResponse([
					...Array.from({ length: 99 }, () => warning),
					{ annotation_level: "failure", message: "expected 2 to be 3" },
				]),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const annotations = yield* provider.fetchWorkflowJobAnnotations(INSTALLATION, REPO, "555")
			// A full page holding the failure ends the read.
			assert.lengthOf(requests, 3)
			assert.lengthOf(annotations, 200)
			assert.strictEqual(annotations.at(-1)?.message, "expected 2 to be 3")
		}).pipe(Effect.provide(layer))
	})
})

describe("GithubProvider reading a CI job's log", () => {
	const SIGNED_URL = "https://results.blob.example/job-555.txt?sig=abc"
	const redirect = () => new Response(null, { status: 302, headers: { location: SIGNED_URL } })

	it.effect("follows GitHub's redirect to the signed URL without the installation token", () => {
		const requests: Array<string> = []
		const authorizations: Array<string | undefined> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				redirect(),
				new Response("2026-08-20T10:00:00.1000000Z first\n2026-08-20T10:00:01.2000000Z second\n"),
			],
			requests,
			[],
			authorizations,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const lines = yield* provider
				.streamWorkflowJobLog(INSTALLATION, REPO, "555")
				.pipe(Stream.runCollect)
			assert.isTrue(Str.endsWith("/repos/octo/shop/actions/jobs/555/logs")(requests[1]))
			assert.strictEqual(authorizations[1], "token installation-token")
			assert.strictEqual(requests[2], SIGNED_URL)
			assert.isUndefined(authorizations[2])
			assert.deepStrictEqual(lines, [
				"2026-08-20T10:00:00.1000000Z first",
				"2026-08-20T10:00:01.2000000Z second",
			])
		}).pipe(Effect.provide(layer))
	})

	const tokenWithPermissions = (permissions: Record<string, string>) =>
		jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z", permissions })

	it.effect(
		"reports logs unreadable for an installation without actions access, asking GitHub once",
		() => {
			const requests: Array<string> = []
			const layer = providerLayer(
				[tokenWithPermissions({ contents: "read", metadata: "read" })],
				requests,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				assert.isFalse(yield* provider.canReadWorkflowLogs(INSTALLATION))
				assert.isFalse(yield* provider.canReadWorkflowLogs(INSTALLATION))
				assert.lengthOf(requests, 1)
				assert.isTrue(Str.endsWith("/app/installations/42/access_tokens")(requests[0]))
			}).pipe(Effect.provide(layer))
		},
	)

	it.effect("assumes logs readable when the token lists no permissions", () => {
		const requests: Array<string> = []
		const layer = providerLayer([tokenResponse()], requests)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			assert.isTrue(yield* provider.canReadWorkflowLogs(INSTALLATION))
			assert.lengthOf(requests, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads the log of an installation with actions access on the same token", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenWithPermissions({ actions: "read", contents: "read" }),
				redirect(),
				new Response("2026-08-20T10:00:00.1000000Z first\n"),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			assert.isTrue(yield* provider.canReadWorkflowLogs(INSTALLATION))
			const lines = yield* provider
				.streamWorkflowJobLog(INSTALLATION, REPO, "555")
				.pipe(Stream.runCollect)
			assert.deepStrictEqual(lines, ["2026-08-20T10:00:00.1000000Z first"])
			assert.lengthOf(requests, 3)
		}).pipe(Effect.provide(layer))
	})

	it.effect("waits out a log that is not uploaded yet", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[
				tokenResponse(),
				jsonResponse({ message: "Not Found" }, 404),
				redirect(),
				new Response("2026-08-20T10:00:00.1000000Z ready\n"),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const fiber = yield* Effect.forkChild(
				provider.streamWorkflowJobLog(INSTALLATION, REPO, "555").pipe(Stream.runCollect),
				{ startImmediately: true },
			)
			// The fake responses resolve on later ticks, so the clock moves only once the retry sleeps.
			for (let tick = 0; tick < 10; tick++) {
				yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
				yield* TestClock.adjust("2 seconds")
			}
			const lines = yield* Fiber.join(fiber)
			assert.lengthOf(requests, 4)
			assert.deepStrictEqual(lines, ["2026-08-20T10:00:00.1000000Z ready"])
		}).pipe(Effect.provide(layer))
	})
})

describe("GithubProvider hiding earlier review comments", () => {
	const comment = (id: number, body: string, appId: number | null) => ({
		id,
		node_id: `IC_${id}`,
		html_url: `https://github.com/octo/shop/pull/612#issuecomment-${id}`,
		body,
		performed_via_github_app: appId === null ? null : { id: appId },
	})

	it.effect(
		"hides this App's earlier reviews as outdated, keeping the newest and anything already hidden",
		() => {
			const requests: Array<string> = []
			const bodies: Array<string> = []
			const layer = providerLayer(
				[
					tokenResponse(),
					jsonResponse([
						comment(1, "<!-- maple-pr-review r1 0 -->\n## Maple review", 123456),
						comment(2, "<!-- maple-pr-review r2 0 -->\n## Maple review", 123456),
						// Another App quoting the marker, a person, and this App's merge reminder stay.
						comment(3, "<!-- maple-pr-review r1 0 -->", 999),
						comment(4, "<!-- maple-pr-review r1 0 --> quoted", null),
						comment(5, "<!-- maple-pr-merge-steps -->", 123456),
						comment(6, "<!-- maple-pr-review r3 0 -->\n## Maple review", 123456),
					]),
					jsonResponse({
						data: {
							nodes: [
								{ id: "IC_1", isMinimized: true },
								{ id: "IC_2", isMinimized: false },
							],
						},
					}),
					jsonResponse({ data: { minimizeComment: { minimizedComment: { isMinimized: true } } } }),
				],
				requests,
				bodies,
			)
			return Effect.gen(function* () {
				const provider = yield* GithubProvider
				const hidden = yield* provider.hideEarlierComments(INSTALLATION, REPO, {
					number: 612,
					prefix: "<!-- maple-pr-review ",
					keep: "<!-- maple-pr-review r3 0 -->",
				})
				assert.equal(hidden, 1)
				assert.deepEqual(JSON.parse(bodies[2]).variables, { ids: ["IC_1", "IC_2"] })
				assert.include(bodies[3], "classifier: OUTDATED")
				assert.deepEqual(JSON.parse(bodies[3]).variables, { id: "IC_2" })
				assert.lengthOf(requests, 4)
			}).pipe(Effect.provide(layer))
		},
	)

	it.effect("reads nothing more when no earlier review is shown", () => {
		const requests: Array<string> = []
		const layer = providerLayer(
			[tokenResponse(), jsonResponse([comment(6, "<!-- maple-pr-review r3 0 -->", 123456)])],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const hidden = yield* provider.hideEarlierComments(INSTALLATION, REPO, {
				number: 612,
				prefix: "<!-- maple-pr-review ",
				keep: "<!-- maple-pr-review r3 0 -->",
			})
			assert.equal(hidden, 0)
			assert.lengthOf(requests, 2)
		}).pipe(Effect.provide(layer))
	})
})
