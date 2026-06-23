import { useEffect } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"
import {
	Navigate,
	Outlet,
	createRootRouteWithContext,
	redirect,
	useRouterState,
} from "@tanstack/react-router"
import { toast } from "sonner"
import { hasSelectedPlan, isUsableCustomer } from "@/lib/billing/plan-gating"
import { parseRedirectUrl } from "@/lib/redirect-utils"
import { Toaster } from "@maple/ui/components/ui/sonner"
import { AttributesProvider } from "@maple/ui/components/attributes"
import { renderAttributeValue } from "@/components/attributes/commit-sha-attribute"
import { highlightCode } from "@/lib/sugar-high"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import type { RouterAuthContext } from "@/router"
import { captureChatReferrer } from "@/components/chat/auto-contexts"
import { GlobalShortcuts } from "@/components/command-palette/global-shortcuts"

const PUBLIC_PATHS = new Set(["/sign-in", "/sign-up", "/org-required", "/service-map-bench"])

// Stable references so the AttributesProvider context value never changes
// identity across renders (avoids re-rendering every CopyableValue consumer).
const notifyCopied = (message?: string) => toast.success(message ?? "Copied to clipboard")

export const Route = createRootRouteWithContext<{ auth: RouterAuthContext }>()({
	beforeLoad: ({ context, location }) => {
		if (PUBLIC_PATHS.has(location.pathname)) return

		const redirectUrl = location.pathname + (location.searchStr ?? "")

		if (!context.auth?.isAuthenticated) {
			throw redirect({
				to: "/sign-in",
				search: { redirect_url: redirectUrl } as Record<string, string>,
			})
		}

		if (!context.auth.orgId) {
			throw redirect({
				to: "/org-required",
				search: { redirect_url: redirectUrl } as Record<string, string>,
			})
		}
	},
	component: RootComponent,
})

function AppFrame() {
	const pathname = useRouterState({ select: (s) => s.location.pathname })
	useEffect(() => {
		captureChatReferrer(pathname)
	}, [pathname])
	return (
		<AttributesProvider
			notifyCopied={notifyCopied}
			highlightJson={highlightCode}
			renderValue={renderAttributeValue}
		>
			<Outlet />
			<Toaster />
			{!PUBLIC_PATHS.has(pathname) && <GlobalShortcuts />}
		</AttributesProvider>
	)
}

function getRedirectTarget(searchStr: string, fallback = "/") {
	const params = new URLSearchParams(searchStr)
	const target = params.get("redirect_url")
	if (!target || !target.startsWith("/")) return parseRedirectUrl(fallback)
	return parseRedirectUrl(target)
}

function getSignUpRedirectTarget(searchStr: string) {
	const target = new URLSearchParams(searchStr).get("redirect_url")
	if (!target || target === "/" || !target.startsWith("/")) {
		return parseRedirectUrl("/quick-start")
	}
	return parseRedirectUrl(target)
}

function ClerkReverseRedirects() {
	const { pathname, searchStr } = useRouterState({
		select: (state) => ({
			pathname: state.location.pathname,
			searchStr: state.location.searchStr,
		}),
	})
	const { isSignedIn, orgId } = useAuth()
	// Autumn customers are keyed by orgId, so getOrCreateCustomer can only
	// succeed once an org is active. Skip the fetch for signed-out/org-less
	// onboarding sessions (e.g. /sign-up, /org-required) to avoid guaranteed 401s.
	const {
		data: customer,
		isLoading: isCustomerLoading,
		error: customerError,
	} = useMapleCustomer({ queryOptions: { enabled: Boolean(isSignedIn && orgId) } })

	const redirectUrl = pathname + (searchStr ?? "")
	const selectedPlan = hasSelectedPlan(customer)

	if (isSignedIn && pathname === "/sign-in") {
		const target = getRedirectTarget(searchStr)
		return <Navigate to={target.pathname} search={target.search} replace />
	}

	if (isSignedIn && pathname === "/sign-up") {
		const target = getSignUpRedirectTarget(searchStr)
		return <Navigate to={target.pathname} search={target.search} replace />
	}

	if (isSignedIn && orgId && pathname === "/org-required") {
		const target = getRedirectTarget(searchStr)
		return <Navigate to={target.pathname} search={target.search} replace />
	}

	if (isSignedIn && orgId) {
		// If Autumn is down — or returns an error-shaped `200` payload that isn't
		// a usable customer — let users through rather than blocking them. Without
		// this, a malformed customer falls through as "no plan" and bounces the
		// user into /quick-start onboarding.
		if (customerError || (customer && !isUsableCustomer(customer))) {
			return <AppFrame />
		}
		// Dev-only: `?quota_preview=` forces the usage-alert banner for visual
		// review; render the shell without waiting on the customer query (which
		// may stall when Autumn isn't configured locally).
		const quotaPreview =
			import.meta.env.DEV &&
			typeof window !== "undefined" &&
			window.location.search.includes("quota_preview")
		// Apply plan-gating only once the customer query has settled. While it's
		// still loading/retrying, fall through and render the dashboard instead of
		// blanking the screen (`return null`) — the redirect, if any, fires on the
		// next render once we actually know the plan, so we never bounce a paying
		// user to /quick-start before their plan is known.
		if (!isCustomerLoading || quotaPreview) {
			const ALLOWED_WITHOUT_PLAN = ["/select-plan", "/quick-start"]
			if (!selectedPlan && !quotaPreview && !ALLOWED_WITHOUT_PLAN.includes(pathname)) {
				return <Navigate to="/quick-start" search={{ redirect_url: redirectUrl }} replace />
			}
			if (selectedPlan && pathname === "/select-plan") {
				const target = getRedirectTarget(searchStr)
				return <Navigate to={target.pathname} search={target.search} replace />
			}
		}
	}

	return <AppFrame />
}

function RootComponent() {
	if (!isClerkAuthEnabled) {
		return <AppFrame />
	}

	return <ClerkReverseRedirects />
}
