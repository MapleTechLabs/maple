import { Effect, Option, Schema } from "effect"
import { Command, Submodel, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../platform/resources"
import * as Shell from "../shell"
import {
	foldLabShell,
	initLabShell,
	LabShellFlags,
	labShellFlags,
	labShellSubscriptions,
	labShellView,
} from "./app-shell"
import { defineLabWithFlags, type LabEntry } from "./define"

// A lab page inside the real shell (apps/web's `DashboardLayout`): the page is a Submodel with its
// own Flags, the shell is booted for the session's org around it.

export type ShellLabPage<PageModel, PageMessage extends { _tag: string }, PageFlags> = Readonly<{
	Model: Schema.Codec<PageModel, unknown>
	Message: Schema.Codec<PageMessage, unknown>
	Flags: Schema.Codec<PageFlags, unknown>
	flags: Effect.Effect<PageFlags, never, Resources>
	init: (flags: PageFlags) => Update.Return<PageModel, PageMessage, Resources>
	update: (model: PageModel, message: PageMessage) => Update.Return<PageModel, PageMessage, Resources>
	view: (model: PageModel, h: HtmlBuilder<PageMessage>) => Html
	subscriptions?: Subscription.Subscriptions<PageModel, PageMessage, Resources>
	currentPath: string
	breadcrumbs: ReadonlyArray<Shell.BreadcrumbEntry>
}>

export const defineShellLab = <PageModel, PageMessage extends { _tag: string }, PageFlags>(
	title: string,
	page: ShellLabPage<PageModel, PageMessage, PageFlags>,
): LabEntry => {
	const Model = Schema.Struct({ page: page.Model, shell: Shell.Model })
	type Model = typeof Model.Type
	const Message = defineMessageUnion({
		GotPageMessage: { message: page.Message },
		GotShellMessage: { message: Shell.Message },
	})
	type Message = typeof Message.Type
	type Return = Update.Return<Model, Message, Resources>
	const toShell = (message: Shell.Message): Message => Message.GotShellMessage({ message })
	const toPage = (message: PageMessage): Message => Message.GotPageMessage({ message })
	const foldShell = foldLabShell<Model, Message>(toShell)
	const pageView = Submodel.defineView<PageModel, PageMessage>(page.view)
	const own = Subscription.lift(page.subscriptions ?? {})<Model, Message>({
		read: (model: Model) => Option.some(model.page),
		toParentMessage: toPage,
	})
	return defineLabWithFlags(title, {
		Model,
		Flags: Schema.Struct({ page: page.Flags, shell: LabShellFlags }),
		flags: Effect.all({ page: page.flags, shell: labShellFlags }),
		init: (flags) => {
			const shell = initLabShell(flags.shell)
			const inner = page.init(flags.page)
			return {
				model: { page: inner.model, shell: shell.model },
				commands: [
					...Command.mapMessages(shell.commands ?? [], toShell),
					...Command.mapMessages(inner.commands ?? [], toPage),
				],
			}
		},
		update: (model: Model, message: Message): Return =>
			Message.match<Return>(message, {
				GotPageMessage: ({ message: inner }) => {
					const next = page.update(model.page, inner)
					return {
						model: { ...model, page: next.model },
						commands: Command.mapMessages(next.commands ?? [], toPage),
					}
				},
				GotShellMessage: ({ message: inner }) => foldShell(model, inner),
			}),
		view: (model: Model, h: HtmlBuilder<Message>) =>
			h.div(
				[h.Id("app")],
				labShellView(h, model.shell, toShell, {
					currentPath: page.currentPath,
					breadcrumbs: page.breadcrumbs,
					page: () =>
						h.submodel({
							slotId: "lab-page",
							model: model.page,
							view: pageView,
							toParentMessage: toPage,
						}),
				}),
			),
		subscriptions: Subscription.aggregate<Model, Message, Resources>()(
			labShellSubscriptions<Model, Message>(toShell),
			own,
		),
	})
}
