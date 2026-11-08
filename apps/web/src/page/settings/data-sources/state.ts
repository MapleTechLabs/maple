import type { V2DataSource } from "@maple/domain/http/v2"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import { PageOutMessage, type PageReturn } from "../../contract"
import type { Message, Model } from "./model"

// Helpers both halves of the tab's update share.

export type Return = PageReturn<Model, Message>

export const toast = (type: "default" | "success" | "error" | "info", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

export const sourceById = (model: Model, id: string): Option.Option<V2DataSource> =>
	Option.flatMap(Option.fromNullishOr(AsyncData.getOrElse(model.sources, () => null)), (sources) =>
		Arr.findFirst(sources, (source) => source.id === id),
	)

export const withSource = (model: Model, saved: V2DataSource): Model => ({
	...model,
	sources: AsyncData.map(model.sources, (sources) =>
		Arr.some(sources, (source) => source.id === saved.id)
			? Arr.map(sources, (source) => (source.id === saved.id ? saved : source))
			: Arr.append(sources, saved),
	),
})

