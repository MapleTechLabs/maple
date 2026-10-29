import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/anomalies/$incidentId`: one instance per incident. */
export const entry = definePage(
	"Anomaly",
	{ Model, Message },
	{ routes: ["Anomaly"], key: (route) => route.incidentId },
)

export const page = entry.lazy(() => import("./implementation"))
