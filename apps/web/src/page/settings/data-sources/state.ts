import type { DataSourceKind } from "@maple/domain/data-sources"
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

/**
 * Whether sources of this kind can withhold personal data from agents, as the API says of the
 * source being edited or of another of its kind. `null` before any such source exists.
 */
export const piiRedactionOf = (model: Model, kind: DataSourceKind, editing: string | null): boolean | null =>
	Option.getOrNull(
		Option.map(
			Option.orElse(
				Option.flatMap(Option.fromNullishOr(editing), (id) => sourceById(model, id)),
				() =>
					Arr.findFirst(
						AsyncData.getOrElse(model.sources, (): ReadonlyArray<V2DataSource> => []),
						(source) => source.kind === kind,
					),
			),
			(source) => source.supports_pii_redaction,
		),
	)

export const withSource = (model: Model, saved: V2DataSource): Model => ({
	...model,
	sources: AsyncData.map(model.sources, (sources) =>
		Arr.some(sources, (source) => source.id === saved.id)
			? Arr.map(sources, (source) => (source.id === saved.id ? saved : source))
			: Arr.append(sources, saved),
	),
})
