// TEST-SEAM: the atom client is process-global wiring with no instance-level injection seam,
// so the hooks are replaced at the module boundary and the form is driven through its controls.
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Exit, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { V2CustomIngestKeyWithSecret } from "@maple/domain/http/v2"

type CreateResult = Exit.Exit<V2CustomIngestKeyWithSecret, never>

const createMutation = vi.fn<(input: { payload: Record<string, unknown> }) => Promise<CreateResult>>()
const updateMutation = vi.fn(async () => Exit.succeed({}))

vi.mock("@/lib/effect-atom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/effect-atom")>()
	return {
		...actual,
		useAtomRefresh: () => () => {},
		useAtomSet: (atom: string) => (atom === "createCustom" ? createMutation : updateMutation),
	}
})
vi.mock("@/lib/services/common/v2-atom-client", () => ({
	MapleApiV2AtomClient: { mutation: (_group: string, name: string) => name },
}))
vi.mock("@/lib/services/atoms/ingestion-atoms", () => ({ customIngestKeysListAtom: "list" }))

import { IngestKeyForm } from "./key-form"

const SECRET = "maple_ik_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1"

const created = Schema.decodeUnknownSync(V2CustomIngestKeyWithSecret)({
	id: "ingk_aXunrkWtzvXSkw9Z2smcft",
	object: "custom_ingest_key",
	name: "Mobile app",
	description: null,
	key_prefix: "maple_ik_Q7xZa",
	status: "active",
	allowed_signals: ["traces", "logs", "sessions", "events"],
	rate_limit_rps: 50,
	resource_attributes: [{ key: "service.name", value: "mobile-app", mode: "default" }],
	expires_at: null,
	paused_at: null,
	paused_until: null,
	last_used_at: null,
	rolled_at: "2026-07-01T12:00:00.000Z",
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-01T12:00:00.000Z",
	secret: SECRET,
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const typeInto = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } })
const submit = () => screen.getByRole("button", { name: "Create key" })

describe("IngestKeyForm", () => {
	it("previews how each attribute lands, blocks reserved keys, and hands the one-time secret on", async () => {
		createMutation.mockResolvedValue(Exit.succeed(created))
		const onCreated = vi.fn()
		render(<IngestKeyForm mode={{ _tag: "create", onCreated }} onCancel={vi.fn()} />)

		typeInto(screen.getByLabelText("Name"), "Mobile app")
		const [, value] = [screen.getByLabelText("Attribute key"), screen.getByLabelText("Attribute value")]
		// The pre-filled service.name row has no value yet.
		expect(submit()).toHaveProperty("disabled", true)
		typeInto(value, "mobile-app")
		expect(submit()).toHaveProperty("disabled", false)

		// "If missing" keeps the sender's value; "Always" overwrites it.
		expect(screen.getByText("kept, sender set it")).toBeDefined()
		fireEvent.click(screen.getAllByRole("button", { name: "Always" })[0] ?? document.body)
		expect(screen.getByText("checkout-api → mobile-app")).toBeDefined()
		fireEvent.click(screen.getAllByRole("button", { name: "If missing" })[0] ?? document.body)

		fireEvent.click(screen.getByRole("button", { name: "Add attribute" }))
		const [, secondKey] = screen.getAllByLabelText("Attribute key")
		const [, secondValue] = screen.getAllByLabelText("Attribute value")
		if (secondKey === undefined || secondValue === undefined) throw new Error("second row missing")
		typeInto(secondKey, "Maple_Org_Id")
		typeInto(secondValue, "org_other")
		expect(submit()).toHaveProperty("disabled", true)
		expect(screen.getByRole("alert").textContent).toBe('"Maple_Org_Id" is reserved by Maple.')
		fireEvent.click(screen.getAllByRole("button", { name: "Remove attribute" })[1] ?? document.body)

		fireEvent.click(screen.getByText("/v1/metrics"))
		typeInto(screen.getByLabelText("Rate limit"), "50")
		fireEvent.click(submit())

		await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
		expect(createMutation).toHaveBeenCalledWith({
			payload: {
				name: "Mobile app",
				description: null,
				allowed_signals: ["traces", "logs", "sessions", "events"],
				rate_limit_rps: 50,
				resource_attributes: [{ key: "service.name", value: "mobile-app", mode: "default" }],
				expires_at: null,
			},
		})
		const [key, revealed] = onCreated.mock.calls[0] ?? []
		expect(key).not.toHaveProperty("secret")
		expect(revealed).toEqual({ keyId: created.id, secret: SECRET, rolled: false })
	})
})
