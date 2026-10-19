import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { GitCommitSha, type PullRequestReviewPublication, type VcsInstallation } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { GithubAppClient } from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import { fakeGithubHttp } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { GithubProvider } from "@maple/backend/services/integrations/vcs/vendor/github/GithubProvider"

const privateKey = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey

const env = Env.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({
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

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const tokenResponse = () => jsonResponse({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" })

const INSTALLATION = { externalInstallationId: "42" } as VcsInstallation
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
) => {
	let next = 0
	const http = fakeGithubHttp(({ url, body, headers }) => {
		requests.push(url)
		bodies.push(body ?? "")
		authorizations.push(headers["authorization"])
		return responses[next++]!
	})
	return Layer.effect(GithubProvider, GithubProvider.make).pipe(
		Layer.provide(
			Layer.effect(GithubAppClient, GithubAppClient.make).pipe(Layer.provide(http), Layer.provide(env)),
		),
		Layer.provide(env),
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
						merge_commit_sha: "a".repeat(40),
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
				prs.map((pr) => [pr.number, pr.state]),
				[
					[612, "open"],
					[611, "merged"],
					[610, "closed"],
				],
			)
			assert.strictEqual(prs[1]?.mergedAtMs, Date.parse("2026-08-19T09:00:00Z"))
			assert.strictEqual(prs[1]?.mergeCommitSha, "a".repeat(40))
			assert.strictEqual(prs[0]?.authorLogin, "octocat")
			assert.strictEqual(prs[2]?.authorLogin, null, "a ghosted author is not a failure")
			assert.strictEqual(prs[2]?.isDraft, true)
			assert.strictEqual(prs[0]?.headRef, "fix/null-customer")

			const listUrl = requests[1]!
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
				assert.match(requests[1]!, /per_page=100/)
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
			assert.match(requests[1]!, /\/repos\/octo\/shop\/pulls\/612$/)
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
	const sha = Schema.decodeUnknownSync(GitCommitSha)("b".repeat(40))

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
	const HEAD = Schema.decodeUnknownSync(GitCommitSha)("c".repeat(40))
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
			Object.entries(patches).map(([filename, patch]) => ({
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
			assert.isTrue(requests.at(-1)?.endsWith("/repos/octo/shop/issues/612/comments"))
			// No review at all: the comment carries the result.
			assert.isFalse(requests.some((url) => url.includes("/reviews")))
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
			assert.include(requests[1]!, "/commits/abc123/check-runs?check_name=Maple%20%2F%20observability")
			assert.isTrue(requests[2]!.endsWith("/repos/octo/shop/check-runs"))
			assert.include(bodies[2]!, `"status":"in_progress"`)
			assert.notInclude(bodies[2]!, "conclusion")

			const published = yield* provider.publishPullRequestReview(INSTALLATION, REPO, publication())
			assert.equal(published.checkRunUrl, "https://github.com/octo/shop/runs/7")
			// The running one is moved on, not duplicated.
			assert.isTrue(requests[4]!.endsWith("/repos/octo/shop/check-runs/7"))
			assert.include(bodies[4]!, `"conclusion":"success"`)
			assert.notInclude(bodies[4]!, "head_sha")
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
			assert.isFalse(requests.some((url) => url.includes("/comments")))
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
			assert.isTrue(requests.at(-1)?.endsWith("/repos/octo/shop/issues/comments/77"))
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
			assert.isTrue(requests.at(-1)?.endsWith("/repos/octo/shop/issues/612/comments"))
			assert.isFalse(requests.some((url) => url.includes("/issues/comments/9")))
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
			assert.equal(requests.filter((url) => url.endsWith("/pulls/612/reviews")).length, 1)
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
			assert.isTrue(requests.at(-2)?.endsWith("/repos/octo/shop/pulls/612/reviews"))
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
})

describe("GithubProvider changes since an earlier review", () => {
	const OLD = "1".repeat(40)
	const NEW = "2".repeat(40)
	const BASE = "3".repeat(40)
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
							if (url.endsWith("/access_tokens")) return tokenResponse()
							const range = new URL(url).pathname.split("/compare/")[1] ?? ""
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
			assert.include(requests[1]!, `/compare/${OLD}...${NEW}`)
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
			const compares = requests.filter((url) => url.includes("/compare/"))
			assert.deepStrictEqual(
				compares.map((url) => new URL(url).pathname.split("/compare/")[1]).sort(),
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
				requests[1]!.endsWith("/repos/octo/shop/check-runs/555/annotations?per_page=100&page=1"),
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
			assert.isTrue(requests[1]!.endsWith("/repos/octo/shop/actions/jobs/555/logs"))
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
				assert.isTrue(requests[0]!.endsWith("/app/installations/42/access_tokens"))
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
