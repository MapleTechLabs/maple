import { createFileRoute, redirect } from "@tanstack/react-router"

// Host detail moved under /infra/hosts when /infra became the overview.
export const Route = createFileRoute("/infra/$hostName")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: "/infra/hosts/$hostName", params, replace: true })
	},
})
