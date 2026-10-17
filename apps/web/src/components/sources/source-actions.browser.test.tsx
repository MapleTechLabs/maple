// TEST-SEAM: the atom client and the list atom are process-global wiring with no
// instance-level injection seam, so the hooks are replaced at the module boundary.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { Exit, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { V2Source } from "@maple/domain/http/v2"

const mutations = {
	pause: vi.fn(async (_input: { payload: { until: string | null } }) => Exit.succeed({})),
	resume: vi.fn(async (_input: unknown) => Exit.succeed({})),
	roll: vi.fn(async (_input: unknown) => Exit.succeed({ secret: "maple_src_rolledToken0000000000000000" })),
	delete: vi.fn(async (_input: unknown) => Exit.succeed({})),
}

vi.mock("@/lib/effect-atom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/effect-atom")>()
	return {
		...actual,
		useAtomRefresh: () => () => {},
		useAtomSet: (name: keyof typeof mutations) => mutations[name],
	}
})
vi.mock("@/lib/services/common/v2-atom-client", () => ({
	MapleApiV2AtomClient: { mutation: (_group: string, name: string) => name },
}))
vi.mock("@/lib/services/atoms/sources-atoms", () => ({ sourcesListAtom: "list" }))

import { SourceActions } from "./source-actions"

const decodeSource = Schema.decodeUnknownSync(V2Source)
const base = {
	id: "src_aXunrkWtzvXSkw9Z2smcft",
	object: "source",
	name: "Checkout API",
	description: null,
	platform: "nodejs",
	is_default: false,
	key_prefix: "maple_src_Q7xZa",
	status: "active",
	allowed_signals: null,
	rate_limit_rps: null,
	resource_attributes: [],
	expires_at: null,
	paused_at: null,
	paused_until: null,
	last_used_at: null,
	rolled_at: "2026-07-01T12:00:00.000Z",
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-01T12:00:00.000Z",
	health: { status: "pending", last_data_at: null, problem: null },
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const renderActions = (source: V2Source, onRevealed = vi.fn()) => {
	render(<SourceActions source={source} onRevealed={onRevealed} onDeleted={vi.fn()} />)
	return onRevealed
}

describe("SourceActions", () => {
	it("pauses for an hour with an absolute deadline, and until resumed with none", async () => {
		renderActions(decodeSource(base))
		const before = Date.now()
		fireEvent.click(screen.getByRole("button", { name: "Pause" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "For 1 hour" }))
		await vi.waitFor(() => expect(mutations.pause).toHaveBeenCalledTimes(1))
		const until = new Date(mutations.pause.mock.calls[0]?.[0].payload.until ?? 0).getTime()
		expect(until - before).toBeGreaterThanOrEqual(3_600_000)
		expect(until - Date.now()).toBeLessThanOrEqual(3_600_000)

		cleanup()
		renderActions(decodeSource(base))
		fireEvent.click(screen.getByRole("button", { name: "Pause" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Until resumed" }))
		await vi.waitFor(() => expect(mutations.pause).toHaveBeenCalledTimes(2))
		expect(mutations.pause.mock.calls[1]?.[0]).toMatchObject({ payload: { until: null } })
	})

	it("offers resume on a paused source and hands a rolled token up", async () => {
		const onRevealed = renderActions(
			decodeSource({ ...base, status: "paused", paused_at: "2026-07-01T12:00:00.000Z" }),
		)
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Resume" }))
		await vi.waitFor(() => expect(mutations.resume).toHaveBeenCalledTimes(1))

		fireEvent.click(screen.getByRole("button", { name: "Roll token" }))
		const dialog = await screen.findByRole("alertdialog")
		fireEvent.click(within(dialog).getByRole("button", { name: "Roll token" }))
		await vi.waitFor(() =>
			expect(onRevealed).toHaveBeenCalledWith({
				sourceId: decodeSource(base).id,
				secret: "maple_src_rolledToken0000000000000000",
				rolled: true,
			}),
		)
	})
})
