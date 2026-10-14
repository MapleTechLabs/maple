import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { WorstCaseLab } from "@/lab/worst-case-lab"

const worstCaseSearchSchema = Schema.Struct({
	data: Schema.optional(Schema.Literals(["demo", "worst"])),
})

export const Route = createFileRoute("/lab/worst-case")({
	component: WorstCaseLabPage,
	validateSearch: Schema.toStandardSchemaV1(worstCaseSearchSchema),
})

function WorstCaseLabPage() {
	const { data } = Route.useSearch()
	const navigate = Route.useNavigate()
	return (
		<WorstCaseLab
			mode={data ?? "worst"}
			onModeChange={(mode) => navigate({ search: { data: mode }, replace: true })}
		/>
	)
}
