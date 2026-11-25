import { definePage } from "../../contract"
import { settingsTabLabels } from "../nav"
import { rolesHref } from "../roles/roles"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/settings/roles/:roleId`: one instance per role. */
export const page = definePage(
	"RoleEditor",
	{ Model, Message },
	{
		routes: ["RoleEditor"],
		key: (route) => route.roleId,
		init,
		update,
		view,
		breadcrumbs: () => [
			{ label: "Settings", href: "/settings" },
			{ label: settingsTabLabels.roles, href: rolesHref() },
		],
	},
)
