/**
 * One cron fire: drain the org erasure outbox. Imported on the first fire, so the service graph
 * stays off the Worker's startup.
 */
import type * as Cloudflare from "@alchemy.run/cloudflare"
import { ReplayBlobEraser, SourceMapEraser } from "@maple/backend/platform/bindings"
import { type ChatSessionNamespace, layerChatSessions } from "@maple/backend/platform/chat-sessions"
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { layerMapleDbConnection } from "@maple/backend/platform/pg-connection-source"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { runOrgErasures } from "@maple/backend/services/org/org-erasure"
import { WarehouseDeleteClient } from "@maple/backend/services/warehouse/WarehouseDeleteClient"
import { WarehouseDeleteToken } from "@maple/infra/secrets"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { prefixEraser } from "./replay-eraser.ts"

export const runTick = (
	env: Record<string, unknown>,
	chatSessions: ChatSessionNamespace,
	replayBlobs: Cloudflare.R2.ReadWriteBucketClient,
	sourceMaps: Cloudflare.R2.ReadWriteBucketClient,
) => {
	const config = workerEnvLayer(env)
	const connection = layerMapleDbConnection(env)
	const ports = Layer.mergeAll(
		DatabasePgLive.pipe(Layer.provide(connection)),
		connection,
		layerChatSessions(chatSessions, env),
		Layer.succeed(ReplayBlobEraser, prefixEraser(replayBlobs)),
		Layer.succeed(SourceMapEraser, prefixEraser(sourceMaps)),
		WarehouseDeleteClient.layer.pipe(
			Layer.provide([WarehouseDeleteToken.layer, FetchHttpClient.layer]),
			Layer.provide(config),
		),
	)
	// The fire is the boundary this graph belongs to.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	return withPgConnectionScope(runOrgErasures).pipe(Effect.provide(ports))
}
