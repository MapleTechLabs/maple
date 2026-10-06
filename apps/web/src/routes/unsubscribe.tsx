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

	if (!token) {
		return (
			<AuthLayout maxWidth="max-w-md">
				<AuthLayout.Title>Invalid unsubscribe link</AuthLayout.Title>
				<AuthLayout.Description>
					This link is incomplete. Use the unsubscribe link from the email itself.
				</AuthLayout.Description>
			</AuthLayout>
		)
	}

	// Keyed so a same-route navigation to another email's link starts fresh.
	return <UnsubscribeConfirm key={token} token={token} />
}

function UnsubscribeConfirm({ token }: { token: string }) {
	const [state, setState] = useState<State>({ kind: "idle" })
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
				<AuthLayout.Title>You're unsubscribed</AuthLayout.Title>
				<AuthLayout.Description>
					You won't receive {label} anymore. You can turn it back on any time in your notification
					settings.
				</AuthLayout.Description>
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
			<AuthLayout.Title>Unsubscribe</AuthLayout.Title>
			<AuthLayout.Description>Stop receiving {label} from Maple?</AuthLayout.Description>
			{state.kind === "error" && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
			<div className="mt-4">
				<Button onClick={unsubscribe} loading={state.kind === "pending"}>
					Unsubscribe
				</Button>
			</div>
		</AuthLayout>
	)
}
