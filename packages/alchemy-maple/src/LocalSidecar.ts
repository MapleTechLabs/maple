// Infrastructure-only entry. The Worker-safe telemetry module never imports it.
import { startLocal } from "@maple/local-server"
import { provisionLibchdb } from "@maple/local-server/libchdb-provision"
import { AlchemyContext } from "alchemy/AlchemyContext"
import type * as LocalProvider from "alchemy/Local/LocalProvider"
import type * as RpcServer from "alchemy/Local/RpcServer"
import { Stack } from "alchemy/Stack"
import * as Effect from "effect/Effect"
import { FetchHttpClient } from "effect/http"
import { LocalProviderLocal, type Local, type LocalSpec } from "./Local"
import { localConfig, type LocalConfig } from "./LocalConfig"

export const localSpec: LocalSpec = Effect.gen(function* () {
	const context = yield* AlchemyContext
	return {
		resolveConfig: Effect.fn(function* ({ news, fqn }) {
			const stack = yield* Stack
			return localConfig(news, {
				dotAlchemy: context.dotAlchemy,
				stack: stack.name,
				stage: stack.stage,
				fqn,
			})
		}),
		start: Effect.fn(function* ({ config }) {
			// MAPLE_LIBCHDB wins; otherwise the pinned release, downloaded and verified
			// once into ~/.maple/cache, exactly as the `maple` release bundle gets it.
			const libchdb =
				process.env.MAPLE_LIBCHDB ||
				// The sidecar process's entry point: it owns its HTTP transport.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				(yield* provisionLibchdb().pipe(Effect.provide(FetchHttpClient.layer))).path
			const local = yield* startLocal({ ...config, libchdb })
			return {
				endpoint: local.endpoint,
				dashboardUrl: local.dashboardUrl,
				dataDir: local.dataDir,
			}
		}),
	} satisfies LocalProvider.LocalProviderSpec<Local, LocalConfig>
})

const providers: RpcServer.ProviderLayer = LocalProviderLocal()
export default providers
