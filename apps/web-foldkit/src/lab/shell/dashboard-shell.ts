import type { Html, HtmlBuilder } from "foldkit/html"
import { appSidebar } from "./sidebar"
import { appTopbar } from "./topbar"

/**
 * `DashboardLayout.Root > Breadcrumbs > Body > Content > Scroll` (apps/web
 * `components/layout/dashboard-layout.tsx`) as rendered for a signed-out lab page:
 * sidebar, topbar with the page title, and the scrollable page area holding `content`.
 */
export const dashboardShell = <Message>(h: HtmlBuilder<Message>, title: string, content: Html): Html =>
	h.div(
		[
			h.Class("group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar"),
			h.Attribute("data-slot", "sidebar-wrapper"),
			h.Style({ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" }),
		],
		[
			appSidebar(h),
			h.main(
				[
					h.Class(
						"relative flex h-svh w-full min-h-0 min-w-0 flex-1 flex-col bg-background md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5",
					),
					h.Attribute("data-slot", "sidebar-inset"),
				],
				[
					h.a(
						[
							h.Class(
								"sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground",
							),
							h.Attribute("href", "#main-content"),
						],
						["Skip to main content"],
					),
					h.div(
						[h.Class("flex min-h-0 flex-1 flex-col"), h.Attribute("data-slot", "page-layout")],
						[
							appTopbar(h, title),
							h.div(
								[
									h.Class("flex min-h-0 flex-1 overflow-hidden"),
									h.Attribute("data-slot", "page-body"),
								],
								[
									h.main(
										[
											h.Class("@container/page flex min-h-0 min-w-0 flex-1 flex-col"),
											h.Attribute("data-slot", "page-content"),
											h.Id("main-content"),
										],
										[
											h.div(
												[
													h.Class("flex min-h-0 flex-1 flex-col overflow-auto p-4"),
													h.Attribute("data-slot", "page-scroll-area"),
												],
												[content],
											),
										],
									),
								],
							),
						],
					),
				],
			),
		],
	)
