import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	ChatApplyResponse,
	ChatToolExecutionError,
	ChatToolNotApplicableError,
	ChatToolNotFoundError,
	CurrentTenant,
	MapleAiApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { encodeChatTurnTenant, orgIdFromChatSessionId } from "@maple/domain/chat-session"
import { chatSessionStub } from "@maple/domain/chat-session-stub"
import { describeCause } from "@maple/backend/platform/describe-cause"

/** A session call that did not complete. It may have got as far as running the tool, so the copy hedges. */
const sessionCall = <A>(toolCallId: string, run: () => Promise<A>) =>
	Effect.tryPromise(run).pipe(
		Effect.tapError((error) =>
			Effect.logError("A chat approval could not reach its session").pipe(
				Effect.annotateLogs({ toolCallId, cause: describeCause(error.cause) }),
			),
		),
		Effect.mapError(
			() =>
				new ChatToolExecutionError({
					toolCallId,
					message: "Maple couldn't confirm the change — check the conversation.",
				}),
		),
	)

/**
 * `POST /internal/chat/apply` — decide an approval-gated proposal as the signed-in user.
 *
 * By reference, through `ChatSession.settleProposal`: the session reads the tool and its arguments
 * out of its own log, refuses a call that is not an open proposal or is already decided, runs it
 * under this caller's tenant, and records the outcome as the call's `tool-result`.
 */
export const HttpChatLive = HttpApiBuilder.group(MapleAiApi, "chat", (handlers) =>
	handlers.handle("apply", ({ payload }) =>
		Effect.gen(function* () {
			const { sessionId, toolCallId, decision } = payload
			const tenant = yield* CurrentTenant.Context
			const notFound = new ChatToolNotFoundError({
				toolCallId,
				message: "This conversation has no proposal with that id.",
			})
			// Another org's conversation reads as missing: confirming it exists is itself a leak.
			if (orgIdFromChatSessionId(sessionId) !== tenant.orgId) return yield* notFound

			const stub = chatSessionStub(yield* WorkerEnvironment, sessionId)
			if (stub === undefined) {
				return yield* new ChatToolExecutionError({
					toolCallId,
					message: "Chat sessions are not configured on this deployment.",
				})
			}

			const outcome = yield* sessionCall(toolCallId, () =>
				stub.settleProposal({
					sessionId,
					toolCallId,
					decision,
					approver: { kind: "app" },
					tenant: encodeChatTurnTenant({
						orgId: tenant.orgId,
						userId: tenant.userId,
						roles: tenant.roles,
						authMode: tenant.authMode,
					}),
				}),
			)
			if (outcome === "unknown") return yield* notFound
			if (outcome === "settled") {
				return yield* new ChatToolNotApplicableError({
					toolCallId,
					message: "This change has already been decided.",
				})
			}

			// The answer is what the session recorded, read back as the chat-platform relay reads it.
			const messages = yield* sessionCall(toolCallId, () => stub.history())
			const call = messages.flatMap((message) => message.toolCalls).find((c) => c.id === toolCallId)
			return new ChatApplyResponse({
				content: typeof call?.output === "string" ? call.output : "",
				...(call?.isError === true ? { isError: true } : undefined),
			})
		}),
	),
)
