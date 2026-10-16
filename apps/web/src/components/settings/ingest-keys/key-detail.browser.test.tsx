// TEST-SEAM: the atom client and the list atom are process-global wiring with no
// instance-level injection seam, so the hooks are replaced at the module boundary.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { Exit, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { V2CustomIngestKey } from "@maple/domain/http/v2"

const mutations = {
	pauseCustom: vi.fn(async (_input: { payload: { until: string | null } }) => Exit.succeed({})),
	resumeCustom: vi.fn(async (_input: unknown) => Exit.succeed({})),
	rollCustom: vi.fn(async (_input: unknown) =>
		Exit.succeed({ secret: "maple_ik_rolledSecret000000000000000000" }),
	),
	deleteCustom: vi.fn(async (_input: unknown) => Exit.succeed({})),
}
interface ListState {
	key: V2CustomIngestKey | null
}
const state: ListState = { key: null }

vi.mock("@/lib/effect-atom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/effect-atom")>()
	return {
		...actual,
		useAtomValue: (atom: string) =>
			atom === "list"
				? actual.Result.success({ data: state.key === null ? [] : [state.key] })
				: actual.Result.success({
						object: "custom_ingest_key_usage",
						window_start: "2026-07-14T10:00:00.000Z",
						window_end: "2026-07-15T10:00:00.000Z",
						buckets: [],
					}),
		useAtomRefresh: () => () => {},
		useAtomSet: (name: keyof typeof mutations) => mutations[name],
	}
})
vi.mock("@/lib/services/common/v2-atom-client", () => ({
	MapleApiV2AtomClient: { mutation: (_group: string, name: string) => name },
	retainedQueryV2: () => "usage",
}))
vi.mock("@/lib/services/atoms/ingestion-atoms", () => ({ customIngestKeysListAtom: "list" }))
vi.mock("@tanstack/react-router", () => ({ Link: (props: { children?: unknown }) => props.children }))

import { IngestKeyDetail } from "./key-detail"

const decodeKey = Schema.decodeUnknownSync(V2CustomIngestKey)
const baseKey = {
	id: "ingk_aXunrkWtzvXSkw9Z2smcft",
	object: "custom_ingest_key",
	name: "Mobile app",
	description: null,
	key_prefix: "maple_ik_Q7xZa",
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
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const renderDetail = (key: V2CustomIngestKey, onRevealed = vi.fn()) => {
	state.key = key
	render(
		<IngestKeyDetail
			keyId={key.id}
			revealed={null}
			onRevealed={onRevealed}
			onConfigure={vi.fn()}
			onDeleted={vi.fn()}
		/>,
	)
	return onRevealed
}

describe("IngestKeyDetail", () => {
	it("pauses for an hour with an absolute deadline, and until resumed with none", async () => {
		renderDetail(decodeKey(baseKey))
		const before = Date.now()

		fireEvent.click(screen.getByRole("button", { name: "Pause" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "For 1 hour" }))
		await vi.waitFor(() => expect(mutations.pauseCustom).toHaveBeenCalledTimes(1))
		const until = new Date(mutations.pauseCustom.mock.calls[0]?.[0].payload.until ?? 0).getTime()
		expect(until - before).toBeGreaterThanOrEqual(3_600_000)
		expect(until - Date.now()).toBeLessThanOrEqual(3_600_000)

		cleanup()
		renderDetail(decodeKey(baseKey))
		fireEvent.click(screen.getByRole("button", { name: "Pause" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Until I resume" }))
		await vi.waitFor(() => expect(mutations.pauseCustom).toHaveBeenCalledTimes(2))
		expect(mutations.pauseCustom.mock.calls[1]?.[0]).toMatchObject({ payload: { until: null } })
	})

	it("offers resume on a paused key and hands a rolled secret up", async () => {
		const onRevealed = renderDetail(
			decodeKey({ ...baseKey, status: "paused", paused_at: "2026-07-01T12:00:00.000Z" }),
		)

		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Resume now" }))
		await vi.waitFor(() => expect(mutations.resumeCustom).toHaveBeenCalledTimes(1))

		fireEvent.click(screen.getByRole("button", { name: "Roll secret" }))
		const dialog = await screen.findByRole("alertdialog")
		fireEvent.click(within(dialog).getByRole("button", { name: "Roll secret" }))
		await vi.waitFor(() =>
			expect(onRevealed).toHaveBeenCalledWith({
				keyId: state.key?.id,
				secret: "maple_ik_rolledSecret000000000000000000",
				rolled: true,
			}),
		)
	})
})
