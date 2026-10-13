import { createFileRoute } from "@tanstack/react-router"

import { CodeReviewLayout } from "@/components/code-review/code-review-layout"
import { CodeReviewSettingsView } from "@/components/code-review/code-review-settings"

export const Route = createFileRoute("/code-review/settings")({
	component: CodeReviewSettingsPage,
})

function CodeReviewSettingsPage() {
	return (
		<CodeReviewLayout active="settings" search={{}}>
			<CodeReviewSettingsView />
		</CodeReviewLayout>
	)
}
