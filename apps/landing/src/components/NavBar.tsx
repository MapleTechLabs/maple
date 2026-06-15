import { useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import {
	NavigationMenu,
	NavigationMenuList,
	NavigationMenuItem,
	NavigationMenuTrigger,
	NavigationMenuContent,
	NavigationMenuLink,
} from "@maple/ui/components/ui/navigation-menu"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@maple/ui/components/ui/sheet"
import * as m from "../paraglide/messages"
import { ClerkProvider } from "./ClerkProvider"
import { formatStars } from "../lib/github-stars"
import { GithubStarButton, Octocat } from "./GithubStarButton"

const PUBLISHABLE_KEY = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY

function AuthAwareCTA() {
	const { isSignedIn, isLoaded } = useAuth()
	return isLoaded && isSignedIn ? m.nav_dashboard() : m.nav_get_started()
}

function CTAButton() {
	// Only use Clerk auth hook when the provider is actually available
	if (!PUBLISHABLE_KEY) {
		return m.nav_get_started()
	}
	return <AuthAwareCTA />
}

function NavBarInner({ locale = "en", stars }: { locale?: string; stars?: number | null }) {
	const [menuOpen, setMenuOpen] = useState(false)
	const l = (path: string) => (locale === "en" ? path : `/${locale}${path}`)

	const featureLinks = [
		{ href: l("/features/distributed-tracing"), label: () => m.nav_distributed_tracing() },
			{ href: l("/features/browser-sessions"), label: () => m.nav_browser_sessions() },
		{ href: l("/features/metrics-dashboards"), label: () => m.nav_metrics_dashboards() },
		{ href: l("/features/log-management"), label: () => m.nav_log_management() },
		{ href: l("/features/service-catalog"), label: () => m.nav_service_catalog() },
		{ href: l("/features/error-tracking"), label: () => m.nav_error_tracking() },
		{ href: l("/features/ai-mcp-integration"), label: () => m.nav_ai_mcp() },
		{ href: l("/features/kubernetes-monitoring"), label: () => m.nav_kubernetes() },
	]

	const useCaseLinks = [
		{ href: l("/use-cases/ecommerce-observability"), label: () => m.nav_ecommerce() },
		{ href: l("/use-cases/microservices-debugging"), label: () => m.nav_microservices() },
		{ href: l("/use-cases/api-performance"), label: () => m.nav_api_performance() },
	]

	const compareLinks = [
		{ href: l("/compare/datadog"), label: () => m.nav_vs_datadog() },
		{ href: l("/compare/grafana"), label: () => m.nav_vs_grafana() },
		{ href: l("/compare/new-relic"), label: () => m.nav_vs_new_relic() },
		{ href: l("/compare/dash0"), label: () => m.nav_vs_dash0() },
	]

	const integrationLinks = [
		{ href: l("/integrations/nextjs"), label: () => m.nav_nextjs() },
		{ href: l("/integrations/python"), label: () => m.nav_python() },
		{ href: l("/integrations/nodejs"), label: () => m.nav_nodejs() },
	]

	return (
		<div className="flex items-center justify-between h-full w-full">
			{/* Left group: Logo + Navigation */}
			<div className="flex items-center gap-1">
				<a href={l("/")} className="flex items-center gap-3 mr-2">
					<div className="w-7 h-7 bg-accent flex items-center justify-center">
						<span className="text-accent-foreground text-sm font-bold">M</span>
					</div>
					<span className="text-fg font-medium text-sm">Maple</span>
				</a>

				<NavigationMenu className="hidden sm:flex">
					<NavigationMenuList>
						<NavigationMenuItem>
							<NavigationMenuTrigger className="h-8 bg-transparent hover:bg-muted/20 text-fg-muted hover:text-fg">
								{m.nav_features()}
							</NavigationMenuTrigger>
							<NavigationMenuContent>
								<div className="grid grid-cols-2 gap-1 p-2">
									{featureLinks.map((link) => (
										<NavigationMenuLink
											key={link.href}
											href={link.href}
											className="whitespace-nowrap"
										>
											{link.label()}
										</NavigationMenuLink>
									))}
								</div>
							</NavigationMenuContent>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<NavigationMenuTrigger className="h-8 bg-transparent hover:bg-muted/20 text-fg-muted hover:text-fg">
								{m.nav_use_cases()}
							</NavigationMenuTrigger>
							<NavigationMenuContent>
								<div className="p-2 min-w-[220px]">
									{useCaseLinks.map((link) => (
										<NavigationMenuLink key={link.href} href={link.href}>
											{link.label()}
										</NavigationMenuLink>
									))}
								</div>
							</NavigationMenuContent>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<NavigationMenuTrigger className="h-8 bg-transparent hover:bg-muted/20 text-fg-muted hover:text-fg">
								{m.nav_integrations()}
							</NavigationMenuTrigger>
							<NavigationMenuContent>
								<div className="p-2 min-w-[220px]">
									{integrationLinks.map((link) => (
										<NavigationMenuLink key={link.href} href={link.href}>
											{link.label()}
										</NavigationMenuLink>
									))}
								</div>
							</NavigationMenuContent>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href={l("/pricing")}
								className="inline-flex h-8 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								{m.nav_pricing()}
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href={l("/roadmap")}
								className="inline-flex h-8 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								{m.nav_roadmap()}
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href={l("/local")}
								className="inline-flex h-8 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								Local
							</a>
						</NavigationMenuItem>

						<NavigationMenuItem>
							<a
								href="/docs"
								className="inline-flex h-8 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"
							>
								Docs
							</a>
						</NavigationMenuItem>
					</NavigationMenuList>
				</NavigationMenu>
			</div>

			{/* Right group: GitHub + CTA + Mobile menu */}
			<div className="flex items-center gap-3 sm:gap-6">
				<GithubStarButton stars={stars} className="hidden sm:inline-flex" />

				<a
					href="https://app.maple.dev"
					className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/80"
				>
					<CTAButton />
				</a>

				<button
					className="sm:hidden p-1.5 text-fg-muted hover:text-fg transition-colors"
					onClick={() => setMenuOpen(true)}
					aria-label="Open menu"
				>
					<svg
						className="w-5 h-5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="square"
					>
						<line x1="4" y1="6" x2="20" y2="6" />
						<line x1="4" y1="12" x2="20" y2="12" />
						<line x1="4" y1="18" x2="20" y2="18" />
					</svg>
				</button>
			</div>

			{/* Mobile menu sheet */}
			<Sheet open={menuOpen} onOpenChange={setMenuOpen}>
				<SheetContent side="right" className="w-full sm:max-w-sm bg-bg overflow-y-auto">
					<SheetHeader>
						<SheetTitle className="text-fg text-sm font-medium">Menu</SheetTitle>
					</SheetHeader>
					<nav className="flex flex-col px-4 pb-6">
						<div className="py-4 border-b border-border">
							<span className="text-[11px] text-accent uppercase tracking-wider font-medium">
								{m.nav_features()}
							</span>
							<div className="mt-3 flex flex-col gap-1">
								{featureLinks.map((link) => (
									<a
										key={link.href}
										href={link.href}
										onClick={() => setMenuOpen(false)}
										className="text-xs text-fg-muted hover:text-fg transition-colors py-2"
									>
										{link.label()}
									</a>
								))}
							</div>
						</div>

						<div className="py-4 border-b border-border">
							<span className="text-[11px] text-accent uppercase tracking-wider font-medium">
								{m.nav_use_cases()}
							</span>
							<div className="mt-3 flex flex-col gap-1">
								{useCaseLinks.map((link) => (
									<a
										key={link.href}
										href={link.href}
										onClick={() => setMenuOpen(false)}
										className="text-xs text-fg-muted hover:text-fg transition-colors py-2"
									>
										{link.label()}
									</a>
								))}
							</div>
						</div>

						<div className="py-4 border-b border-border">
							<span className="text-[11px] text-accent uppercase tracking-wider font-medium">
								{m.nav_integrations()}
							</span>
							<div className="mt-3 flex flex-col gap-1">
								{integrationLinks.map((link) => (
									<a
										key={link.href}
										href={link.href}
										onClick={() => setMenuOpen(false)}
										className="text-xs text-fg-muted hover:text-fg transition-colors py-2"
									>
										{link.label()}
									</a>
								))}
							</div>
						</div>

						<div className="py-4 border-b border-border flex flex-col gap-1">
							<a
								href={l("/pricing")}
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								{m.nav_pricing()}
							</a>
							<a
								href={l("/roadmap")}
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								{m.nav_roadmap()}
							</a>
							<a
								href={l("/local")}
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								Local
							</a>
							<a
								href="/docs"
								onClick={() => setMenuOpen(false)}
								className="text-xs text-fg hover:text-fg transition-colors py-2 font-medium"
							>
								Docs
							</a>
						</div>

						<div className="pt-6 flex flex-col gap-4">
							<a
								href="https://github.com/Makisuo/maple"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center justify-between text-xs text-fg-muted hover:text-fg transition-colors"
							>
								<span className="flex items-center gap-2">
									<Octocat className="w-4 h-4" />
									GitHub
								</span>
								{stars != null && <span className="tabular-nums">{formatStars(stars)}</span>}
							</a>
							<a
								href="https://app.maple.dev"
								className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all hover:bg-primary/80"
							>
								<CTAButton />
							</a>
						</div>
					</nav>
				</SheetContent>
			</Sheet>
		</div>
	)
}

export function NavBar({ locale = "en", stars }: { locale?: string; stars?: number | null }) {
	return (
		<ClerkProvider>
			<NavBarInner locale={locale} stars={stars} />
		</ClerkProvider>
	)
}
