import { describe, expect, test } from "vitest"
import { init } from "./gcp-connections-lab"

const NOW = Date.UTC(2026, 9, 18, 12)
const opened = () => init({ nowMs: NOW, timeZone: "UTC" }).model

describe("gcp connections lab", () => {
	test("each card gets its own connection id, so its menu and dialogs stay its own", () => {
		const ids = opened().connectors.map((connector) => connector.id)
		expect(new Set(ids).size).toBe(ids.length)
	})
})
