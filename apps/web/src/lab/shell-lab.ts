import { Effect, Option, Schema } from "effect"
import { Command, Submodel, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { Resources } from "../platform/resources"
import * as Shell from "../shell"
import * as Toast from "../ui/toast"
import * as ToastView from "../ui/toast-view"
import {
	foldLabShell,
	initLabShell,
	LabShellFlags,
	labShellFlags,
	labShellSubscriptions,
	labShellView,
} from "./app-shell"
import { defineLabWithFlags, type LabEntry } from "./define"
import { foldLabToasts, initLabToasts } from "./toasts"

// A lab page inside the real shell: the page is a Submodel with its
// own Flags, the shell is booted for the session's org around it, and the app's
// Notifications regions follow it.

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
	/** Fixed, or read from the page (a lab switching between pages). */
	breadcrumbs:
		| ReadonlyArray<Shell.BreadcrumbEntry>
		| ((model: PageModel) => ReadonlyArray<Shell.BreadcrumbEntry>)
	/** Rendered in `#app` before the shell: lab toolbars that sit beside the shell. */
	before?: (model: PageModel, h: HtmlBuilder<PageMessage>) => Html
}>

export const defineShellLab = <PageModel, PageMessage extends { _tag: string }, PageFlags>(
	title: string,
	page: ShellLabPage<PageModel, PageMessage, PageFlags>,
): LabEntry => {
	const Model = Schema.Struct({ page: page.Model, shell: Shell.Model, toasts: Toast.Model })
	type Model = typeof Model.Type
	const Message = defineMessageUnion({
		GotPageMessage: { message: page.Message },
		GotShellMessage: { message: Shell.Message },
		GotToastMessage: { message: Toast.Message },
	})
	type Message = typeof Message.Type
	type Return = Update.Return<Model, Message, Resources>
	const toShell = (message: Shell.Message): Message => Message.GotShellMessage({ message })
	const toPage = (message: PageMessage): Message => Message.GotPageMessage({ message })
	const foldShell = foldLabShell<Model, Message>(toShell)
	const toToast = (message: Toast.Message): Message => Message.GotToastMessage({ message })
	const foldToasts = foldLabToasts<Model, Message>(toToast)
	const pageView = Submodel.defineView<PageModel, PageMessage>(page.view)
	const before = page.before
	const beforeView = before === undefined ? null : Submodel.defineView<PageModel, PageMessage>(before)
	const breadcrumbsOf = (model: PageModel) =>
		typeof page.breadcrumbs === "function" ? page.breadcrumbs(model) : page.breadcrumbs
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
				model: { page: inner.model, shell: shell.model, toasts: initLabToasts() },
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
				GotToastMessage: ({ message: inner }) => foldToasts(model, inner),
			}),
		view: (model: Model, h: HtmlBuilder<Message>) =>
			h.div(
				[
					h.Id("app"),
					// A `before` toolbar floats at the viewport's bottom (48px bar, 16px off the edge):
					// end the page's scroll area above it, so no row ever sits under the bar.
					...(beforeView === null ? [] : [h.Class("[&_[data-slot=page-scroll-area]]:mb-20")]),
				],
				[
					...(beforeView === null
						? []
						: [
								h.submodel({
									slotId: "lab-before",
									model: model.page,
									view: beforeView,
									toParentMessage: toPage,
								}),
							]),
					...labShellView(h, model.shell, toShell, {
						currentPath: page.currentPath,
						breadcrumbs: breadcrumbsOf(model.page),
						page: () =>
							h.submodel({
								slotId: "lab-page",
								model: model.page,
								view: pageView,
								toParentMessage: toPage,
							}),
					}),
					...ToastView.regions(h, model.toasts, toToast),
				],
			),
		subscriptions: Subscription.aggregate<Model, Message, Resources>()(
			labShellSubscriptions<Model, Message>(toShell),
			own,
		),
	})
}
