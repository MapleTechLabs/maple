import { describe, expect, it } from "vitest"

import { sdkSnippets } from "./sdk-snippets"

describe("sdkSnippets", () => {
	it.each(sdkSnippets.map((s) => [s.language, s.instrument]))(
		"%s reads the private key from MAPLE_INGEST_KEY instead of inlining a key",
		(_, instrument) => {
			expect(instrument).toContain("MAPLE_INGEST_KEY")
			expect(instrument).not.toMatch(/\{\{API_KEY\}\}|maple_[ps]k_[a-z0-9]/)
		},
	)
})
