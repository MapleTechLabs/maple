import * as React from "react"

import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@maple/ui/components/ui/sidebar"
import { Separator } from "@maple/ui/components/ui/separator"
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@maple/ui/components/ui/breadcrumb"
import { PageLayout } from "@maple/ui/components/ui/page-layout"
import { Button } from "@maple/ui/components/ui/button"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { ChatBubbleSparkleIcon, LayoutLeftIcon, LayoutRightIcon } from "@/components/icons"
import { openGlobalChat } from "@/components/chat/global-chat-sheet"
import { ConnectButton } from "@/components/header/connect-button"
import { OnboardingChecklistButton } from "@/components/header/onboarding-checklist-button"
import { QuotaBanner } from "@/components/billing/quota-banner"
import { PaymentFailedBanner } from "@/components/billing/payment-failed-banner"
import { SubscriptionEndedBanner } from "@/components/billing/subscription-ended-banner"
import { AppUpdateBanner } from "@/components/layout/app-update-banner"
import { Link } from "@tanstack/react-router"
import { parseSearchFromHref } from "@/lib/href"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { cn } from "@maple/ui/lib/utils"

/* -------------------------------------------------------------------------------------------------
 * DashboardLayout — the app's page shell, as a compound component.
 *
 * Presence is composition: a page has a filter sidebar because it renders
 * `<DashboardLayout.Filters>`, not because it passed a `filterSidebar` prop that
 * the shell then had to test for. That removed six ReactNode slot props and the
 * `hasHeader = title || titleContent || description || headerActions` derivation
 * they forced.
 *
 * The nesting is real, not decorative: `Filters | Content | RightPanel` are flex
 * siblings inside `Body`, and `Sticky | Scroll` stack inside `Content`. Slot
 * registration through context or portals could hide that, but both need an
 * effect or a DOM node that doesn't exist during SSR — so the tree you write is
 * the tree that renders.
 *
 * `breadcrumbs` stays a prop because it is data (a `{label, href}[]`), not
 * composition.
 * -----------------------------------------------------------------------------------------------*/

export interface BreadcrumbEntry {
	label: string
	href?: string
}

/** Sidebar + inset + skip link + `PageLayout.Root`. Everything else composes inside. */
function Root({ children }: { children: React.ReactNode }) {
	return (
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<a
					href="#main-content"
					className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground"
				>
					Skip to main content
				</a>
				<PageLayout.Root>{children}</PageLayout.Root>
			</SidebarInset>
		</SidebarProvider>
	)
}

/**
 * The top bar: sidebar trigger, breadcrumb trail, and the persistent right-hand
 * cluster (AI chat, connection status, the mobile filter trigger). `children` are
 * extra page-specific actions, appended to that cluster.
 */
const CRUMB_LABEL = "block max-w-[40ch] truncate"

function Breadcrumbs({
	items,
	children,
}: {
	items: ReadonlyArray<BreadcrumbEntry>
	children?: React.ReactNode
}) {
	return (
		<header data-slot="app-topbar" className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
			<SidebarTrigger className="-ml-1" />
			<Separator orientation="vertical" className="mr-2 h-4" />
			{/* One line inside the fixed h-16 bar: long names truncate instead of wrapping under it. */}
			<Breadcrumb className="min-w-0 flex-1">
				<BreadcrumbList className="flex-nowrap">
					{items.map((item, index) => (
						<React.Fragment key={index}>
							{index > 0 && <BreadcrumbSeparator className="shrink-0" />}
							<BreadcrumbItem className="min-w-0" title={item.label}>
								{item.href ? (
									(() => {
										const { pathname, search } = parseSearchFromHref(item.href)
										if (!search) {
											return (
												<BreadcrumbLink
													render={<Link to={pathname} />}
													className={CRUMB_LABEL}
												>
													{item.label}
												</BreadcrumbLink>
											)
										}
										return (
											<BreadcrumbLink
												render={<Link to={pathname} search={search as never} />}
												className={CRUMB_LABEL}
											>
												{item.label}
											</BreadcrumbLink>
										)
									})()
								) : (
									<BreadcrumbPage className={CRUMB_LABEL}>{item.label}</BreadcrumbPage>
								)}
							</BreadcrumbItem>
						</React.Fragment>
					))}
				</BreadcrumbList>
			</Breadcrumb>
			<div className="ml-auto flex shrink-0 items-center gap-2">
				<IconButton variant="outline" label="Ask Maple AI" shortcut="C" onClick={openGlobalChat}>
					<ChatBubbleSparkleIcon />
				</IconButton>
				<OnboardingChecklistButton />
				<ConnectButton />
				{/* Self-gating: renders only when the sidebar has collapsed to a sheet *and* a
				    `Filters` region is mounted to open. Both conditions live in `PageLayout`'s
				    context, so a page that composes no `Filters` gets no button here. */}
				<PageLayout.FilterSidebarTrigger>
					<Button variant="outline" size="icon-sm" aria-label="Open filters">
						<LayoutLeftIcon />
					</Button>
				</PageLayout.FilterSidebarTrigger>
				{/* Same self-gating for the trailing context rail, which is inline above
				    `lg` and a sheet below it. */}
				<PageLayout.RightSidebarTrigger>
					<Button variant="outline" size="icon-sm" aria-label="Open context">
						<LayoutRightIcon />
					</Button>
				</PageLayout.RightSidebarTrigger>
				{children}
			</div>
		</header>
	)
}

