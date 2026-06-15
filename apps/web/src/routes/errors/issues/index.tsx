import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Legacy path — the issues list merged into the main Errors page. Maps the old
 * single-value `?workflowState=/severity=/kind=` deep links onto the new
 * multi-select array params so bookmarks keep working.
 */
function single(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value !== "all" ? value : undefined
}

export const Route = createFileRoute("/errors/issues/")({
	validateSearch: (search: Record<string, unknown>) => ({
		workflowState: typeof search.workflowState === "string" ? search.workflowState : undefined,
		severity: typeof search.severity === "string" ? search.severity : undefined,
		kind: typeof search.kind === "string" ? search.kind : undefined,
	}),
	beforeLoad: ({ search }) => {
		const workflowState = single(search.workflowState)
		const severity = single(search.severity)
		const kind = single(search.kind)
		throw redirect({
			to: "/errors",
			search: {
				workflowState: workflowState ? [workflowState] : undefined,
				severity: severity ? [severity] : undefined,
				kind: kind ? [kind] : undefined,
			},
		})
	},
})
