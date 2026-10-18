import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Result, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { definePage, type PageContext, type PageReturn, type PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { FetchSettingsSession, ReadSettingsClock } from "./command"
import { Message as SettingsMessage } from "./message"
import * as McpMessage from "./mcp/message"
import * as McpModel from "./mcp/model"
import * as Mcp from "./mcp/update"
import * as McpView from "./mcp/view"

// `/mcp` (apps/web/src/routes/mcp.tsx): the same `McpSection` as `/settings?tab=mcp`, standalone.

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
		GotSettingsMessage: ({ message: inner }) =>
			SettingsMessage.match<Return>(inner, {
				ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
				CompletedFetchSession: ({ result }) => ({
					model: {
						...model,
						isAdmin: !isClerkAuthEnabled || Result.getOrElse(Result.map(result, (s) => s.isAdmin), () => false),
					},
				}),
				CompletedFetchCustomer: () => ({ model }),
				ClickedTab: () => ({ model }),
				GotMcpMessage: () => ({ model }),
			}),
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

export const page = definePage(
	"McpPage",
	{ Model, Message },
	{ routes: ["Mcp"], init, update, view, breadcrumbs: () => [{ label: "MCP" }] },
)
