import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/security/audit-log`, in the Security frame: every platform's audit events in one list, for org admins. */
export const page = definePage(
	"SecurityAuditLog",
	{ Model, Message },
	{
		routes: ["SecurityAuditLog"],
		key: () => "security-audit-log",
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: () => breadcrumbsOf("auditLog"),
	},
)
