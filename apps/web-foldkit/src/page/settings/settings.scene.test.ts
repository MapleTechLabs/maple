import { OrgId } from "@maple/domain"
import { V2McpConnection } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, expect as expectView, expectOutMessage, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Tabs from "../../ui/tabs"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import * as McpMessage from "./mcp/message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const entered = (search: Model["search"] = {}) => init({ _tag: "Settings", search }, context)
const mcp = (message: McpMessage.Message) => Message.GotMcpMessage({ message })

const tools = [
	{ name: "update_dashboard", title: "Update", description: "Change a dashboard's widgets.", readOnly: false, destructive: false },
	{ name: "find_errors", title: "Errors", description: "Error groups by service.", readOnly: true, destructive: false },
]
const connection = Schema.decodeUnknownSync(V2McpConnection)({
	id: "mcpc_p12S8T8agEHUkYc825nMz6",
	object: "mcp_connection",
	client_name: "Claude Code",
	user_id: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	user_email: "david@acme.com",
	scopes: ["mcp:tools"],
	connected_at: "2026-09-30T12:00:00.000Z",
	last_refreshed_at: "2026-10-17T08:00:00.000Z",
	expires_at: "2026-12-29T12:00:00.000Z",
})

const mcpLoaded = (): Model =>
	[
		Message.CompletedFetchSession({ result: Result.succeed({ isAdmin: true, userId: null }) }),
		Message.CompletedFetchCustomer({ result: Result.succeed({ hasByoc: false }) }),
		mcp(McpMessage.Message.CompletedFetchConnections({ result: Result.succeed([connection]) })),
		mcp(McpMessage.Message.CompletedFetchTools({ result: Result.succeed(tools) })),
	].reduce((model, message) => pageUpdate(model, message).model, entered({ tab: "mcp" }).model)

/** Scene lifts a Mount's result through every `toParentMessage`, so it takes the Tabs message. */
const indicatorMeasured = () =>
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({ rect: { left: 0, right: 225, top: 4, bottom: 5, width: 112, height: 32 } }),
	)

describe("settings page", () => {
	test("entry reads the clock, session and customer; the MCP tab adds its two reads", () => {
		expect(names(entered().commands)).toEqual(["ReadSettingsClock", "FetchSettingsSession", "FetchSettingsCustomer"])
		expect(names(entered({ tab: "mcp" }).commands)).toEqual([
			"ReadSettingsClock",
			"FetchSettingsSession",
			"FetchSettingsCustomer",
			"FetchMcpConnections",
			"FetchMcpTools",
		])
	})

	test("a retired tab id replaces the URL with its new home", () => {
		expect(entered({ tab: "api-keys" }).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/settings?tab=keys", isReplace: true }),
		)
		expect(entered({ tab: "connectors" }).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/integrations", isReplace: true }),
		)
	})

	test("self-hosted lands on Ingestion and a nav click carries the audit filters", () => {
		const model = entered({ outcome: "denied" }).model
		expect(model.tab).toEqual({ _tag: "Unported", tab: "ingestion" })
		expect(pageUpdate(model, Message.ClickedTab({ tab: "mcp" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/settings?tab=mcp&outcome=denied", isReplace: false }),
		)
	})

	test("the MCP tab lists the connection and revokes it after confirming", () => {
		scene(
			{ update: pageUpdate, view },
			given(mcpLoaded()),
			indicatorMeasured(),
			expectView(text("david@acme.com")).toExist(),
			expectView(role("heading", { name: "Tools · 2" })).toExist(),
		)
		const opened = pageUpdate(mcpLoaded(), mcp(McpMessage.Message.ClickedRevoke({ connectionId: connection.id })))
		const tab = opened.model.tab
		expect(tab?._tag === "Mcp" && tab.model.revokeDialog.isOpen).toBe(true)
		const confirming = pageUpdate(opened.model, mcp(McpMessage.Message.ClickedConfirmRevoke()))
		expect(names(confirming.commands)).toEqual(["RevokeMcpConnection"])
		const revoked = pageUpdate(confirming.model, mcp(McpMessage.Message.CompletedRevoke({ result: Result.succeed(undefined) })))
		expect(names(revoked.commands)).toContain("FetchMcpConnections")
		expect(revoked.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Client signed out", description: "" }),
		)
	})

	test("a tool search with no match says so, and a nav click navigates", () => {
		const searched = pageUpdate(mcpLoaded(), mcp(McpMessage.Message.ChangedToolSearch({ value: "zzz" }))).model
		scene(
			{ update: pageUpdate, view },
			given(searched),
			indicatorMeasured(),
			expectView(text("No tools match “zzz”.")).toExist(),
			click(role("button", { name: "Audit log" })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ url: "/settings?tab=audit-log", isReplace: false })),
		)
	})
})
