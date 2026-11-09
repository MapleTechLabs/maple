import { Effect, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { Resources } from "../../platform/resources"
import * as Shell from "../../shell"
import { labShellSubscriptions } from "../app-shell"
import { defineLabWithFlags } from "../define"
import { Flags, init, Message, Model, toShell, update, view } from "../shell-states-lab"

// `/lab/shell`: sidebar group folding, the on-call pill's states and the URL-held right sheet.

const urlTarget: Dom.TypedEventTarget<{ popstate: PopStateEvent; "foldkit:urlchange": Event }> = window

const currentHref = () => Message.ChangedUrl({ href: `${window.location.pathname}${window.location.search}` })

/** Back, Forward and the lab's own pushes and replaces. */
const urlChanges: Stream.Stream<Message> = Stream.merge(
	Dom.streamFromEvent({ target: urlTarget, type: "popstate", mapEvent: currentHref }),
	Dom.streamFromEvent({ target: urlTarget, type: "foldkit:urlchange", mapEvent: currentHref }),
)

export const lab = defineLabWithFlags("Shell states", {
	Model,
	Flags,
	flags: Effect.all({
		shell: Shell.readShellFlags,
		href: Effect.sync(() => `${window.location.pathname}${window.location.search}`),
	}),
	init,
	update,
	view,
	subscriptions: Subscription.aggregate<Model, Message, Resources>()(
		labShellSubscriptions<Model, Message>(toShell),
		Subscription.make<Model, Message, Resources>()((entry) => ({
			url: entry({}, { modelToDependencies: () => ({}), dependenciesToStream: () => urlChanges }),
		})),
	),
})
