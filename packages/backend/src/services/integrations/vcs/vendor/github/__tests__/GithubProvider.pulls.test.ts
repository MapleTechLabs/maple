import { assert, describe, it } from "@effect/vitest"
import { generateKeyPairSync } from "node:crypto"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { GitCommitSha, type PullRequestReviewPublication, type VcsInstallation } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { GithubAppClient } from "@maple/backend/services/integrations/vcs/vendor/github/GithubAppClient"
import {
	GithubHttp,
	type GithubHttpApi,
} from "@maple/backend/services/integrations/vcs/vendor/github/GithubHttp"
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

const providerLayer = (responses: ReadonlyArray<Response>, requests: Array<string> = []) => {
	let next = 0
	const http = Layer.succeed(GithubHttp, {
		fetch: async (url) => {
			requests.push(url)
			return responses[next++]!
		},
	} satisfies GithubHttpApi)
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
	const checkRun = () => jsonResponse({ id: 1, html_url: "https://github.com/octo/shop/runs/1" }, 201)
	const written = (id: number) =>
		jsonResponse({ id, html_url: `https://github.com/octo/shop/pull/612#issuecomment-${id}` }, 201)

	it.effect("writes the summary comment even when there is nothing to say inline", () => {
		const requests: Array<string> = []
		const layer = providerLayer([tokenResponse(), checkRun(), jsonResponse([]), written(5)], requests)
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
				checkRun(),
				jsonResponse([]),
				written(5),
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
				checkRun(),
				jsonResponse([]),
				written(5),
				jsonResponse({
					id: 8,
					html_url: "https://github.com/octo/shop/pull/612#pullrequestreview-8",
				}),
			],
			requests,
		)
		return Effect.gen(function* () {
			const provider = yield* GithubProvider
			const published = yield* provider.publishPullRequestReview(
				INSTALLATION,
				REPO,
				publication([{ path: "a.ts", line: 3, body: "add a span" }]),
			)
			assert.equal(published.reviewUrl, "https://github.com/octo/shop/pull/612#pullrequestreview-8")
			assert.isTrue(requests.at(-1)?.endsWith("/repos/octo/shop/pulls/612/reviews"))
		}).pipe(Effect.provide(layer))
	})
})
