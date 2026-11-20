/** Names Prometheus' legacy scheme accepts as they are. */
const LEGACY_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * A label name in the legacy (underscore) scheme the stored labels use: other characters become `_`,
 * runs collapse, a leading digit gets `_`. So `"http.route"` addresses the label `http_route`.
 */
export const escapeLabelName = (name: string): string => {
	if (name === "" || LEGACY_LABEL_NAME.test(name)) return name
	const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_")
	return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}
