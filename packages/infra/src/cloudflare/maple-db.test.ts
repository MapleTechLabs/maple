import * as Output from "alchemy/Output"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { mapleDbEnv, refMapleDbHyperdrives } from "./maple-db.ts"
import type { MapleDbResources } from "./stack.ts"
import { type MapleDbConsumer, parseMapleStage, resolveHyperdriveRefId } from "./stage.ts"
import { MAPLE_DB_BINDING } from "./worker-runtime.ts"

const CONSUMERS: ReadonlyArray<MapleDbConsumer> = ["api", "ai", "alerting", "chat-bot"]

const login = { id: Output.literal("role"), url: Output.literal(Redacted.make("postgres://role")) }

const usPrdDb = (): MapleDbResources => ({
	branch: Output.literal("main"),
	hyperdrives: refMapleDbHyperdrives(parseMapleStage("prd")),
	ingest: login,
	electric: undefined,
})

describe("US prd MAPLE_DB", () => {
	// A lookup binds under its config id unless it is bound by name; the Workers read `MAPLE_DB`.
	it.each(CONSUMERS)("binds %s's dashboard config as MAPLE_DB", (consumer) => {
		const binding = mapleDbEnv(usPrdDb(), consumer)?.[MAPLE_DB_BINDING]
		expect(binding?.Type).toBe("Cloudflare.Hyperdrive")
		expect(binding?.LogicalId).toBe(resolveHyperdriveRefId(parseMapleStage("prd"), consumer))
	})

	it("gives alerting its own config and the rest api's", () => {
		const idOf = (consumer: MapleDbConsumer) =>
			mapleDbEnv(usPrdDb(), consumer)?.[MAPLE_DB_BINDING]?.LogicalId
		expect(idOf("alerting")).not.toBe(idOf("api"))
		expect([idOf("ai"), idOf("chat-bot")]).toEqual([idOf("api"), idOf("api")])
	})

	it("looks up nothing on stages without dashboard configs", () => {
		expect(refMapleDbHyperdrives(parseMapleStage("pr-123"))).toBeUndefined()
		expect(refMapleDbHyperdrives(parseMapleStage("dev_makisuo"))).toBeUndefined()
	})
})
