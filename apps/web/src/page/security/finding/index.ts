import { definePage } from "../../contract"
import { Message } from "./model"
import { Model } from "./model"

/** `/security/findings/$targetId/$fingerprint`: one instance per finding. */
export const entry = definePage(
	"SecurityFinding",
	{ Model, Message },
	{ routes: ["SecurityFinding"], key: (route) => `${route.targetId}/${route.fingerprint}` },
)

export const page = entry.lazy(() => import("./implementation"))
