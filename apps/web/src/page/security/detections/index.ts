import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/security/detections`, in the Security frame: the alert rules that count audit events, for org admins. */
export const page = definePage(
	"SecurityDetections",
	{ Model, Message },
	{
		routes: ["SecurityDetections"],
		key: () => "security-detections",
		init,
		update,
		view,
		breadcrumbs: () => breadcrumbsOf("detections"),
	},
)
