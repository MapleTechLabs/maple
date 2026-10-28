import { BillingCustomer } from "@maple/domain/http"
import { BillingAccount, BillingAccountOrg } from "@maple/domain/http"
import { OrgId } from "@maple/domain"
import { V2McpConnection } from "@maple/domain/http/v2"
import { NetworkErrorBody } from "@maple/web-data/lib/error-messages"
import { Result, Schema } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Tabs from "../../ui/tabs"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import * as Billing from "./billing/update"
import { Message as BillingMessage } from "./billing/model"
import { Message as KeysMessage } from "./keys/message"
import * as McpMessage from "./mcp/message"
import type { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_parity"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const entered = (search: Model["search"] = {}) => init({ _tag: "Settings", search }, context)
const mcp = (message: McpMessage.Message) => Message.GotMcpMessage({ message })
const toTab = (model: Model, tab: NonNullable<Model["search"]["tab"]>) =>
	routeChanged(model, { _tag: "Settings", search: { tab } }, context)

const tools = [
	{
		name: "update_dashboard",
		title: "Update",
		description: "Change a dashboard's widgets.",
		readOnly: false,
		destructive: false,
	},
	{
		name: "find_errors",
		title: "Errors",
		description: "Error groups by service.",
		readOnly: true,
		destructive: false,
	},
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
		Message.CompletedFetchSession({
			result: Result.succeed({ isAdmin: true, userId: null, hasAiAutoTriage: true }),
		}),
		Message.CompletedFetchCustomer({
			result: Result.succeed(new BillingCustomer({ id: "org_acme", subscriptions: [] })),
		}),
		mcp(McpMessage.Message.CompletedFetchConnections({ result: Result.succeed([connection]) })),
		mcp(McpMessage.Message.CompletedFetchTools({ result: Result.succeed(tools) })),
	].reduce((model, message) => pageUpdate(model, message).model, entered({ tab: "mcp" }).model)

/** Scene lifts a Mount's result through every `toParentMessage`, so it takes the Tabs message. */
const indicatorMeasured = () =>
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({
			rect: { left: 0, right: 225, top: 4, bottom: 5, width: 112, height: 32 },
		}),
	)

