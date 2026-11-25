import type { AiCardGate } from "@maple/domain/billing"
import { Option, Schema } from "effect"

// `?ai=trial|no_plan` on a page lab: the context's `aiCardGate`, so the AI entry points draw as
// they do for an org whose Maple AI waits on a card. Absent off a browser (lab tests).

const decodeGate = Schema.decodeUnknownOption(Schema.Literals(["trial", "no_plan"]))

/** The lab context's AI card gate from the URL, spread into a `PageContext`. */
export const labAiCardGate = (): { readonly aiCardGate?: AiCardGate } =>
	Option.match(
		typeof globalThis.location === "undefined"
			? Option.none()
			: decodeGate(new URLSearchParams(globalThis.location.search).get("ai")),
		{ onNone: () => ({}), onSome: (aiCardGate) => ({ aiCardGate }) },
	)
