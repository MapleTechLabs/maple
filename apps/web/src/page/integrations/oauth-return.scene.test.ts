import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import type { OAuthReturnOutcome } from "./oauth-return"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const opened = (integration: string): Model => init({ search: { integration } }, context).model

const outcome = (fields: Partial<OAuthReturnOutcome>): OAuthReturnOutcome => ({
	provider: null,
	connector: null,
	status: "success",
	message: "",
	chat: null,
	isHandedOff: false,
	...fields,
})

const finished = (model: Model, value: OAuthReturnOutcome | null) =>
	update(model, Message.CompletedOAuthReturn({ outcome: value }), context)

describe("a provider return finished by the dashboard", () => {
	test("the page asks to finish a return on every load", () => {
		const names = (init({ search: {} }, context).commands ?? []).map(({ name }) => name)
		expect(names).toContain("CompleteIntegrationsOAuthReturn")
	})

	test("a URL with no return changes nothing", () => {
		const model = opened("cloudflare")
		const result = finished(model, null)
		expect(result.model).toBe(model)
		expect(result.outMessage).toBeUndefined()
	})

	test("a chat install reports through the chat search params the card toasts", () => {
		const result = finished(
			opened("chat-slack"),
			outcome({ connector: "slack", chat: { kind: "workspace", name: "Acme", reason: null } }),
		)
		expect(result.outMessage?._tag).toBe("RequestedNavigation")
		if (result.outMessage?._tag !== "RequestedNavigation") return
		const url = new URL(result.outMessage.url, "https://app.example.com")
		expect(url.searchParams.get("integration")).toBe("chat-slack")
		expect(url.searchParams.get("chat")).toBe("connected")
		expect(url.searchParams.get("chat_workspace")).toBe("Acme")
	})

	test("a refused chat link reports its reason code, not a message", () => {
		const result = finished(
			opened("chat-slack"),
			outcome({
				connector: "slack",
				status: "error",
				message: "Link failed",
				chat: { kind: "identity", name: null, reason: "state" },
			}),
		)
		expect(result.outMessage?._tag).toBe("RequestedNavigation")
		if (result.outMessage?._tag !== "RequestedNavigation") return
		const url = new URL(result.outMessage.url, "https://app.example.com")
		expect(url.searchParams.get("chat_identity")).toBe("error")
		expect(url.searchParams.get("chat_reason")).toBe("state")
	})

	test("a popup whose opener took a success leaves the reaction to the opener", () => {
		const result = finished(
			opened("cloudflare"),
			outcome({ provider: "cloudflare", isHandedOff: true, message: "ok" }),
		)
		expect(result.outMessage).toBeUndefined()
	})

	test("a refusal with no opener to tell is shown here", () => {
		const result = finished(
			opened("linear"),
			outcome({ provider: "linear", status: "error", message: "OAuth state not recognized." }),
		)
		expect(result.outMessage?._tag).toBe("RequestedToast")
		if (result.outMessage?._tag !== "RequestedToast") return
		expect(result.outMessage.type).toBe("error")
		expect(result.outMessage.title).toBe("OAuth state not recognized.")
	})
})
