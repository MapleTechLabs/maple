import { definePage } from "../../contract"
import { Message, Model } from "./model"
import { pageCode } from "../../code"

/**
 * `/security/exposure` and `/security/runtimes` as one instance per org, in the Security frame:
 * telemetry the org already sends, so no code-audit plan gates them.
 */
export const entry = definePage(
	"SecurityTelemetry",
	{ Model, Message },
	{ routes: ["SecurityExposure", "SecurityRuntimes"], key: () => "security-telemetry" },
)

export const page = entry.lazy(pageCode.SecurityTelemetry)
