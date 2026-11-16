import {
	v2WorkerUnavailableBody,
	v2WorkerUnavailableDefinition,
} from "@maple/domain/http/v2-worker-unavailable"

/** Canonical v2 fallback used when the route graph could not finish bootstrapping. */
export const v2WorkerUnavailableResponse = (): Response => {
	const definition = v2WorkerUnavailableDefinition
	return Response.json(
		{ error: v2WorkerUnavailableBody() },
		{
			status: definition.status,
			headers: { "retry-after": String(definition.retryAfterSeconds) },
		},
	)
}

/** The v2 envelope for an anonymous share body refused before the route graph decodes it. */
export const v2ShareBodyTooLargeResponse = (
	headers: Readonly<Record<string, string>>,
	maxBytes: number,
): Response =>
	Response.json(
		{
			error: {
				_tag: "@maple/http/v2/PayloadTooLargeError",
				type: "invalid_request_error",
				code: "payload_too_large",
				title: "Request body too large",
				message: `Share requests must send a Content-Length of at most ${maxBytes} bytes.`,
				retryable: false,
				recovery: "fix_request",
			},
		},
		{ status: 413, headers },
	)
