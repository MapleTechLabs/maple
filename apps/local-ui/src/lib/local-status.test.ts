import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"
import { probeLocalStatus, type StatusProbe } from "./local-status"

type Responder = (
	request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>

const probeWith = (respond: Responder, timeoutMs = 200): Promise<StatusProbe> =>
	Effect.runPromise(
		probeLocalStatus("http://127.0.0.1:4318", timeoutMs).pipe(
			Effect.provideService(
				HttpClient.HttpClient,
				HttpClient.make((request) => respond(request)),
			),
		),
	)

const reply =
	(body: string, status: number): Responder =>
	(request) =>
		Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })))

const STATUS = {
	service: "maple-local",
	pid: 42,
	version: "0.9.0",
	url: "http://127.0.0.1:4318",
	dataDir: "/tmp/maple",
	lastIngestAtMs: 1_780_000_000_000,
}

describe("probeLocalStatus", () => {
	it("decodes a status answer", async () => {
		expect(await probeWith(reply(JSON.stringify(STATUS), 200))).toEqual({ _tag: "Ok", status: STATUS })
	})

	it("reads a 404 as a binary that predates /local/status", async () => {
		expect(await probeWith(reply("not found", 404))).toEqual({ _tag: "Legacy" })
	})

	it("keeps the status and detail of a refusal", async () => {
		expect(await probeWith(reply("browser origin not allowed\n", 403))).toEqual({
			_tag: "Rejected",
			status: 403,
			detail: "browser origin not allowed",
		})
	})

	it("reads a transport failure as nothing listening", async () => {
		const refused: Responder = (request) =>
			Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({ request }),
				}),
			)
		expect(await probeWith(refused)).toEqual({ _tag: "Refused" })
	})

	it("reads a hung request as busy, not down", async () => {
		expect(await probeWith(() => Effect.never, 20)).toEqual({ _tag: "Busy" })
	})

	it("reads an unexpected body as a rejection instead of throwing", async () => {
		const probe = await probeWith(reply("<html>", 200))
		expect(probe._tag).toBe("Rejected")
	})
})
