/**
 * The verdict card and the run-progress feed, in every state an investigation
 * can present them in.
 *
 * Four of the seven cases here cannot be produced on demand against a real
 * stack: a stalled pass, a pass that died mid-step, a report stored before
 * `headline` existed, and the few seconds before a run's first tool call. They
 * are also the states most likely to break, because they are the ones nobody
 * looks at while building the state beside them.
 */
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { VerdictCard } from "@/components/investigations/verdict-card"

import { VERDICT_LAB_CASES } from "./verdict-fixture"

export function VerdictLab() {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Verdict Lab" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="flex flex-col gap-10 py-2">
							{VERDICT_LAB_CASES.map((entry) => (
								<section key={entry.key} className="flex flex-col gap-3">
									<header className="flex flex-col gap-1">
										<h2 className="text-sm font-semibold text-foreground">
											{entry.title}
										</h2>
										<p className="max-w-3xl text-xs leading-5 text-muted-foreground">
											{entry.note}
										</p>
									</header>
									<VerdictCard investigation={entry.investigation} />
								</section>
							))}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
