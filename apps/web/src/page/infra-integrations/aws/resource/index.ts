import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { titleOf, view } from "./view"

/** `/infra/aws/$kind/$name`: one resource's charts; another resource is a new instance. */
export const page = definePage(
	"InfraAwsResource",
	{ Model, Message },
	{
		routes: ["InfraAwsResource"],
		key: (route) =>
			`InfraAwsResource:${route.kind}:${route.name}:${route.search.cluster ?? ""}:${route.search.region ?? ""}:${route.search.account ?? ""}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "AWS", href: "/infra/aws" },
			{ label: titleOf(model) },
		],
	},
)
