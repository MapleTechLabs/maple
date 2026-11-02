import { describe, expect, it } from "@effect/vitest"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts"
import { Stack } from "alchemy/Stack"
import { Provider } from "alchemy/Provider"
import * as Core from "alchemy/Test/Core"
import * as State from "alchemy/State"
import { ConfigProvider, Effect } from "effect"
import { resolve } from "node:path"
import { Local, localProviders } from "../src/Local"
import { localConfig } from "../src/LocalConfig"

const identity = { dotAlchemy: "/project/.alchemy", stack: "app", stage: "dev", fqn: "observability" }

describe("Maple.Local configuration", () => {
	it("uses stable isolated storage per project, stack, stage and namespace", () => {
		const config = localConfig({}, identity)
		expect(config).toEqual(localConfig({}, identity))
		expect(config.port).toBeUndefined()
	expect(localConfig({ port: 5000 }, identity).port).toBe(5000)
		expect(config.onDirtyStore).toBe("fail")
		expect(config.dataDir.startsWith("/project/.alchemy/maple-local/")).toBe(true)
		for (const changed of [
			{ dotAlchemy: "/another-project/.alchemy" },
			{ stack: "another-app" },
			{ stage: "preview" },
			{ fqn: "namespace/observability" },
		]) {
			expect(localConfig({}, { ...identity, ...changed }).dataDir).not.toBe(config.dataDir)
		}
	})

	it("resolves explicit storage, port and dirty-store policy", () => {
		expect(localConfig({ dataDir: "./local-maple", port: 4320, onDirtyStore: "wipe" }, identity)).toEqual(
			{
				dataDir: resolve("./local-maple"),
				port: 4320,
				onDirtyStore: "wipe",
			},
		)
	})
})

describe("Maple.Local providers", () => {
	it.effect("registers independently of cloud auth and lazily selects local mode", () =>
		Effect.gen(function* () {
			const provider = yield* Provider<Local>(Local.Type)
			expect(provider.mode).toBe("local")
			// Registration must not resolve a runtime, open a store or acquire cloud credentials.
		}).pipe(
			Effect.provide(localProviders()),
			Effect.provideService(AlchemyContext, { ...identity, dev: true, adopt: false }),
			Effect.provideService(Stack, {
				name: "test",
				stage: "test",
				resources: {},
				bindings: {},
				actions: {},
			}),
			Effect.provideServiceEffect(ArtifactStore, Effect.sync(createArtifactStore)),
			Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
			Effect.scoped,
		),
	)

	it.live("shares one declaration and returns unavailable local outputs on deploy", () => {
		const options = {
			providers: localProviders(),
			state: State.inMemoryState(),
			stage: "test",
			adopt: false,
			dev: false,
		}
		const stack = Core.scratchStack(options, "maple-local-live")
		const shared = Local("observability")
		return Core.toEffect(
			Effect.gen(function* () {
				const outputs = yield* stack.deploy(
					Effect.gen(function* () {
						const first = yield* shared
						const second = yield* shared
						expect(first).toBe(second)
						return {
							endpoint: first.endpoint,
							dashboardUrl: first.dashboardUrl,
							dataDir: first.dataDir,
						}
					}),
				)
				expect(outputs).toEqual({ endpoint: undefined, dashboardUrl: undefined, dataDir: undefined })
				yield* stack.destroy()
			}),
			options,
		)
	})
})
