import { Effect, Schema, Stream } from "effect"
import type { HttpServerRequest } from "effect/http"

export class RequestBodyTooLargeError extends Schema.TaggedError<RequestBodyTooLargeError>()(
	"@maple/backend/http/RequestBodyTooLargeError",
	{ message: Schema.String, maxBytes: Schema.Number },
) {}

export class RequestBodyReadError extends Schema.TaggedError<RequestBodyReadError>()(
	"@maple/backend/http/RequestBodyReadError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * A request body as UTF-8 text, refused once it passes `maxBytes`. A declared `content-length`
 * over the limit fails before anything is read; the running byte count catches chunked bodies.
 */
export const readBoundedText = (
	request: HttpServerRequest.HttpServerRequest,
	maxBytes: number,
): Effect.Effect<string, RequestBodyTooLargeError | RequestBodyReadError> =>
	Effect.suspend(() => {
		const tooLarge = new RequestBodyTooLargeError({
			message: `Request body exceeds ${maxBytes} bytes`,
			maxBytes,
		})
		const declared = Number(request.headers["content-length"] ?? Number.NaN)
		if (Number.isFinite(declared) && declared > maxBytes) return Effect.fail(tooLarge)
		const decoder = new TextDecoder()
		return Stream.runFoldEffect(
			request.stream.pipe(
				Stream.mapError(
					(cause) =>
						new RequestBodyReadError({ message: "Could not read the request body", cause }),
				),
			),
			() => ({ bytes: 0, text: "" }),
			(read, chunk: Uint8Array) =>
				read.bytes + chunk.byteLength > maxBytes
					? Effect.fail(tooLarge)
					: Effect.succeed({
							bytes: read.bytes + chunk.byteLength,
							text: read.text + decoder.decode(chunk, { stream: true }),
						}),
		).pipe(Effect.map(({ text }) => text + decoder.decode()))
	})
