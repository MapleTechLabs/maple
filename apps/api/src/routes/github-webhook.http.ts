import type { OrgId } from "@maple/domain/http"
import { Effect, Match, Option, Schema } from "effect"
import {
	Headers,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http"
import { GithubAppJwtService } from "../services/GithubAppJwtService"
import { GithubAppService } from "../services/GithubAppService"
import { GithubInstallationRepo } from "../services/GithubInstallationRepo"
import { GithubSyncQueue } from "../services/GithubSyncQueue"
import { GithubSyncService, type WebhookPushCommit } from "../services/GithubSyncService"

const WEBHOOK_PATH = "/api/webhooks/github"

// Below this threshold we process the push inline (snappy UI, no API calls
// since the payload carries everything we need). Above it we enqueue so the
// webhook handler stays well under GitHub's 10s timeout.
const INLINE_PUSH_LIMIT = 5

// --- Schemas -------------------------------------------------------------
//
// We validate only the fields we read. Schemas decode JSON-string → typed
// value via `Schema.fromJsonString` so the parse + structure check land in
// one step, and downstream code sees non-nullable required fields.

const WebhookCommitAuthor = Schema.Struct({
	name: Schema.optional(Schema.String),
	email: Schema.optional(Schema.String),
	username: Schema.optional(Schema.String),
})

const WebhookPushCommitSchema = Schema.Struct({
	id: Schema.String,
	message: Schema.optional(Schema.String),
	timestamp: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	author: Schema.optional(Schema.NullOr(WebhookCommitAuthor)),
	committer: Schema.optional(Schema.NullOr(WebhookCommitAuthor)),
})

const WebhookInstallationRef = Schema.Struct({
	id: Schema.Number,
})

// All events we route on carry an installation reference. `ping` doesn't, and
// is handled before any installation lookup.
const WebhookBaseBody = Schema.Struct({
	installation: WebhookInstallationRef,
	action: Schema.optional(Schema.String),
})

const WebhookPushBody = Schema.Struct({
	installation: WebhookInstallationRef,
	ref: Schema.String,
	before: Schema.String,
	after: Schema.String,
	forced: Schema.optional(Schema.Boolean),
	repository: Schema.Struct({
		owner: Schema.Struct({ login: Schema.String }),
		name: Schema.String,
	}),
	commits: Schema.optional(Schema.Array(WebhookPushCommitSchema)),
})

const BaseBodyFromJson = Schema.fromJsonString(WebhookBaseBody)
const PushBodyFromJson = Schema.fromJsonString(WebhookPushBody)

type DecodedPushCommit = Schema.Schema.Type<typeof WebhookPushCommitSchema>

const toWebhookPushCommit = (raw: DecodedPushCommit): WebhookPushCommit => ({
	sha: raw.id,
	message: raw.message ?? "",
	url: raw.url ?? "",
	timestamp: raw.timestamp ?? null,
	author: raw.author
		? {
				name: raw.author.name ?? null,
				email: raw.author.email ?? null,
				login: raw.author.username ?? null,
			}
		: null,
	committer: raw.committer
		? {
				name: raw.committer.name ?? null,
				email: raw.committer.email ?? null,
				login: raw.committer.username ?? null,
			}
		: null,
})

export const GithubWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const jwtService = yield* GithubAppJwtService
		const sync = yield* GithubSyncService
		const queue = yield* GithubSyncQueue
		const app = yield* GithubAppService
		const installationRepo = yield* GithubInstallationRepo

		// Swallows-but-logs any failure from a per-installation fan-out call.
		// Webhook responses are always 200 (GitHub retries on non-2xx), so we
		// can't let typed errors propagate — but losing them silently makes
		// misbehaving webhooks invisible. tapCause writes the original Cause
		// (with sha, error chain) to OTel before the catchCause discards it.
		const fireAndLog = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
			effect.pipe(
				Effect.tapCause((cause) => Effect.logError(`[github-webhook] ${label}`, cause)),
				Effect.ignore,
			)

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
			const event = Option.getOrUndefined(Headers.get(req.headers, "x-github-event"))
			const signature = Option.getOrUndefined(Headers.get(req.headers, "x-hub-signature-256"))
			const bodyText = yield* req.text

			const verifiedResult = yield* Effect.result(
				jwtService.verifyWebhookSignature(signature, bodyText),
			)
			if (verifiedResult._tag === "Failure" || verifiedResult.success === false) {
				return HttpServerResponse.text("invalid signature", { status: 401 })
			}

			if (event === "ping") {
				return HttpServerResponse.text("pong", { status: 200 })
			}

			// Every event we route on carries `installation.id`. If the base
			// shape doesn't validate (or `installation` is absent), there's
			// nothing for us to do — ack and move on.
			const baseResult = yield* Effect.result(
				Schema.decodeUnknownEffect(BaseBodyFromJson)(bodyText),
			)
			if (baseResult._tag === "Failure") {
				yield* Effect.logWarning("[github-webhook] body failed schema decode", {
					event,
					"schema.error": baseResult.failure,
				})
				return HttpServerResponse.text("invalid payload", { status: 200 })
			}
			const base = baseResult.success
			const installations = yield* installationRepo.findByInstallationId(base.installation.id)
			if (installations.length === 0) {
				// We received a webhook for an installation we don't track. Acknowledge
				// silently; if the installation event itself arrives next we'll create it.
				return HttpServerResponse.text("unknown installation", { status: 200 })
			}

			// Webhook delivery is bounded and time-sensitive (10s GitHub timeout).
			// We run reconciliation inline rather than enqueueing because the
			// payload is small, the user expects immediate UI updates after
			// connect/push, and the 6h cron sweep catches anything we miss.
			yield* Match.value(event ?? "").pipe(
				Match.when("installation", () =>
					Effect.forEach(installations, (installation) =>
						base.action === "deleted"
							? // User uninstalled the App on GitHub side — purge our state.
								fireAndLog(
									`installation.deleted failed for ${installation.id}`,
									app.disconnectInstallation({
										orgId: installation.orgId as OrgId,
										installationId: installation.id,
									}),
								)
							: fireAndLog(
									`installation reconcile failed for ${installation.installationId}`,
									sync.runReconcile({
										orgId: installation.orgId,
										installationId: installation.installationId,
									}),
								),
					),
				),
				Match.when("installation_repositories", () =>
					Effect.forEach(installations, (installation) =>
						fireAndLog(
							`installation_repositories reconcile failed for ${installation.installationId}`,
							sync.runReconcile({
								orgId: installation.orgId,
								installationId: installation.installationId,
							}),
						),
					),
				),
				Match.when("push", () =>
					Effect.gen(function* () {
						const pushResult = yield* Effect.result(
							Schema.decodeUnknownEffect(PushBodyFromJson)(bodyText),
						)
						if (pushResult._tag === "Failure") {
							yield* Effect.logWarning(
								"[github-webhook] push body failed schema decode",
								{ "schema.error": pushResult.failure },
							)
							return
						}
						const push = pushResult.success
						const inlineCommits = (push.commits ?? []).map(toWebhookPushCommit)
						// Inline path: small pushes use the webhook payload's own commit
						// data — zero GitHub API calls. Anything larger (or a forced /
						// branch-create push, where commits[] is empty) goes to the queue
						// so the webhook handler stays under GitHub's 10s budget.
						const useInline =
							!(push.forced ?? false) &&
							inlineCommits.length > 0 &&
							inlineCommits.length <= INLINE_PUSH_LIMIT
						yield* Effect.forEach(installations, (installation) =>
							useInline
								? fireAndLog(
										`push (inline) failed for ${installation.installationId}`,
										sync.runWebhookPush({
											orgId: installation.orgId,
											installationId: installation.installationId,
											owner: push.repository.owner.login,
											name: push.repository.name,
											ref: push.ref,
											before: push.before,
											after: push.after,
											forced: push.forced ?? false,
											commits: inlineCommits,
										}),
									)
								: fireAndLog(
										`push (queue) enqueue failed for ${installation.installationId}`,
										queue.enqueue({
											_tag: "SyncWebhookPush",
											orgId: installation.orgId,
											installationId: installation.installationId,
											owner: push.repository.owner.login,
											name: push.repository.name,
											ref: push.ref,
											before: push.before,
											after: push.after,
											forced: push.forced ?? false,
											commitShas: inlineCommits.map((c) => c.sha),
										}),
									),
						)
					}),
				),
				// Future use — acknowledge for now.
				Match.whenOr("release", "pull_request", "meta", () => Effect.void),
				Match.orElse(() => Effect.void),
			)

			return HttpServerResponse.text("ok", { status: 200 })
		})

		yield* router.add("POST", WEBHOOK_PATH, handle)
	}),
)
