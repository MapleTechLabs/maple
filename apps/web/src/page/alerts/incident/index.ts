import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/alerts/incidents/$incidentId`: one instance per incident. */
export const entry = definePage(
	"AlertIncident",
	{ Model, Message },
	{ routes: ["AlertIncident"], key: (route) => route.incidentId },
)

export const page = entry.lazy(pageCode.AlertIncident)
