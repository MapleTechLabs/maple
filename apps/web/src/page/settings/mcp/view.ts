import { mcpUrl } from "../../../lib/services/common/mcp-url"
import {
	claudeCodeCommand,
	isMcpClient,
	type McpClient,
	mcpClientConfig,
} from "../../../components/settings/mcp-client-config"
import { REPLAY_BLOCK_CLASS } from "../../../components/common/replay-privacy"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Submodel } from "foldkit"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { copyableField } from "../../../ui/copyable-field"
import { inlineCode } from "../../../ui/inline-code"
import * as TabsView from "../../../ui/tabs-view"
import * as CreateKeyView from "../keys/create-dialog-view"
import { codeBlock } from "../kit/code-block"
import { settingsSection, settingsSections } from "../kit/section"
import { Message } from "./message"
import { CLIENT_LABELS, type Model } from "./model"
import { connectedClientsSection } from "./view-clients"
import { toolsSection } from "./view-tools"

export type ViewInputs = Readonly<{ isAdmin: boolean; nowMs: number; timeZone: string }>

type H = HtmlBuilder<Message>

const mcpEndpoint = `${mcpUrl}/mcp`
const keysLinkClass = "text-foreground underline underline-offset-2 hover:no-underline"
const keysLink = (h: H) => h.a([h.Href("/settings?tab=keys"), h.Class(keysLinkClass)], ["Keys"])

const snippet = (
	h: H,
	model: Model,
	key: string,
	hint: ReadonlyArray<Html | string>,
	code: string,
	language: string,
): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			h.p([h.Class("text-xs text-muted-foreground")], hint),
			codeBlock(h, {
				code,
				language,
				className: REPLAY_BLOCK_CLASS,
				copy: model.snippetCopies[key] ?? CopyButton.init(),
				toCopyMessage: (message) => Message.GotSnippetCopyMessage({ snippet: key, message }),
			}),
		],
	)

const code = (h: H, text: string) => inlineCode(h, {}, [text])

const clientSnippets = (h: H, model: Model, client: McpClient): ReadonlyArray<Html> => {
	const apiKey = model.createdSecret ?? undefined
	const json = mcpClientConfig(client, mcpEndpoint, apiKey)
	switch (client) {
		case "claude-code":
			return [
				h.div(
					[h.Class("space-y-4")],
					[
						snippet(
							h,
							model,
							"claude-code:0",
							["Run in your terminal"],
							claudeCodeCommand(mcpEndpoint, apiKey),
							"bash",
						),
						snippet(
							h,
							model,
							"claude-code:1",
							["Or add to ", code(h, ".mcp.json"), " in your project"],
							json,
							"json",
						),
					],
				),
			]
		case "cursor":
			return [
				snippet(
					h,
					model,
					"cursor:0",
					[
						"Add to ",
						code(h, ".cursor/mcp.json"),
						" in your project, or",
						" ",
						code(h, "~/.cursor/mcp.json"),
						" for every project",
					],
					json,
					"json",
				),
			]
		case "windsurf":
			return [
				snippet(
					h,
					model,
					"windsurf:0",
					["Add to ", code(h, "~/.codeium/windsurf/mcp_config.json")],
					json,
					"json",
				),
			]
		case "other":
			return [
				snippet(
					h,
					model,
					"other:0",
					["Add the server URL to any client that supports remote MCP servers over HTTP"],
					json,
					"json",
				),
			]
	}
}

const oauthNote = (h: H, model: Model): Html =>
	model.createdSecret === null
		? h.p(
				[],
				[
					"Client without OAuth?",
					" ",
					button(
						h,
						{
							variant: "link",
							size: "xs",
							className:
								"h-auto p-0 align-baseline text-xs underline underline-offset-2 hover:no-underline",
							attributes: [h.OnClick(Message.ClickedCreateMcpKey())],
						},
						["Create an MCP key"],
					),
					" ",
					"in",
					" ",
					keysLink(h),
				],
			)
		: h.p(
				[h.Class("text-muted-foreground")],
				["Key created and added to the snippets above. Manage it in", " ", keysLink(h), "."],
			)

const connectSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "mcp-connect-heading",
			title: "Connect a client",
			description: ["Add Maple as a remote MCP server in your editor or agent."],
		},
		[
			h.div(
				[h.Class("space-y-4")],
				[
					copyableField(h, {
						id: "mcp-server-url",
						value: mcpEndpoint,
						label: "Server URL",
						copyLabel: "Server URL",
						copy: model.serverUrlCopy,
						toCopyMessage: (message) => Message.GotServerUrlCopyMessage({ message }),
					}),
					h.submodel({
						slotId: "mcp-client-tabs",
						model: model.client,
						view: TabsView.view,
						toParentMessage: (message) => Message.GotClientTabsMessage({ message }),
						viewInputs: {
							variant: "underline",
							labels: CLIENT_LABELS,
							panelClassName: "pt-3",
							panel: (value) =>
								isMcpClient(value) ? clientSnippets(h, model, value) : undefined,
						},
					}),
					h.div(
						[h.Class("space-y-1 border-t pt-3 text-xs")],
						[
							h.p(
								[h.Class("text-muted-foreground")],
								["Your client opens Maple in the browser to approve access."],
							),
							oauthNote(h, model),
						],
					),
				],
			),
			createKeyDialog(h, model),
		],
	)

const createKeyDialog = (h: H, model: Model): Html =>
	h.submodel({
		slotId: "mcp-create-key",
		model: model.createKey,
		view: CreateKeyView.view,
		toParentMessage: (message) => Message.GotCreateKeyMessage({ message }),
		viewInputs: { slotId: "mcp-create-key-popup" },
	})

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	settingsSections(h, "standard", [
		connectSection(h, model),
		connectedClientsSection(h, model, inputs),
		toolsSection(h, model),
	]),
)
