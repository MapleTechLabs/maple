/**
 * Internal Code Mode endpoints — server-to-server, NOT exposed to external MCP
 * clients. Both authenticate with the internal-service token (`Bearer
 * maple_svc_<INTERNAL_SERVICE_TOKEN>`) and pin the org out-of-band in `x-org-id`,
 * exactly like the chat-flue `submit_diagnosis` write.
 *
 *   POST /internal/codemode/run   { code }            → run a snippet for the org
 *   POST /internal/codemode/tool  { name, arguments } → run a single tool (called
 *                                                        back by the runtime DO)
 *
 * `run` resolves the org's {@link CodemodeRuntimeDO} (one per org) and executes the
 * snippet there. `tool` runs one MCP tool by name with the full `MainLive` service
 * layer — the tool handler resolves its own tenant from the request (the same
 * `maple_svc_` + `x-org-id` path the `/mcp` server uses), so this route is a thin
 * decode-and-run, mirroring `POST /api/chat/apply`.
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Env } from "../lib/Env"
import { isValidInternalBearer } from "../lib/internal-auth"
import { mapleToolDefinitions } from "../mcp/tools/registry"
import type { McpToolResult } from "../mcp/tools/types"

/** Minimal view of the per-org runtime DO namespace + stub (typed against `CodemodeRuntimeDO.run`). */
interface CodemodeRuntimeStub {
	readonly run: (orgId: string, code: string) => Promise<unknown>
}
interface CodemodeRuntimeNamespace {
	idFromName(name: string): unknown
	get(id: unknown): CodemodeRuntimeStub
}

const INTERNAL_SERVICE_PREFIX = "maple_svc_"

const json = (body: unknown, status = 200) =>
	HttpServerResponse.json(body, { status }).pipe(Effect.orDie)

const errorResult = (label: string, message: string): McpToolResult => ({
	isError: true,
	content: [{ type: "text", text: `${label}: ${message}` }],
})

/** Verify `Authorization: Bearer maple_svc_<INTERNAL_SERVICE_TOKEN>`. Returns a 401 response when invalid. */
const guardInternal = Effect.fn("CodemodeInternal.guard")(function* (
	request: HttpServerRequest.HttpServerRequest,
) {
	const env = yield* Env
	const expected = Option.match(env.INTERNAL_SERVICE_TOKEN, {
		onNone: () => undefined,
		onSome: Redacted.value,
	})
	const header = request.headers.authorization
	// The bearer is `maple_svc_<token>`; strip the prefix before the constant-time compare.
	const stripped =
		header?.startsWith(`Bearer ${INTERNAL_SERVICE_PREFIX}`) === true
			? `Bearer ${header.slice(`Bearer ${INTERNAL_SERVICE_PREFIX}`.length)}`
			: header
	if (!expected || !isValidInternalBearer(stripped, expected)) {
		// `HttpServerResponse.text` returns a plain response (no failure channel).
		return Option.some(HttpServerResponse.text("Unauthorized", { status: 401 }))
	}
	return Option.none<HttpServerResponse.HttpServerResponse>()
})

export const CodemodeInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const runSnippet = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const denied = yield* guardInternal(request)
			if (Option.isSome(denied)) return denied.value

			const orgId = request.headers["x-org-id"]
			if (!orgId) return yield* json({ status: "error", error: "x-org-id header is required" }, 400)

			const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
			const code = (body as { code?: unknown } | null)?.code
			if (typeof code !== "string" || code.trim() === "") {
				return yield* json({ status: "error", error: "Body must include a non-empty `code` string" }, 400)
			}

			const env = yield* WorkerEnvironment
			const namespace = env.CODEMODE_RUNTIME as CodemodeRuntimeNamespace | undefined
			if (!namespace) {
				return yield* json({
					status: "error",
					executionId: "",
					error: "Code mode is unavailable: the CODEMODE_RUNTIME binding is not configured.",
				})
			}

			const stub = namespace.get(namespace.idFromName(orgId))
			const output = yield* Effect.tryPromise({
				try: () => stub.run(orgId, code),
				catch: (error) => error,
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({
						status: "error",
						executionId: "",
						error: `Code mode run failed: ${error instanceof Error ? error.message : String(error)}`,
					}),
				),
			)
			return yield* json(output)
		}).pipe(Effect.withSpan("CodemodeInternal.run"))

		const runTool = Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const denied = yield* guardInternal(request)
			if (Option.isSome(denied)) return denied.value

			const body = yield* request.json.pipe(Effect.orElseSucceed(() => null))
			const name = (body as { name?: unknown } | null)?.name
			const args = (body as { arguments?: unknown } | null)?.arguments ?? {}
			if (typeof name !== "string") {
				return yield* json(errorResult("InvalidRequest", "Body must include a string `name`"), 400)
			}

			const definition = mapleToolDefinitions.find((d) => d.name === name)
			if (!definition) {
				return yield* json(errorResult("UnknownTool", `Unknown tool "${name}"`), 200)
			}

			const decoded = yield* Effect.try({
				try: () => Schema.decodeUnknownSync(definition.schema)(args),
				catch: (error) => error,
			}).pipe(Effect.option)
			if (Option.isNone(decoded)) {
				return yield* json(errorResult("InvalidInput", `Invalid input for "${name}"`), 200)
			}

			// Run the real tool. Mirror the MCP server / chat apply: domain-level tool
			// failures become an `isError` result carrying the message rather than a
			// transport error, so the sandbox snippet can read it.
			const result = yield* definition.handler(decoded.value).pipe(
				Effect.catchTags({
					"@maple/mcp/errors/McpQueryError": (e) => Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpTenantError": (e) => Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpAuthMissingError": (e) => Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpAuthInvalidError": (e) => Effect.succeed(errorResult(e._tag, e.message)),
					"@maple/mcp/errors/McpInvalidTenantError": (e) =>
						Effect.succeed(errorResult(`${e._tag} (${e.field})`, e.message)),
				}),
				Effect.catchDefect((defect) =>
					Effect.succeed(errorResult("Error", defect instanceof Error ? defect.message : String(defect))),
				),
			)

			return yield* json({
				content: result.content.map((entry) => entry.text).join("\n"),
				...(result.isError === true ? { isError: true } : {}),
			})
		}).pipe(Effect.withSpan("CodemodeInternal.tool"))

		yield* router.add("POST", "/internal/codemode/run", runSnippet)
		yield* router.add("POST", "/internal/codemode/tool", runTool)
	}),
)
