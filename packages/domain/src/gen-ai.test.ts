import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { MAPLE_AI_STAMP_ATTRS } from "./gen-ai"

// The ingest gateway writes these keys and every reader here reads them, and
// nothing at runtime reconciles the two: a key renamed on one side reads as
// every span materializing with no model, no calls and no usage. So the
// literals are pinned against the Rust sources that write them.
const gatewaySource = ["facts.rs", "usage.rs"]
	.map((file) =>
		readFileSync(new URL(`../../../apps/ingest/src/ai_session/${file}`, import.meta.url), "utf8"),
	)
	.join("\n")

describe("MAPLE_AI_STAMP_ATTRS", () => {
	it.each(Object.values(MAPLE_AI_STAMP_ATTRS))("is written by the ingest gateway: %s", (key) => {
		expect(gatewaySource).toContain(`&str = "${key}";`)
	})
})
