import { Option } from "effect"
import { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message as ShellMessage } from "../shell/message"
import type { Model as ShellModel } from "../shell/model"
import { update as shellUpdate } from "../shell/update"
import { type BreadcrumbEntry, frameView, menuLayerView, sheetLayerView } from "../shell/view"

// The shell frame a lab page renders in, kept off the shell barrel (its streams read `window` on
// import) so a lab's own logic can run in a scene test.

/** Folds Shell Messages; a lab page has no queries to rebuild on a namespace pin. */
export const foldLabShell = <Model extends { readonly shell: ShellModel }, Message>(
	toParentMessage: (message: ShellMessage) => Message,
) =>
	Update.foldChild({
		update: shellUpdate,
		read: (model: Model) => Option.some(model.shell),
		write: (model: Model, shell: ShellModel): Model => ({ ...model, shell }),
		toParentMessage,
		foldOutMessage: () => (model: Model) => ({ model }),
	})

/** The frame around the page, then the mobile sheet and menu layers (the root's `shellRoute`). */
export const labShellView = <Message>(
	h: HtmlBuilder<Message>,
	shell: ShellModel,
	toParentMessage: (message: ShellMessage) => Message,
	frame: Readonly<{
		currentPath: string
		breadcrumbs: ReadonlyArray<BreadcrumbEntry>
		page: () => Html
	}>,
): ReadonlyArray<Html> => [
	h.submodel({
		slotId: "shell-frame",
		model: shell,
		view: frameView,
		toParentMessage,
		viewInputs: { ...frame, topbarActions: () => null },
	}),
	h.submodel({
		slotId: "shell-sheet",
		model: shell,
		view: sheetLayerView,
		toParentMessage,
		viewInputs: { currentPath: frame.currentPath },
	}),
	h.submodel({
		slotId: "shell-menu",
		model: shell,
		view: menuLayerView,
		toParentMessage,
		viewInputs: { currentPath: frame.currentPath },
	}),
]
