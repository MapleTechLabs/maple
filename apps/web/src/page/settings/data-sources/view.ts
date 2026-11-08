import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { errorState } from "@maple/views/ui/error-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { vstack } from "@maple/views/ui/stack"
import { Message, type Model } from "./model"
import { sourceById } from "./state"
import { detailView } from "./view-detail"
import { formView } from "./view-form"
import { connectButton, listView, pickKindView } from "./view-list"
import type { Inputs } from "./view-parts"

// Settings -> Data sources: the list, then a kind picker, a form or one source in its place.

type H = HtmlBuilder<Message>

const loading = (h: H): Html => vstack(h, { gap: "3" }, [skeleton(h, "h-6 w-48"), skeleton(h, "h-40 w-full")])

const screenView = (h: H, model: Model, inputs: Inputs): Html => {
	const screen = model.screen
	switch (screen._tag) {
		case "PickKind":
			return pickKindView(h)
		case "Form":
			return formView(h, model, screen.kind, screen.editing)
		case "Detail":
			return Option.match(sourceById(model, screen.id), {
				onNone: () => listOrState(h, model, inputs),
				onSome: (source) => detailView(h, model, source, inputs),
			})
		case "List":
			return listOrState(h, model, inputs)
	}
}

const listOrState = (h: H, model: Model, inputs: Inputs): Html =>
	AsyncData.match(model.sources, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) => errorState(h, { failure, title: "Could not load data sources" }),
		onSuccess: (sources) => listView(h, sources, inputs),
		onRefreshing: (sources) => listView(h, sources, inputs),
		onStale: ({ data }) => listView(h, data, inputs),
	})

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	screenView(h, model, inputs),
)

/** The list's primary action, drawn in the settings page header beside the `<h1>`. */
export const headerActions = Submodel.defineView<Model, Message, Readonly<{ canManage: boolean }>>(
	(model, inputs, h) =>
		inputs.canManage &&
		model.screen._tag === "List" &&
		AsyncData.getOrElse(model.sources, () => []).length > 0
			? connectButton(h)
			: h.empty,
)
