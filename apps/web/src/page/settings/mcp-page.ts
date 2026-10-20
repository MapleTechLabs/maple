import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { Result, Schema, Stream } from "effect"
import { Command, Submodel, Subscription } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../../platform/resources"
import {
	definePage,
	type PageContext,
	type PageReturn,
	type PageSubscriptionInput,
	type PageViewInputs,
} from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { FetchSettingsSession, ReadSettingsClock } from "./command"
import { Message as SettingsMessage } from "./message"
import * as McpMessage from "./mcp/message"
import * as McpModel from "./mcp/model"
import * as Mcp from "./mcp/update"
import * as McpView from "./mcp/view"
import { apiKeyRows } from "./subscription"

// `/mcp`: the same `McpSection` as `/settings?tab=mcp`, standalone.

const Model = Schema.Struct({ nowMs: Schema.Number, isAdmin: Schema.Boolean, mcp: McpModel.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotSettingsMessage: { message: SettingsMessage },
	GotMcpMessage: { message: McpMessage.Message },
})
type Message = typeof Message.Type

type Return = PageReturn<Model, Message>

const toSettings = (message: SettingsMessage) => Message.GotSettingsMessage({ message })
const toMcp = (message: McpMessage.Message) => Message.GotMcpMessage({ message })

const init = (_route: unknown, _context: PageContext): Return => {
	const step = Mcp.init()
	return {
		model: { nowMs: 0, isAdmin: !isClerkAuthEnabled, mcp: step.model },
		commands: [
			Command.mapMessage(ReadSettingsClock(), toSettings),
			Command.mapMessage(FetchSettingsSession(), toSettings),
			...Command.mapMessages(step.commands ?? [], toMcp),
		],
	}
}

const update = (model: Model, message: Message, _context: PageContext): Return =>
	Message.match<Return>(message, {
		// Only the clock and session Commands are borrowed from `/settings`.
		GotSettingsMessage: ({ message: inner }) => {
			if (inner._tag === "ReadClock") return { model: { ...model, nowMs: inner.nowMs } }
			if (inner._tag !== "CompletedFetchSession") return { model }
			const isAdmin = Result.getOrElse(
				Result.map(inner.result, (session) => session.isAdmin),
				() => false,
			)
			return { model: { ...model, isAdmin: !isClerkAuthEnabled || isAdmin } }
		},
		GotMcpMessage: ({ message: inner }) => {
			const step = Mcp.update(model.mcp, inner)
			return {
				model: { ...model, mcp: step.model },
				commands: Command.mapMessages(step.commands ?? [], toMcp),
				outMessage: step.outMessage,
			}
		},
	})

const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(h, {}, [
		h.submodel({
			slotId: "mcp-page",
			model: model.mcp,
			view: McpView.view,
			toParentMessage: toMcp,
			viewInputs: { isAdmin: model.isAdmin, nowMs: model.nowMs, timeZone: inputs.context.timeZone },
		}),
	]),
)

/** An MCP key creation preloads the `api_keys` shape (`useApiKeyMutationSync`). */
const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	apiKeys: entry(
		{ orgId: Schema.String, isReading: Schema.Boolean },
		{
			modelToDependencies: ({ model, context }) => ({
				orgId: context.orgId,
				isReading: model.mcp.createKey.isCreating || model.mcp.createKey.created !== null,
			}),
			dependenciesToStream: ({ orgId, isReading }) =>
				isReading
					? apiKeyRows(orgId, (rows) => toSettings(SettingsMessage.UpdatedApiKeys({ orgId, rows })))
					: Stream.empty,
		},
	),
}))

export const page = definePage(
	"McpPage",
	{ Model, Message },
	{ routes: ["Mcp"], init, update, view, subscriptions, breadcrumbs: () => [{ label: "MCP" }] },
)
