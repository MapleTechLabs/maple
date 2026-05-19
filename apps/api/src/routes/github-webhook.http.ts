import { githubInstallations, type GithubInstallationRow } from "@maple/db"
import type { OrgId } from "@maple/domain/http"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Database, type DatabaseClient } from "../services/DatabaseLive"
import { GithubAppJwtService } from "../services/GithubAppJwtService"
import { GithubAppService } from "../services/GithubAppService"
import { GithubSyncService } from "../services/GithubSyncService"

const WEBHOOK_PATH = "/api/webhooks/github"

type PushCommit = { id?: string }

type PushPayload = {
	ref?: string
	before?: string
	after?: string
	forced?: boolean
	commits?: ReadonlyArray<PushCommit>
	installation?: { id?: number }
	repository?: { owner?: { login?: string }; name?: string }
}

type InstallationPayload = {
	action?: string
	installation?: { id?: number; account?: { id?: number } }
}

type InstallationReposPayload = InstallationPayload

const arrayBufferFromText = (text: string): ArrayBuffer => {
	const bytes = new TextEncoder().encode(text)
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const lookupOrgForInstallation = (db: DatabaseClient, installationId: number) =>
	db
		.select()
		.from(githubInstallations)
		.where(eq(githubInstallations.installationId, installationId))
		.limit(1)

export const GithubWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const jwtService = yield* GithubAppJwtService
		const sync = yield* GithubSyncService
		const app = yield* GithubAppService
		const database = yield* Database

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const headers = req.headers as Record<string, string | undefined>
				const event = headers["x-github-event"]
				const signature = headers["x-hub-signature-256"]
				const bodyText = yield* req.text
				const verifiedExit = yield* Effect.exit(
					jwtService.verifyWebhookSignature(signature, arrayBufferFromText(bodyText)),
				)

				if (Exit.isFailure(verifiedExit) || verifiedExit.value === false) {
					return HttpServerResponse.text("invalid signature", { status: 401 })
				}

				let body: unknown
				try {
					body = JSON.parse(bodyText)
				} catch {
					return HttpServerResponse.text("invalid json", { status: 400 })
				}

				if (event === "ping") {
					return HttpServerResponse.text("pong", { status: 200 })
				}

				const installationIdRaw =
					(body as { installation?: { id?: number } }).installation?.id ?? null
				if (typeof installationIdRaw !== "number") {
					return HttpServerResponse.text("no installation id", { status: 200 })
				}

				const installations = (yield* database
					.execute((db) => lookupOrgForInstallation(db, installationIdRaw))
					.pipe(Effect.orDie)) as ReadonlyArray<GithubInstallationRow>
				if (installations.length === 0) {
					// We received a webhook for an installation we don't track. Acknowledge
					// silently; if the installation event itself arrives next we'll create it.
					return HttpServerResponse.text("unknown installation", { status: 200 })
				}

				const action = (body as { action?: string }).action

				// Webhook delivery is bounded and time-sensitive (10s GitHub timeout).
				// We run reconciliation inline rather than enqueueing because the
				// payload is small, the user expects immediate UI updates after
				// connect/push, and the 6h cron sweep catches anything we miss.
				switch (event) {
					case "installation": {
						if (action === "deleted") {
							// User uninstalled the App on GitHub side — purge our state.
							for (const installation of installations) {
								yield* Effect.exit(
									app.disconnectInstallation({
										orgId: installation.orgId as OrgId,
										installationId: installation.id,
									}),
								)
							}
							break
						}
						for (const installation of installations) {
							yield* Effect.exit(
								sync.runReconcile({
									orgId: installation.orgId,
									installationId: installation.installationId,
								}),
							)
						}
						break
					}
					case "installation_repositories": {
						for (const installation of installations) {
							yield* Effect.exit(
								sync.runReconcile({
									orgId: installation.orgId,
									installationId: installation.installationId,
								}),
							)
						}
						break
					}
					case "push": {
						const push = body as PushPayload
						const owner = push.repository?.owner?.login
						const name = push.repository?.name
						if (!owner || !name || !push.ref || !push.after || !push.before) break
						const commitShas = (push.commits ?? [])
							.map((c) => c.id)
							.filter((id): id is string => typeof id === "string")
						for (const installation of installations) {
							yield* Effect.exit(
								sync.runWebhookPush({
									orgId: installation.orgId,
									installationId: installation.installationId,
									owner,
									name,
									ref: push.ref,
									before: push.before,
									after: push.after,
									forced: push.forced ?? false,
									commitShas,
								}),
							)
						}
						break
					}
					case "release":
					case "pull_request":
					case "meta":
						// Future use — acknowledge for now.
						break
					default:
						break
				}

				return HttpServerResponse.text("ok", { status: 200 })
			})

		yield* router.add("POST", WEBHOOK_PATH, handle)
	}),
)
