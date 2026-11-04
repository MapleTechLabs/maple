import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import type { VcsProviderClient } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { VCS_WEBHOOK_MAX_BYTES, VcsWebhookRouter } from "./vcs.http"

const PATH = "http://api.localhost/api/integrations/github/webhook"
const SIGNATURE = { "x-hub-signature-256": "sha256=00" }

/** A body that fails as soon as anything pulls it. */
const unreadableBody = () =>
	new ReadableStream<Uint8Array>({
		pull: (controller) => controller.error(new Error("the body was read")),
	})

const makeHandler = () => {
	const delivered: Array<string> = []
	const unused = () => Effect.die("not used by the webhook route")
	const provider: VcsProviderClient = {
		id: "github",
		reviewerMention: "@maple-review-bot",
		webhookSignatureHeader: "x-hub-signature-256",
		webhookToJobs: (input) => Effect.sync(() => (delivered.push(input.rawBody), [])),
		fetchRepositories: unused,
		fetchCommits: unused,
		fetchBranches: unused,
		fetchCommit: unused,
		fetchPullRequests: unused,
		fetchPullRequest: unused,
		fetchPullRequestFiles: unused,
		fetchReviewThreads: unused,
		resolveReviewThread: unused,
		hideEarlierComments: unused,
		fetchChangesSince: unused,
		fetchPullRequestHead: unused,
		postPullRequestReply: unused,
		reactToComment: unused,
		fetchCommenterPermission: unused,
		commitFiles: unused,
		fetchPullRequestContext: unused,
		publishPullRequestReview: unused,
		writePullRequestCheck: unused,
		writePullRequestSummaryComment: unused,
		searchCode: unused,
		resolveRef: unused,
		fetchCloneCredentials: unused,
		fetchSourceFile: unused,
	}
	const web = HttpRouter.toWebHandler(
		VcsWebhookRouter.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(VcsProviderRegistry, {
						ids: ["github"],
						resolve: () => Effect.succeed(provider),
					}),
					Layer.succeed(VcsSyncQueue, { send: () => Effect.void, sendBatch: () => Effect.void }),
				),
			),
		),
		{ disableLogger: true },
	)
	const post = (body: BodyInit, headers: Record<string, string>) =>
		Effect.promise(() =>
			web.handler(
				new Request(PATH, { method: "POST", body, headers, duplex: "half" }),
				Context.empty(),
			),
		)
	return { delivered, post, dispose: Effect.promise(() => web.dispose()) }
}

describe("VcsWebhookRouter", () => {
	it.live("hands a signed delivery to the provider", () =>
		Effect.gen(function* () {
			const { delivered, post, dispose } = makeHandler()
			const response = yield* post('{"zen":"ok"}', SIGNATURE).pipe(Effect.ensuring(dispose))
			assert.strictEqual(response.status, 202)
			assert.deepStrictEqual(delivered, ['{"zen":"ok"}'])
		}),
	)

	it.live("refuses a delivery without a signature before reading its body", () =>
		Effect.gen(function* () {
			const { delivered, post, dispose } = makeHandler()
			const response = yield* post(unreadableBody(), {}).pipe(Effect.ensuring(dispose))
			assert.strictEqual(response.status, 401)
			assert.deepStrictEqual(delivered, [])
		}),
	)

	it.live("refuses a body over the limit, declared or streamed", () =>
		Effect.gen(function* () {
			const { delivered, post, dispose } = makeHandler()
			const declared = yield* post(unreadableBody(), {
				...SIGNATURE,
				"content-length": String(VCS_WEBHOOK_MAX_BYTES + 1),
			})
			const streamed = yield* post(new Uint8Array(VCS_WEBHOOK_MAX_BYTES + 1), SIGNATURE).pipe(
				Effect.ensuring(dispose),
			)
			assert.strictEqual(declared.status, 413)
			assert.strictEqual(streamed.status, 413)
			assert.deepStrictEqual(delivered, [])
		}),
	)
})