describe("settings page", () => {
	test("entry reads the clock, session and customer; the MCP tab adds its two reads", () => {
		expect(names(entered({ tab: "automation" }).commands)).toEqual(
			expect.arrayContaining(["ReadSettingsClock", "FetchSettingsSession", "FetchSettingsCustomer"]),
		)
		expect(names(entered({ tab: "automation" }).commands)).not.toContain("FetchMcpTools")
		expect(names(entered({ tab: "mcp" }).commands)).toEqual(
			expect.arrayContaining(["FetchMcpConnections", "FetchMcpTools"]),
		)
	})

	test("a retired tab id replaces the URL with its new home", () => {
		expect(entered({ tab: "api-keys" }).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/settings?tab=keys", isReplace: true }),
		)
		expect(entered({ tab: "connectors" }).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/integrations", isReplace: true }),
		)
	})

	test("a tab this org cannot open replaces the URL with the default tab", () => {
		// Self-hosted has no General tab, so a deep link to it lands on Ingestion with a clean URL.
		const step = entered({ tab: "general", outcome: "denied" })
		expect(step.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/settings?outcome=denied", isReplace: true }),
		)
		expect(
			routeChanged(step.model, { _tag: "Settings", search: { outcome: "denied" } }, context).model.tab
				?._tag,
		).toBe("Ingestion")
	})

	test("a denied deep link keeps its note after the URL rewrite, until another tab is picked", () => {
		const landed = routeChanged(
			entered({ tab: "general" }).model,
			{ _tag: "Settings", search: {} },
			context,
		).model
		scene(
			{ update: pageUpdate, view },
			given(landed),
			indicatorMeasured(),
			indicatorMeasured(),
			expectView(text("General isn't available on this deployment.")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(toTab(landed, "mcp").model),
			indicatorMeasured(),
			expectView(text("General isn't available on this deployment.")).toBeAbsent(),
		)
	})

	test("self-hosted lands on Ingestion and a nav click carries the audit filters", () => {
		const model = entered({ outcome: "denied" }).model
		expect(model.tab?._tag).toBe("Ingestion")
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
		const opened = pageUpdate(
			mcpLoaded(),
			mcp(McpMessage.Message.ClickedRevoke({ connectionId: connection.id })),
		)
		const tab = opened.model.tab
		expect(tab?._tag === "Mcp" && tab.model.revokeDialog.isOpen).toBe(true)
		const confirming = pageUpdate(opened.model, mcp(McpMessage.Message.ClickedConfirmRevoke()))
		expect(names(confirming.commands)).toEqual(["RevokeMcpConnection"])
		const revoked = pageUpdate(
			confirming.model,
			mcp(McpMessage.Message.CompletedRevoke({ result: Result.succeed(undefined) })),
		)
		expect(names(revoked.commands)).toContain("FetchMcpConnections")
		expect(revoked.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Client signed out", description: "" }),
		)
	})

	test("a tool search with no match says so, and a nav click navigates", () => {
		const searched = pageUpdate(
			mcpLoaded(),
			mcp(McpMessage.Message.ChangedToolSearch({ value: "zzz" })),
		).model
		scene(
			{ update: pageUpdate, view },
			given(searched),
			indicatorMeasured(),
			expectView(text("No tools match “zzz”.")).toExist(),
			click(role("button", { name: "Audit log" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/settings?tab=audit-log", isReplace: false }),
			),
		)
	})

	// The flicker: every tab switch rebuilt the tab from Loading, so a revisit painted skeletons over
	// data shown a moment ago until the reads answered again.
	test("coming back to a tab shows its data at once while it reads again", () => {
		const back = toTab(toTab(mcpLoaded(), "setup-health").model, "mcp")
		expect(names(back.commands)).toEqual(expect.arrayContaining(["FetchMcpConnections", "FetchMcpTools"]))
		scene(
			{ update: pageUpdate, view },
			given(back.model),
			indicatorMeasured(),
			expectView(text("david@acme.com")).toExist(),
			expectView(role("heading", { name: "Tools · 2" })).toExist(),
		)
	})

	test("a tab left mid-read takes the answer, and coming back does not ask twice", () => {
		const opened = toTab(mcpLoaded(), "setup-health").model
		const fresh = toTab({ ...opened, kept: [] }, "mcp").model
		const away = toTab(fresh, "setup-health").model
		const answered = pageUpdate(
			away,
			mcp(McpMessage.Message.CompletedFetchConnections({ result: Result.succeed([connection]) })),
		)
		const back = toTab(answered.model, "mcp")
		// Connections answered while away and revalidate; the tools read is still in flight.
		expect(names(back.commands)).toEqual(["FetchMcpConnections"])
		scene(
			{ update: pageUpdate, view },
			given(back.model),
			indicatorMeasured(),
			expectView(text("david@acme.com")).toExist(),
		)
	})

	test("checkout polls re-read only the page's customer; the confirmed plan refreshes the app's once", () => {
		const subscribed = Schema.decodeUnknownSync(BillingCustomer)({
			id: "org_acme",
			subscriptions: [
				{
					planId: "startup",
					status: "active",
					currentPeriodStart: 0,
					currentPeriodEnd: 30 * 86_400_000,
				},
			],
		})
		const returning: Model = {
			...mcpLoaded(),
			tab: { _tag: "Billing", model: Billing.init(true, true, true).model },
		}
		const polled = pageUpdate(
			returning,
			Message.GotBillingMessage({ message: BillingMessage.ElapsedCheckoutPoll() }),
		)
		expect(names(polled.commands)).toContain("FetchSettingsCustomer")
		expect(polled.outMessage).toBeUndefined()
		const confirmed = pageUpdate(
			polled.model,
			Message.CompletedFetchCustomer({ result: Result.succeed(subscribed) }),
		)
		expect(confirmed.outMessage).toMatchObject({
			_tag: "RequestedNavigation",
			isReplace: true,
			refreshesCustomer: true,
		})
		const after = pageUpdate(
			confirmed.model,
			Message.CompletedFetchCustomer({ result: Result.succeed(subscribed) }),
		)
		expect(after.outMessage).toBeUndefined()
	})

	// Billing is Clerk-only, so the tab left while it confirmed a checkout return is placed in `kept`.
	test("a checkout return settles even when the Billing tab was left while it waited", () => {
		const subscribed = Schema.decodeUnknownSync(BillingCustomer)({
			id: "org_acme",
			subscriptions: [
				{
					planId: "startup",
					status: "active",
					currentPeriodStart: 0,
					currentPeriodEnd: 30 * 86_400_000,
				},
			],
		})
		const away: Model = {
			...mcpLoaded(),
			kept: [{ _tag: "Billing", model: Billing.init(true, true, true).model }],
		}
		const settled = pageUpdate(
			away,
			Message.CompletedFetchCustomer({ result: Result.succeed(subscribed) }),
		)
		const billing = settled.model.kept.find((tab) => tab._tag === "Billing")
		expect(billing?._tag === "Billing" && billing.model.checkoutReturn).toBe("Idle")
		expect(settled.commands).toContainEqual(
			expect.objectContaining({
				args: { event: "plan_checkout_returned", props: { confirmed: true } },
			}),
		)
	})

	test("an api_keys shape that fails before answering shows the sync error, not a skeleton", () => {
		const keys = [
			Message.CompletedFetchSession({
				result: Result.succeed({ isAdmin: true, userId: null, hasAiAutoTriage: true }),
			}),
			Message.CompletedFetchCustomer({
				result: Result.succeed(new BillingCustomer({ id: "org_acme", subscriptions: [] })),
			}),
		].reduce((model, message) => pageUpdate(model, message).model, entered({ tab: "keys" }).model)
		const watching = (model: Model) =>
			subscriptions.apiKeysLoad.modelToDependencies({ model, context }).isWatching
		expect(watching(keys)).toBe(true)
		const failed = pageUpdate(keys, Message.FailedLoadApiKeys({ orgId: context.orgId })).model
		expect(watching(failed)).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load keys")).toExist(),
			expectView(text("Live sync is unavailable.")).toExist(),
		)
		const answered = pageUpdate(failed, Message.UpdatedApiKeys({ orgId: context.orgId, rows: [] })).model
		scene(
			{ update: pageUpdate, view },
			given(answered),
			expectView(text("Couldn't load keys")).not.toExist(),
		)
	})

	test("a failed api_keys load gives Mobile devices its own error instead of dropping the section", () => {
		const failed = [
			Message.CompletedFetchSession({
				result: Result.succeed({ isAdmin: true, userId: null, hasAiAutoTriage: true }),
			}),
			Message.FailedLoadApiKeys({ orgId: context.orgId }),
		].reduce((model, message) => pageUpdate(model, message).model, entered({ tab: "keys" }).model)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Mobile devices")).toExist(),
			expectView(text("Couldn't load devices")).toExist(),
		)
	})

	test("usage that fails while the customer answers shows the account error with Try again, not skeletons", () => {
		const billing: Model = {
			...mcpLoaded(),
			tab: { _tag: "Billing", model: Billing.init(true, false, true).model },
		}
		// The account settles first: an org that pays for itself.
		const standalone = pageUpdate(
			billing,
			Message.GotBillingMessage({
				message: BillingMessage.CompletedFetchAccount({
					result: Result.succeed(
						new BillingAccount({
							orgId: context.orgId,
							role: "standalone",
							billingOrg: new BillingAccountOrg({
								orgId: context.orgId,
								name: "Acme",
								imageUrl: null,
							}),
							members: [],
						}),
					),
				}),
			}),
		).model
		const failed = pageUpdate(
			standalone,
			Message.GotBillingMessage({
				message: BillingMessage.CompletedFetchUsage({
					// Not retryable, so the row draws Try again without the network auto-retry probe.
					result: Result.fail({ ...NetworkErrorBody, retryable: false }),
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load your billing account")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		const retried = pageUpdate(
			failed,
			Message.GotBillingMessage({ message: BillingMessage.ClickedRetryCustomer() }),
		)
		expect(names(retried.commands)).toEqual(
			expect.arrayContaining(["FetchSettingsCustomer", "FetchBillingUsage"]),
		)
	})

	test("retrying a failed api_keys load reconnects and watches again, keeping the error until it answers", () => {
		const keys = [
			Message.CompletedFetchSession({
				result: Result.succeed({ isAdmin: true, userId: null, hasAiAutoTriage: true }),
			}),
			Message.FailedLoadApiKeys({ orgId: context.orgId }),
		].reduce((model, message) => pageUpdate(model, message).model, entered({ tab: "keys" }).model)
		const watching = (model: Model) =>
			subscriptions.apiKeysLoad.modelToDependencies({ model, context }).isWatching
		scene(
			{ update: pageUpdate, view },
			given(keys),
			click(role("button", { name: "Try again" })),
			expectOutMessage(PageOutMessage.RequestedReconnectOrgCollections()),
			expectView(text("Couldn't load keys")).toExist(),
		)
		const retried = pageUpdate(
			keys,
			Message.GotKeysMessage({ message: KeysMessage.ClickedRetryLoad() }),
		).model
		expect(watching(retried)).toBe(true)
	})

	test("a saved cap re-reads the app's customer too, keeping its toast", () => {
		const customer = new BillingCustomer({ id: "org_acme", subscriptions: [] })
		const editing: Model = {
			...mcpLoaded(),
			tab: { _tag: "Billing", model: { ...Billing.init(true, false, true).model, isSavingCap: true } },
		}
		const saved = pageUpdate(
			editing,
			Message.GotBillingMessage({
				message: BillingMessage.CompletedSaveCap({
					featureId: "logs",
					label: "Logs",
					result: Result.succeed(customer),
				}),
			}),
		)
		expect(names(saved.commands)).toContain("FetchSettingsCustomer")
		expect(saved.outMessage).toEqual(
			PageOutMessage.RequestedCustomerRefresh({
				toast: { type: "success", title: "Logs cap saved", description: "" },
			}),
		)
	})

	test("a customer re-read without a toast still re-reads the app's customer", () => {
		const billing: Model = {
			...mcpLoaded(),
			tab: { _tag: "Billing", model: Billing.init(true, false, true).model },
		}
		const retried = pageUpdate(
			billing,
			Message.GotBillingMessage({ message: BillingMessage.ClickedRetryCustomer() }),
		)
		expect(names(retried.commands)).toContain("FetchSettingsCustomer")
		expect(retried.outMessage).toEqual(PageOutMessage.RequestedCustomerRefresh({}))
	})
})
