import type { SourcePlatform } from "@maple/domain/primitives"
import { resolveLang } from "../../../lib/highlight"
import { ingestUrl } from "../../../lib/services/common/ingest-url"
import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "../../../ui/copy-button"
import { copyableField } from "../../../ui/copyable-field"
import { eyebrow } from "../../../ui/eyebrow"
import { panel } from "../../../ui/panel"
import * as Tabs from "../../../ui/tabs"
import * as TabsView from "../../../ui/tabs-view"
import { codeBlock } from "../../settings/kit/code-block"
import { maskedToken, sourceSnippets } from "./snippets"

// `SourceSetup`: endpoint, header and the platform's setup snippets. The parent embeds it and passes the
// token only right after a create or roll.

export const Model = Schema.Struct({
	tabs: Tabs.Model,
	endpointCopy: CopyButton.Model,
	headerCopy: CopyButton.Model,
	codeCopy: CopyButton.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotTabsMessage: { message: Tabs.Message },
	GotEndpointCopyMessage: { message: CopyButton.Message },
	GotHeaderCopyMessage: { message: CopyButton.Message },
	GotCodeCopyMessage: { message: CopyButton.Message },
})
export type Message = typeof Message.Type

/** The snippet tabs start on the first snippet, as `useState(snippets[0]?.id)`. */
export const init = (platform: SourcePlatform, idBase = 60): Model => {
	const values = sourceSnippets(platform, "", "").map((snippet) => snippet.id)
	return {
		tabs: Tabs.init({ idBase, values, selected: values[0] ?? "" }),
		endpointCopy: CopyButton.init(),
		headerCopy: CopyButton.init(),
		codeCopy: CopyButton.init(),
	}
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotTabsMessage: ({ message: inner }) => {
			const step = Tabs.update(model.tabs, inner)
			return {
				model: { ...model, tabs: step.model },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotTabsMessage({ message: child })),
			}
		},
		GotEndpointCopyMessage: ({ message: inner }) => {
			const step = CopyButton.update(model.endpointCopy, inner)
			return {
				model: { ...model, endpointCopy: step.model },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotEndpointCopyMessage({ message: child })),
			}
		},
		GotHeaderCopyMessage: ({ message: inner }) => {
			const step = CopyButton.update(model.headerCopy, inner)
			return {
				model: { ...model, headerCopy: step.model },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotHeaderCopyMessage({ message: child })),
			}
		},
		GotCodeCopyMessage: ({ message: inner }) => {
			const step = CopyButton.update(model.codeCopy, inner)
			return {
				model: { ...model, codeCopy: step.model },
				commands: Command.mapMessages(step.commands ?? [], (child) => Message.GotCodeCopyMessage({ message: child })),
			}
		},
	})

export type SetupViewConfig<P> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => P
	platform: SourcePlatform
	name: string
	token: string | null
	keyPrefix: string | null
	/** Prefix for the copyable inputs' ids, unique on the page. */
	idPrefix: string
}>

export const view = <P>(h: HtmlBuilder<P>, config: SetupViewConfig<P>): Html => {
	const { model, toParentMessage, token } = config
	const shown = token ?? maskedToken(config.keyPrefix)
	const snippets = sourceSnippets(config.platform, shown, config.name)
	const snippet = snippets.find((entry) => entry.id === model.tabs.selected) ?? snippets[0]
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			panel(h, { padded: true, className: "gap-3" }, [
				h.div(
					[h.Class("flex flex-col gap-1.5")],
					[
						eyebrow(h, {}, ["OTLP endpoint"]),
						copyableField(h, {
							id: `${config.idPrefix}-endpoint`,
							value: ingestUrl,
							copyLabel: "OTLP endpoint",
							copy: model.endpointCopy,
							toCopyMessage: (message) => toParentMessage(Message.GotEndpointCopyMessage({ message })),
						}),
					],
				),
				h.div(
					[h.Class("flex flex-col gap-1.5")],
					[
						eyebrow(h, {}, ["Header"]),
						token === null
							? h.div(
									[h.Class("bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 font-mono text-xs")],
									["Authorization: Bearer ", shown],
								)
							: copyableField(h, {
									id: `${config.idPrefix}-header`,
									value: `Authorization: Bearer ${token}`,
									copyLabel: "Header",
									copy: model.headerCopy,
									toCopyMessage: (message) => toParentMessage(Message.GotHeaderCopyMessage({ message })),
								}),
					],
				),
			]),
			...(snippet === undefined
				? []
				: [
						h.div(
							[h.Class("flex flex-col gap-2")],
							[
								...(snippets.length > 1
									? [
											h.submodel({
												slotId: `${config.idPrefix}-snippet-tabs`,
												model: model.tabs,
												view: TabsView.view,
												toParentMessage: (message) => toParentMessage(Message.GotTabsMessage({ message })),
												viewInputs: {
													variant: "underline",
													labels: snippets.map((entry) => entry.label),
													panel: () => undefined,
												},
											}),
										]
									: []),
								codeBlock(h, {
									code: snippet.code,
									language: snippets.length > 1 ? snippet.language : snippet.label,
									lang: resolveLang(snippet.language),
									copy: model.codeCopy,
									toCopyMessage: (message) => toParentMessage(Message.GotCodeCopyMessage({ message })),
								}),
							],
						),
					]),
			...(token === null
				? [
						h.p(
							[h.Class("text-muted-foreground text-xs")],
							["The token is only shown when the source is created or rolled. Roll it to get a new one."],
						),
					]
				: []),
		],
	)
}
