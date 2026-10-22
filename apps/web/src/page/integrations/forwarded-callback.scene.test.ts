import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

describe("a provider callback forwarded to the integrations page", () => {
	test.each([
		[{ integration: "github", callback: "oauth" }, "CompleteIntegrationsOAuthCallback"],
		[{ integration: "cloudflare", callback: "oauth" }, "CompleteIntegrationsOAuthCallback"],
		[{ integration: "chat-slack", callback: "chat-install" }, "CompleteIntegrationsChatCallback"],
		[{ integration: "chat-slack", callback: "chat-identity" }, "CompleteIntegrationsChatCallback"],
	])("is finished by the signed-in page: %j", (search, command) => {
		expect(names(init({ search }, context).commands)).toContain(command)
	})

	test("a callback for no known provider finishes nothing and is dropped from the URL", () => {
		const started = init({ search: { integration: "prometheus", callback: "oauth" } }, context)
		expect(names(started.commands)).not.toContain("CompleteIntegrationsOAuthCallback")
		expect(started.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/integrations?integration=prometheus",
				isReplace: true,
			}),
		)
	})

	test("a success the opener received leaves the closing popup alone", () => {
		const model = init({ search: { integration: "github", callback: "oauth" } }, context).model
		const done = update(
			model,
			Message.CompletedOAuthCallback({
				provider: "github",
				status: "success",
				message: "You can close this window and return to Maple.",
				returnTo: "/integrations?integration=github",
				isRelayed: true,
			}),
			context,
		)
		expect(done.outMessage).toBeUndefined()
		expect(names(done.commands)).toEqual([])
	})

	test("a refusal with no opener shows its cause here, then strips the callback", () => {
		const model = init({ search: { integration: "github", callback: "oauth" } }, context).model
		const refusal =
			"This authorization was started by a different Maple user or organization. Start it again from your own account."
		const done = update(
			model,
			Message.CompletedOAuthCallback({
				provider: "github",
				status: "error",
				message: refusal,
				returnTo: null,
				isRelayed: false,
			}),
			context,
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "error", title: refusal, description: "" }),
		)
		expect(names(done.commands)).toContain("StripIntegrationsCallback")
		expect(
			update(model, Message.StrippedCallback({ href: "/integrations?integration=github" }), context)
				.outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/integrations?integration=github", isReplace: true }),
		)
	})

	test("a chat outcome lands on the card's existing chat toast params", () => {
		const model = init({ search: { integration: "chat-slack", callback: "chat-install" } }, context).model
		const done = update(
			model,
			Message.CompletedChatCallback({
				search: { integration: "chat-slack", chat: "error", chat_reason: "state" },
			}),
			context,
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/integrations?integration=chat-slack&chat=error&chat_reason=state",
				isReplace: true,
			}),
		)
	})
})
