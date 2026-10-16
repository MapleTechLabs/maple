// TEST-SEAM: the atom client and the list atom are process-global wiring with no
// instance-level injection seam, so the hooks are replaced at the module boundary
// and the section is exercised through its rendered controls.
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Exit, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { V2CustomIngestKeyWithSecret } from "@maple/domain/http/v2"

type CreateResult = Exit.Exit<V2CustomIngestKeyWithSecret, never>

const createMutation = vi.fn<(input: { payload: Record<string, unknown> }) => Promise<CreateResult>>()
const otherMutation = vi.fn(async () => Exit.succeed({}))

vi.mock("@/lib/effect-atom", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/effect-atom")>()
	return {
		...actual,
		useAtomValue: () => actual.Result.success({ data: [] }),
		useAtomRefresh: () => () => {},
		useAtomSet: (atom: string) => (atom === "createCustom" ? createMutation : otherMutation),
	}
})
vi.mock("@/lib/services/common/v2-atom-client", () => ({
	MapleApiV2AtomClient: { mutation: (_group: string, name: string) => name },
}))
vi.mock("@/lib/services/atoms/ingestion-atoms", () => ({ customIngestKeysListAtom: "list" }))

import { CustomIngestKeysSection } from "./custom-ingest-keys-section"

const SECRET = "maple_ik_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1"

const created = Schema.decodeUnknownSync(V2CustomIngestKeyWithSecret)({
	id: "ingk_aXunrkWtzvXSkw9Z2smcft",
	object: "custom_ingest_key",
	name: "Checkout staging",
	description: null,
	key_prefix: "maple_ik_Q7xZa",
	enabled: true,
	allowed_signals: null,
	rate_limit_rps: null,
	resource_attributes: [{ key: "service.name", value: "checkout", mode: "default" }],
	expires_at: null,
	rolled_at: "2026-07-01T12:00:00.000Z",
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-01T12:00:00.000Z",
	secret: SECRET,
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

const submitButton = () =>
	screen.getAllByRole("button", { name: "Create key" }).find((button) => button.closest("[role=dialog]"))

const typeInto = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } })

describe("CustomIngestKeysSection", () => {
	it("blocks submit on a valueless, reserved or duplicate attribute, then reveals the one-time secret", async () => {
		createMutation.mockResolvedValue(Exit.succeed(created))
		render(<CustomIngestKeysSection />)

		const [openCreate] = screen.getAllByRole("button", { name: "Create key" })
		if (openCreate) fireEvent.click(openCreate)
		typeInto(await screen.findByLabelText("Name"), "Checkout staging")

		// The pre-filled service.name row has no value yet.
		expect(submitButton()).toHaveProperty("disabled", true)
		expect(screen.getByText('Give "service.name" a value, or remove it.')).toBeDefined()

		const [key] = screen.getAllByLabelText("Attribute key")
		const [value] = screen.getAllByLabelText("Attribute value")
		if (key === undefined || value === undefined) throw new Error("attribute row missing")
		typeInto(value, "checkout")
		expect(submitButton()).toHaveProperty("disabled", false)

		typeInto(key, "Maple_Org_Id")
		expect(submitButton()).toHaveProperty("disabled", true)
		expect(screen.getByText('"Maple_Org_Id" is reserved by Maple.')).toBeDefined()
		typeInto(key, "service.name")

		fireEvent.click(screen.getByRole("button", { name: "Add attribute" }))
		const keys = screen.getAllByLabelText("Attribute key")
		const values = screen.getAllByLabelText("Attribute value")
		const [, secondKey] = keys
		const [, secondValue] = values
		if (secondKey === undefined || secondValue === undefined) throw new Error("second row missing")
		typeInto(secondKey, "service.name")
		typeInto(secondValue, "other")
		expect(submitButton()).toHaveProperty("disabled", true)
		expect(screen.getByText('"service.name" is listed twice.')).toBeDefined()
		fireEvent.click(screen.getAllByRole("button", { name: "Remove attribute" })[1] ?? document.body)

		const submit = submitButton()
		expect(submit).toHaveProperty("disabled", false)
		if (submit) fireEvent.click(submit)

		expect(await screen.findByText("Ingest key created")).toBeDefined()
		expect(createMutation).toHaveBeenCalledWith({
			payload: {
				name: "Checkout staging",
				description: null,
				allowed_signals: null,
				rate_limit_rps: null,
				resource_attributes: [{ key: "service.name", value: "checkout", mode: "default" }],
				expires_at: null,
			},
		})

		// Masked until revealed; revealing shows the exact secret the API returned.
		const field = screen.getByDisplayValue((text) => text.startsWith("maple_ik_Q7xZa") && text !== SECRET)
		fireEvent.click(screen.getByRole("button", { name: "Reveal key" }))
		expect(field).toHaveProperty("value", SECRET)
	})
})
