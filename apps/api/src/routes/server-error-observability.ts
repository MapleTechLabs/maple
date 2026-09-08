import { Effect, Schema, SchemaAST } from "effect"
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

/** The `HttpApiSchema.status` annotation, the one the response encoder resolves. */
const httpApiStatus = SchemaAST.resolveAt<number>("httpApiStatus")

/**
 * The status an endpoint answers a typed failure with, read from the endpoint's declared error
 * schemas — the same annotation the encoder uses, so this cannot disagree with the wire. An
 * unannotated error schema encodes as 500, which is also what `HttpApi` does.
 */
const declaredStatus = (endpoint: HttpApiEndpoint.Top, error: unknown): number | undefined => {
	for (const schema of endpoint.error) {
		if (Schema.is(schema)(error)) return httpApiStatus(schema.ast) ?? 500
	}
	return undefined
}

const tagOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
		? error._tag
		: typeof error

const messageOf = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
		? error.message
		: undefined

/**
 * Record a typed failure the endpoint answers with a 5xx.
 *
 * Domain errors pass the boundaries as values and are encoded straight from their class, so a
 * `WarehouseQueryError` becoming a 502 used to leave no log line, no span attribute and no
 * exception event — every `/internal/query-engine/*` 500 was invisible. Defects are handled by the
 * boundary's own `catchDefect`; this covers the failures it deliberately lets through.
 */
export const observeServerError =
	(endpoint: HttpApiEndpoint.Top, group: HttpApiGroup.Top) =>
	(error: unknown): Effect.Effect<void> => {
		const status = declaredStatus(endpoint, error)
		if (status === undefined || status < 500) return Effect.void
		const tag = tagOf(error)
		return Effect.annotateCurrentSpan({
			"error.type": tag,
			"http.response.status_code": status,
		}).pipe(
			Effect.andThen(
				Effect.logError("Route answered with a server error").pipe(
					Effect.annotateLogs({
						errorTag: tag,
						status,
						group: group.identifier,
						operation: endpoint.identifier,
						message: messageOf(error),
						cause: error,
					}),
				),
			),
		)
	}
