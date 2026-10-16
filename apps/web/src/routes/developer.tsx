import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Legacy path: the Developer page duplicated the Ingestion and API Keys settings tabs.
 * `?tab=ingestion` keeps its meaning; everything else lands on API Keys.
 */
export const Route = createFileRoute("/developer")({
	validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
		tab: typeof search.tab === "string" ? search.tab : undefined,
	}),
	beforeLoad: ({ search }) => {
		throw redirect({
			to: "/settings",
			search: { tab: search.tab === "ingestion" ? "ingestion" : "api-keys" },
			replace: true,
		})
	},
})
