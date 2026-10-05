/**
 * The footer link of every digest email. Public: the signed `token` is the
 * credential, so a recipient can opt out without signing in.
 *
 * Unsubscribing waits for a click because mail security scanners prefetch links;
 * mail clients that support one-click POST to the API directly instead.
 */
import { Link, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { useState } from "react"
import { AuthLayout } from "@/components/layout/auth-layout"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { Button } from "@maple/ui/components/ui/button"

const UnsubscribeSearch = Schema.Struct({
	token: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/unsubscribe")({
	component: UnsubscribePage,
	validateSearch: Schema.toStandardSchemaV1(UnsubscribeSearch),
})

const labelForToken = (token: string) => {
	const kind = token.split(".")[0]
	if (kind === "digest") return "the weekly digest"
	if (kind === "web-analytics") return "the weekly web analytics email"
	return "these emails"
}

type State = { kind: "idle" } | { kind: "pending" } | { kind: "done" } | { kind: "error"; message: string }

function UnsubscribePage() {
	const { token } = Route.useSearch()
	const [state, setState] = useState<State>({ kind: "idle" })

	if (!token) {
		return (
			<AuthLayout maxWidth="max-w-md">
				<h1 className="text-xl font-semibold">Invalid unsubscribe link</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					This link is incomplete. Use the unsubscribe link from the email itself.
				</p>
			</AuthLayout>
		)
	}

	const label = labelForToken(token)

	const unsubscribe = async () => {
		setState({ kind: "pending" })
		const response = await fetch(
			`${apiBaseUrl}/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
			{ method: "POST" },
		).catch(() => undefined)
		if (response?.ok) return setState({ kind: "done" })
		setState({
			kind: "error",
			message:
				response?.status === 400
					? "This unsubscribe link is invalid. Use the link from the email itself."
					: "Something went wrong. Please try again.",
		})
	}

	if (state.kind === "done") {
		return (
			<AuthLayout maxWidth="max-w-md">
				<h1 className="text-xl font-semibold">You're unsubscribed</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					You won't receive {label} anymore. You can turn it back on any time in your notification
					settings.
				</p>
				<div className="mt-4">
					<Button
						variant="outline"
						render={<Link to="/settings" search={{ tab: "notifications" }} />}
					>
						Notification settings
					</Button>
				</div>
			</AuthLayout>
		)
	}

	return (
		<AuthLayout maxWidth="max-w-md">
			<h1 className="text-xl font-semibold">Unsubscribe</h1>
			<p className="mt-2 text-sm text-muted-foreground">Stop receiving {label} from Maple?</p>
			{state.kind === "error" && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
			<div className="mt-4">
				<Button onClick={unsubscribe} disabled={state.kind === "pending"}>
					{state.kind === "pending" ? "Unsubscribing..." : "Unsubscribe"}
				</Button>
			</div>
		</AuthLayout>
	)
}
