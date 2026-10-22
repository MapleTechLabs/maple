import { encodePublicId, PublicIdPrefixes, V2Source } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as ToggleGroup from "../../../ui/toggle-group"
import { expiresAtOf, expiryChoicesOf, init, Message, rulesOutcome, update } from "./rules"
import { SIGNALS } from "./shared"

const source = (fields: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(V2Source)({
		id: encodePublicId(PublicIdPrefixes.source, "0199a0e1-0000-7000-8000-000000000002"),
		object: "source",
		name: "Checkout API",
		description: null,
		platform: "nodejs",
		kind: "token",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
		status: "active",
		allowed_signals: ["traces", "logs"],
		rate_limit_rps: 200,
		resource_attributes: [{ key: "deployment.environment", value: "production", mode: "set" }],
		expires_at: "2026-11-01T00:00:00.000Z",
		paused_at: null,
		paused_until: null,
		last_used_at: null,
		rolled_at: null,
		created_at: "2026-10-01T00:00:00.000Z",
		updated_at: "2026-10-01T00:00:00.000Z",
		health: { status: "pending", last_data_at: null, problem: null, resources: null },
		...fields,
	})

const run = (messages: ReadonlyArray<Message>, model = init(null)) =>
	messages.reduce((current, message) => update(current, message).model, model)

describe("source rules draft", () => {
	test("a new draft allows every signal, so the payload clears the allow list", () => {
		const outcome = rulesOutcome(init(null))
		expect(outcome.valid).toBe(true)
		expect(outcome.payload).toEqual({
			allowed_signals: null,
			rate_limit_rps: null,
			resource_attributes: [],
		})
		expect(expiryChoicesOf(init(null)).map((choice) => choice.value)).toEqual(["never", "7", "30", "90"])
	})

	test("an existing source seeds the draft and offers to keep its expiry", () => {
		const draft = init(source())
		expect(draft.expiry).toBe("keep")
		expect(expiryChoicesOf(draft).map((choice) => choice.value)).toContain("keep")
		expect(rulesOutcome(draft).payload).toEqual({
			allowed_signals: ["traces", "logs"],
			rate_limit_rps: 200,
			resource_attributes: [{ key: "deployment.environment", value: "production", mode: "set" }],
		})
		expect(expiresAtOf("keep", 0)).toBeUndefined()
		expect(expiresAtOf("7", 0)).toBe("1970-01-08T00:00:00.000Z")
	})

	test("no signal, a bad rate limit or a reserved key make the draft invalid", () => {
		const noSignals = run(SIGNALS.map((signal) => Message.ToggledSignal({ signal: signal.value })))
		expect(rulesOutcome(noSignals).valid).toBe(false)
		expect(rulesOutcome(run([Message.ChangedRateLimit({ value: "1.5" })])).rateLimitValid).toBe(false)
		const reserved = run([
			Message.ClickedAddAttribute(),
			Message.ChangedAttribute({ rowId: "added-0", field: "key", value: "Maple_env" }),
		])
		expect(rulesOutcome(reserved).attributeProblem).toBe('"Maple_env" is reserved by Maple.')
		const missing = run([
			Message.ClickedAddAttribute(),
			Message.ChangedAttribute({ rowId: "added-0", field: "key", value: "team" }),
		])
		expect(rulesOutcome(missing).attributeProblem).toBe('Give "team" a value, or remove it.')
	})

	test("clicking a pressed expiry or mode keeps it; another one replaces it", () => {
		const clicked = (value: string, index: number) =>
			Message.GotExpiryMessage({ message: ToggleGroup.Message.ClickedItem({ value, index }) })
		expect(run([clicked("never", 0)]).expiry).toBe("never")
		expect(run([clicked("30", 2)]).expiry).toBe("30")
		const row = run([Message.ClickedAddAttribute()])
		const mode = update(
			row,
			Message.GotModeMessage({
				rowId: "added-0",
				message: ToggleGroup.Message.ClickedItem({ value: "default", index: 1 }),
			}),
		)
		expect(mode.model.attributes[0]?.mode).toBe("default")
		expect(run([Message.ClickedRemoveAttribute({ rowId: "added-0" })], row).attributes).toEqual([])
	})
})
