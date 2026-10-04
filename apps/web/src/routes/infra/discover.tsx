import { createFileRoute, redirect } from "@tanstack/react-router"

// The overview carries the "Add a source" strip now.
export const Route = createFileRoute("/infra/discover")({
	beforeLoad: () => {
		throw redirect({ to: "/infra", replace: true })
	},
})
