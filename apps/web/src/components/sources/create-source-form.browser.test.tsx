// TEST-SEAM: the atom client is process-global wiring with no instance-level injection seam,
// so the hooks are replaced at the module boundary and the form is driven through its controls.
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Exit, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { V2SourceWithSecret } from "@maple/domain/http/v2"

type CreateResult = Exit.Exit<V2SourceWithSecret, never>

const createMutation = vi.fn<(input: { payload: Record<string, unknown> }) => Promise<CreateResult>>()

vi.mock("@/lib/effect-atom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/effect-atom")>()
	return { ...actual, useAtomRefresh: () => () => {}, useAtomSet: () => createMutation }
})
vi.mock("@/lib/services/common/v2-atom-client", () => ({
	MapleApiV2AtomClient: { mutation: (_group: string, name: string) => name },
}))
vi.mock("@/lib/services/atoms/sources-atoms", () => ({ sourcesListAtom: "list" }))

import { CreateSourceForm } from "./create-source-form"

const SECRET = "maple_src_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1"

const created = Schema.decodeUnknownSync(V2SourceWithSecret)({
	id: "src_aXunrkWtzvXSkw9Z2smcft",
	object: "source",
	name: "Checkout API",
	description: null,
	platform: "nodejs",
	is_default: false,
	key_prefix: "maple_src_Q7xZa",
	integration_id: null,
	status: "active",
	allowed_signals: ["traces", "logs", "sessions", "events"],
	rate_limit_rps: 50,
	resource_attributes: [{ key: "service.name", value: "checkout", mode: "default" }],
	expires_at: null,
	paused_at: null,
	paused_until: null,
	last_used_at: null,
	rolled_at: "2026-07-01T12:00:00.000Z",
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-01T12:00:00.000Z",
	health: { status: "pending", last_data_at: null, problem: null, resources: null },
	secret: SECRET,
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const typeInto = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } })
const submit = () => screen.getByRole("button", { name: "Create source" })

describe("CreateSourceForm", () => {
	it("creates with only a name, sending no rules", async () => {
		createMutation.mockResolvedValue(Exit.succeed(created))
		const onCreated = vi.fn()
		render(<CreateSourceForm platform="nodejs" onBack={vi.fn()} onCreated={onCreated} />)

		expect(screen.getByLabelText("Name")).toHaveProperty("value", "Node.js")
		typeInto(screen.getByLabelText("Name"), "Checkout API")
		fireEvent.click(submit())

		await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
		expect(createMutation).toHaveBeenCalledWith({
			payload: {
				name: "Checkout API",
				platform: "nodejs",
				allowed_signals: null,
				rate_limit_rps: null,
				resource_attributes: [],
				expires_at: null,
			},
		})
		const [source, revealed] = onCreated.mock.calls[0] ?? []
		expect(source).not.toHaveProperty("secret")
		expect(revealed).toEqual({ sourceId: created.id, secret: SECRET, rolled: false })
	})

	it("blocks reserved attributes and sends the advanced rules", async () => {
		createMutation.mockResolvedValue(Exit.succeed(created))
		render(<CreateSourceForm platform="nodejs" onBack={vi.fn()} onCreated={vi.fn()} />)
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }))

		fireEvent.click(await screen.findByRole("button", { name: "Add attribute" }))
		typeInto(screen.getByLabelText("Attribute key"), "Maple_Org_Id")
		typeInto(screen.getByLabelText("Attribute value"), "org_other")
		expect(submit()).toHaveProperty("disabled", true)
		expect(screen.getByRole("alert").textContent).toBe('"Maple_Org_Id" is reserved by Maple.')

		typeInto(screen.getByLabelText("Attribute key"), "service.name")
		typeInto(screen.getByLabelText("Attribute value"), "checkout")
		fireEvent.click(screen.getAllByRole("button", { name: "If missing" })[0] ?? document.body)
		fireEvent.click(screen.getByText("/v1/metrics"))
		typeInto(screen.getByLabelText("Rate limit"), "50")
		fireEvent.click(submit())

		await vi.waitFor(() => expect(createMutation).toHaveBeenCalledTimes(1))
		expect(createMutation.mock.calls[0]?.[0].payload).toMatchObject({
			allowed_signals: ["traces", "logs", "sessions", "events"],
			rate_limit_rps: 50,
			resource_attributes: [{ key: "service.name", value: "checkout", mode: "default" }],
		})
	})
})
