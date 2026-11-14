import { Schema } from "effect"
import { describe, expect, test, vi } from "vitest"

// The shell's favorites listener targets `window` at import.
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import { Flags } from "./main"
import * as Shell from "./shell"

describe("Flags", () => {
	test("flags that went through the codec still carry every shell flag the init reads", () => {
		const decoded = Schema.decodeSync(Flags)({
			hasStoredSession: false,
			timeZone: "UTC",
			knownToRenderApp: {},
			shell: {
				isSidebarOpen: false,
				isMobile: false,
				theme: "light",
				pinnedNamespaces: {},
				dashboardFavorites: [],
				platform: "windows",
			},
		})

		expect(Shell.init(decoded.shell)).toMatchObject({ platform: "windows", isSidebarOpen: false })
	})
})
