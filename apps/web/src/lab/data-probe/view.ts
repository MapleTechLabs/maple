import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"

import type { WarehouseFailure } from "../../data/warehouse-error"
import { labRoot } from "../toasts"
import { Message, type Model, type ServicesFacets } from "./model"

const facetCount = (
	facets: AsyncData.AsyncData<ServicesFacets, WarehouseFailure>,
	group: keyof ServicesFacets,
): string =>
	AsyncData.match(facets, {
		onIdle: () => "idle",
		onLoading: () => "loading",
		onRefreshing: (data) => `${data[group].length} (refreshing)`,
		onFailure: (failure) => `failed (${failure.code ?? failure.reason})`,
		onStale: ({ data, error }) => `${data[group].length} (stale: ${error.code ?? error.reason})`,
		onSuccess: (data) => String(data[group].length),
	})

const line = (h: HtmlBuilder<Message>, label: string, value: string): Html => h.li([], [`${label}: ${value}`])

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.main(
		[h.Class("flex flex-col gap-4 p-6 text-sm")],
		[
			h.h1([h.Class("text-lg font-medium")], ["Data probe"]),
			h.ul(
				[h.AriaLabel("Counts"), h.AriaLive("polite")],
				[
					line(h, "Session", model.session),
					line(h, "Services", facetCount(model.facets.data, "services")),
					line(h, "Environments", facetCount(model.facets.data, "environments")),
					line(
						h,
						"Alert rules",
						model.alertRuleCount === null ? "loading" : String(model.alertRuleCount),
					),
				],
			),
			h.button(
				[h.Type("button"), h.Class("w-fit underline"), h.OnClick(Message.ClickedRefresh())],
				["Refresh"],
			),
		],
	)
