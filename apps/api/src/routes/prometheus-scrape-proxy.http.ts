import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { ScrapeTargetId } from "@maple/domain/http"
import { Env } from "../lib/Env"
import { ScrapeTargetsService } from "../services/ScrapeTargetsService"
import { isValidInternalBearer } from "../lib/internal-auth"

const decodeScrapeTargetIdEffect = Schema.decodeUnknownEffect(ScrapeTargetId)

const targetIdFromRequest = (req: HttpServerRequest.HttpServerRequest) => {
	const url = new URL(req.url, "http://internal")
	return url.searchParams.get("targetId")
}

const errorText = (message: string, status: number) =>
	HttpServerResponse.text(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	})

const statusForProxyError = (error: unknown): number => {
	const tag =
		typeof error === "object" && error !== null && "_tag" in error
			? (error as { _tag?: unknown })._tag
			: undefined
	if (tag === "@maple/http/errors/ScrapeTargetNotFoundError") return 404
	if (tag === "@maple/http/errors/ScrapeTargetEncryptionError") return 500
	return 502
}

const messageForProxyError = (error: unknown): string => {
	if (typeof error === "object" && error !== null && "message" in error) {
		return String((error as { message?: unknown }).message)
	}
	return "Failed to scrape target"
}

export const PrometheusScrapeProxyRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const service = yield* ScrapeTargetsService
		const internalToken = Option.match(env.SD_INTERNAL_TOKEN, {
			onNone: () => undefined,
			onSome: Redacted.value,
		})

		const handle = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				if (!internalToken) {
					return errorText("Prometheus scrape proxy is not configured", 401)
				}

				if (!isValidInternalBearer(req.headers.authorization, internalToken)) {
					return errorText("Unauthorized", 401)
				}

				const rawTargetId = targetIdFromRequest(req)
				if (!rawTargetId) {
					return errorText("Missing targetId", 400)
				}

				const targetId = yield* decodeScrapeTargetIdEffect(rawTargetId).pipe(Effect.option)
				if (Option.isNone(targetId)) {
					return errorText("Invalid targetId", 400)
				}

				return yield* service.scrapeForCollector(targetId.value).pipe(
					Effect.flatMap((response) =>
						Effect.succeed(
							HttpServerResponse.text(response.body, {
								status: response.status,
								headers: { "content-type": response.contentType },
							}),
						),
					),
					Effect.catch((error: unknown) =>
						Effect.succeed(errorText(messageForProxyError(error), statusForProxyError(error))),
					),
				)
			})

		yield* router.add("GET", "/api/internal/prometheus-scrape", handle)
	}),
)
