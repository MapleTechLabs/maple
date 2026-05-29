// These attribute renderers now live in `@maple/ui` so the local-mode UI and
// (eventually) the native app share one implementation. This shim keeps the
// existing `@/components/attributes` import path working.
export {
	CopyableValue,
	AttributesTable,
	ResourceAttributesSection,
	tryParseJson,
	CollapsibleJsonValue,
	AttributesProvider,
	useAttributesConfig,
} from "@maple/ui/components/attributes"
export type { AttributesTableProps, AttributesConfig } from "@maple/ui/components/attributes"
