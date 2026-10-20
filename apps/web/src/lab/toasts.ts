import { Option } from "effect"
import { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Toast from "../ui/toast"
import * as ToastView from "../ui/toast-view"

// Every lab page has the app's toasts too: a lab Model holds `toasts` and its
// view renders the page inside `#app` with both Notifications regions after it.

export const initLabToasts = (): Toast.Model => Toast.init("lab-toasts")

export const foldLabToasts = <Model extends { readonly toasts: Toast.Model }, Message>(
	toParentMessage: (message: Toast.Message) => Message,
) =>
	Update.foldChild({
		update: Toast.update,
		read: (model: Model) => Option.some(model.toasts),
		write: (model: Model, toasts: Toast.Model): Model => ({ ...model, toasts }),
		toParentMessage,
	})

export const labRoot = <Message>(
	h: HtmlBuilder<Message>,
	toasts: Toast.Model,
	toParentMessage: (message: Toast.Message) => Message,
	page: Html,
): Html => h.div([h.Id("app")], [page, ...ToastView.regions(h, toasts, toParentMessage)])
