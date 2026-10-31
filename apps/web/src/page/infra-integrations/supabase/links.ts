import { encodeLogAttributeFilter } from "../../../lib/logs/log-attribute-filters"
import { AppRoute, hrefOf } from "../../../route"

// Links out of the Supabase pages.

type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

/** The logs page on the polled Supabase logs (one project's with a ref), over the same time range. */
export const supabaseLogsHref = (search: TimeSearch, projectRef?: string): string =>
	hrefOf(
		AppRoute.Logs({
			search: {
				startTime: search.startTime,
				endTime: search.endTime,
				timePreset: search.timePreset,
				services: ["supabase"],
				attrs:
					projectRef === undefined
						? undefined
						: [
								encodeLogAttributeFilter({
									source: "resource",
									key: "supabase.project.ref",
									value: projectRef,
									negated: false,
								}),
							],
			},
		}),
	)

/** The project in Supabase's own dashboard. */
export const supabaseDashboardHref = (projectRef: string): string =>
	`https://supabase.com/dashboard/project/${encodeURIComponent(projectRef)}`
