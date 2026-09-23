/**
 * Facts about Maple Cloud's EU region, shared by `/eu`, its `/eu.md` twin and
 * the docs. The hostnames match the deployed instance (`*.eu.maple.dev`).
 */
export const US_APP_URL = "https://app.maple.dev"
export const US_INGEST_URL = "https://ingest.maple.dev"
export const EU_APP_URL = "https://app.eu.maple.dev"
export const EU_INGEST_URL = "https://ingest.eu.maple.dev"

export interface FaqItem {
	question: string
	answer: string
}

export function euFaqs(): FaqItem[] {
	return [
		{
			question: "Where is the EU region hosted?",
			answer: "In Frankfurt, Germany. An EU organization's telemetry is ingested, stored and queried there, and its alerts are evaluated there.",
		},
		{
			question: "How do I choose the EU region?",
			answer: "Sign up as usual. The first onboarding step asks where your data should live. Choose European Union and onboarding continues in the EU dashboard at app.eu.maple.dev. Send telemetry to ingest.eu.maple.dev with an ingest key created there.",
		},
		{
			question: "Can I move an existing organization to the EU?",
			answer: "No. The region is fixed when the organization is created, so data never has to be migrated between regions. Create a new organization in the EU region and point your exporters at the EU ingest endpoint.",
		},
		{
			question: "Is every feature available in the EU region?",
			answer: "Everything except AI chat, which is not available in the EU region yet. Traces, logs, metrics, session replay, dashboards and alerting work the same in both regions.",
		},
		{
			question: "Does the EU region cost more?",
			answer: "No. The plan, the included volume and the per-GB rates are the same in both regions.",
		},
		{
			question: "Do I need a separate account?",
			answer: "No. One Maple login works in both regions. The organization switcher labels each organization US or EU and opens it in its own dashboard.",
		},
		{
			question: "Is Maple SOC 2 or ISO 27001 certified?",
			answer: "Not yet. SOC 2 and ISO 27001 certification are in progress.",
		},
		{
			question: "Can I keep the data inside my own network instead?",
			answer: "Yes. Maple's source is on GitHub under FSL-1.1, and you can run the whole platform on your own infrastructure in whichever region you like.",
		},
	]
}
