/** Offline probe of maple-ai's real request graphs. Every external call fails instead of running. */
import { Context, Effect, Layer } from "effect"
import { WorkerPlatformLive } from "@maple/infra/worker-http"
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { buildApp, buildMcpApp } from "../../src/worker/http"
import { offlinePorts } from "../../test/offline-http-ports"

/** The route graph the first request builds: `/mcp`'s own, or the rest. */
export const build = (graph: "mcp" | "full") =>
	Effect.runPromise((graph === "mcp" ? buildMcpApp : buildApp)(Context.empty(), offlinePorts))

/** The tool executor graph the first `tools/*` request imports and builds. */
export const buildTools = () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { McpServicesLive } = yield* Effect.promise(
				() => import("../../src/runtime/mcp-service-graph"),
			)
			return yield* Layer.build(
				McpServicesLive.pipe(
					Layer.provide(WorkerPlatformLive),
					Layer.provide(DatabasePgLive),
					Layer.provide(offlinePorts),
				),
			)
		}).pipe(Effect.scoped),
	)
