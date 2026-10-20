// TEST-SEAM: the atom client and the list atom are process-global wiring with no
// instance-level injection seam, so the hooks are replaced at the module boundary.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Exit, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { V2Source } from "@maple/domain/http/v2"

const update = vi.fn(async (_input: { payload: Record<string, unknown> }) => Exit.succeed({}))

vi.mock("@/lib/effect-atom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/effect-atom")>()
	return { ...actual, useAtomRefresh: () => () => {}, useAtomSet: () => update }
})
vi.mock("@/lib/services/common/v2-atom-client", () => ({
	MapleApiV2AtomClient: { mutation: (_group: string, name: string) => name },
}))
vi.mock("@/lib/services/atoms/sources-atoms", () => ({ sourcesListAtom: "list" }))

import { SourceSettings } from "./source-settings"

const decodeSource = Schema.decodeUnknownSync(V2Source)
const source = (overrides: Record<string, unknown>) =>
	decodeSource({
		id: "src_aXunrkWtzvXSkw9Z2smcft",
		object: "source",
		name: "Checkout API",
		description: null,
		platform: "nodejs",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
		status: "active",
		allowed_signals: ["traces"],
		rate_limit_rps: null,
		resource_attributes: [],
		expires_at: "2030-01-01T00:00:00.000Z",
		paused_at: null,
		paused_until: null,
		last_used_at: null,
		rolled_at: "2026-07-01T12:00:00.000Z",
		created_at: "2026-07-01T12:00:00.000Z",
		updated_at: "2026-07-01T12:00:00.000Z",
		health: { status: "pending", last_data_at: null, problem: null, resources: null },
		...overrides,
	})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const save = async () => {
	fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
	await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
	return update.mock.calls[0]?.[0].payload
}

describe("SourceSettings", () => {
	it("keeps a stored expiry untouched unless the choice changes", async () => {
		render(<SourceSettings source={source({})} />)
		const payload = await save()
		expect(payload).not.toHaveProperty("expires_at")
		expect(payload).toMatchObject({ name: "Checkout API", allowed_signals: ["traces"] })
	})

	it("clears the expiry when Never is chosen", async () => {
		render(<SourceSettings source={source({})} />)
		fireEvent.click(screen.getByRole("button", { name: "Never" }))
		expect(await save()).toMatchObject({ expires_at: null })
	})

	it("sends only the name and description for the default source", async () => {
		render(
			<SourceSettings
				source={source({
					is_default: true,
					key_prefix: null,
					integration_id: null,
					expires_at: null,
					allowed_signals: null,
				})}
			/>,
		)
		expect(await save()).toEqual({ name: "Checkout API", description: null })
	})
})
