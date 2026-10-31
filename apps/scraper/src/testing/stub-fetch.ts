export interface RecordedRequest {
	readonly url: string
	readonly method: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: string | null
}

type Respond = (request: RecordedRequest, signal: AbortSignal | null) => Response | Promise<Response>

/** A `fetch` that records each request and answers with `respond`; no socket is opened. */
export const stubFetch = (recorded: Array<RecordedRequest>, respond: Respond) =>
	Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = Object.fromEntries(new Headers(init?.headers).entries())
			const raw = init?.body
			const body =
				typeof raw === "string"
					? raw
					: raw instanceof Uint8Array
						? new TextDecoder().decode(raw)
						: null
			const request: RecordedRequest = {
				url: input instanceof Request ? input.url : String(input),
				method: init?.method ?? "GET",
				headers,
				body,
			}
			recorded.push(request)
			return respond(request, init?.signal ?? null)
		},
		{ preconnect: () => {} },
	)

/** A response that never arrives; rejects once the request is aborted (a timeout). */
export const hang = (signal: AbortSignal | null): Promise<Response> =>
	new Promise((_, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason))
	})
