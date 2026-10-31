import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../../code"

/** `/infra/aws/$kind/$name`: one resource's charts; another resource is a new instance. */
export const entry = definePage(
	"InfraAwsResource",
	{ Model, Message },
	{
		routes: ["InfraAwsResource"],
		key: (route) =>
			`InfraAwsResource:${route.kind}:${route.name}:${route.search.cluster ?? ""}:${route.search.region ?? ""}:${route.search.account ?? ""}`,
	},
)

export const page = entry.lazy(pageCode.InfraAwsResource)