/** App-shell banners + the horizontal `Filters | Content | RightPanel` row. */
function Body({ children }: { children: React.ReactNode }) {
	return (
		<>
			{/* Ungated, unlike the billing banners below: a stale bundle is stale
			    whether or not the deployment uses Clerk, and self-hosted installs
			    have the same long-lived-tab problem. */}
			<AppUpdateBanner />
			{isClerkAuthEnabled && <SubscriptionEndedBanner />}
			{isClerkAuthEnabled && <PaymentFailedBanner />}
			{isClerkAuthEnabled && <QuotaBanner />}
			<PageLayout.Body>{children}</PageLayout.Body>
		</>
	)
}

/** Filter rail, flush left of the content and full height. A sheet below `lg`. */
/** `width` is a Tailwind class, forwarded for rails whose content needs more than `w-64`. */
function Filters({ children, width }: { children: React.ReactNode; width?: string }) {
	return <PageLayout.FilterSidebar width={width}>{children}</PageLayout.FilterSidebar>
}

/** The main column: `Sticky` (optional) above `Scroll`. */
function Content({ children }: { children: React.ReactNode }) {
	return <PageLayout.Content>{children}</PageLayout.Content>
}

/** Pinned above the scroll area — the page header, and anything else that shouldn't scroll away. */
function Sticky({ children, className }: { children: React.ReactNode; className?: string }) {
	return <PageLayout.StickyArea className={className}>{children}</PageLayout.StickyArea>
}

/**
 * The page header row, with `children` as the right-aligned actions.
 *
 * There is no plain title or description: the breadcrumb trail already names the
 * page. `titleContent` is for headers that carry more than a name (an issue's
 * status strip, a service dot, an editable dashboard name, view tabs).
 */
function Header({ titleContent, children }: { titleContent?: React.ReactNode; children?: React.ReactNode }) {
	return (
		<PageLayout.Header titleContent={titleContent}>
			{children && <PageLayout.HeaderActions>{children}</PageLayout.HeaderActions>}
		</PageLayout.Header>
	)
}

/** Centred column caps for a page body. `reading` suits prose and detail pages, `narrow` forms. */
const PAGE_WIDTH = {
	full: null,
	reading: "mx-auto max-w-4xl",
	narrow: "mx-auto max-w-3xl",
} as const

/** Vertical rhythm between a body's top-level blocks. */
const PAGE_GAP = {
	none: null,
	sm: "gap-3",
	md: "gap-4",
	lg: "gap-6",
} as const

export type PageWidth = keyof typeof PAGE_WIDTH
export type PageGap = keyof typeof PAGE_GAP

/**
 * The scrolling page body. `width` centres the content in a capped column and `gap`
 * spaces its top-level children, so routes stop wrapping the body in
 * `mx-auto max-w-* space-y-*` divs of their own.
 */
function Scroll({
	children,
	className,
	width = "full",
	gap = "none",
}: {
	children: React.ReactNode
	className?: string
	width?: PageWidth
	gap?: PageGap
}) {
	if (width === "full") {
		return (
			<PageLayout.ScrollArea className={cn(PAGE_GAP[gap], className)}>{children}</PageLayout.ScrollArea>
		)
	}
	return (
		<PageLayout.ScrollArea className={className}>
			<div
				data-slot="page-column"
				className={cn("flex w-full flex-col", PAGE_WIDTH[width], PAGE_GAP[gap])}
			>
				{children}
			</div>
		</PageLayout.ScrollArea>
	)
}

/**
 * Page-level tabs (view switch, section tabs). Goes inside `Sticky`, after `Header`, so
 * every tabbed page puts its tab strip in the same place and it never scrolls away.
 */
function Tabs({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<div data-slot="page-tabs" className={cn("min-w-0", className)}>
			{children}
		</div>
	)
}

/**
 * `Scroll`'s counterpart for a page whose content owns its own scrolling — the
 * investigation transcript, for instance. Fills the remaining height and scrolls
 * nothing, so the inner pane never needs a `calc()` height guess.
 */
function Fill({ children }: { children: React.ReactNode }) {
	return <PageLayout.Fill>{children}</PageLayout.Fill>
}

/** Trailing context rail. Inline above `lg`, a sheet behind a header trigger below it. */
function RightPanel({
	children,
	title,
	/** Widen past the `w-72` default where the rail carries the page's substance. */
	width,
	open,
	onOpenChange,
}: {
	children: React.ReactNode
	title?: string
	width?: string
	open?: boolean
	onOpenChange?: (open: boolean) => void
}) {
	return (
		<PageLayout.RightSidebar title={title} width={width} open={open} onOpenChange={onOpenChange}>
			{children}
		</PageLayout.RightSidebar>
	)
}

export const DashboardLayout = {
	Root,
	Breadcrumbs,
	Body,
	Filters,
	Content,
	Sticky,
	Header,
	Scroll,
	Tabs,
	Fill,
	RightPanel,
	/** Escape hatch for a page whose title is more than a string (a badge, a service dot). */
	Title: PageLayout.Title,
	Description: PageLayout.Description,
}
