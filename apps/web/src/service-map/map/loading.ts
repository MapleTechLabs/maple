import "@maple/ui/components/service-map/service-map.css"
import type { Html, HtmlBuilder } from "foldkit/html"

// `ServiceMapLoading` (packages/ui `service-map/service-map-loading.tsx`): a fixed ghost topology,
// generated once since it carries no data.

export const serviceMapLoading = <Message>(h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("service-map-loading flex h-full w-full flex-col items-center justify-center gap-6 px-6")],
		[
			h.svg(
				[
					h.Attribute("aria-label", "Loading service map"),
					h.Class("h-auto w-full max-w-[520px]"),
					h.Attribute("fill", "none"),
					h.Attribute("role", "img"),
					h.Attribute("viewBox", "0 0 520 280"),
				],
				[
					h.defs(
						[],
						[
							h.pattern(
								[
									h.Attribute("height", "16"),
									h.Attribute("id", "sm-load-grid"),
									h.Attribute("patternUnits", "userSpaceOnUse"),
									h.Attribute("width", "16"),
								],
								[
									h.circle(
										[
											h.Attribute("cx", "1"),
											h.Attribute("cy", "1"),
											h.Attribute("fill", "var(--muted-foreground)"),
											h.Attribute("opacity", "0.06"),
											h.Attribute("r", "1"),
										],
										[],
									),
								],
							),
							h.linearGradient(
								[
									h.Attribute("gradientUnits", "userSpaceOnUse"),
									h.Attribute("id", "sm-load-grad-0-1"),
									h.Attribute("x1", "144"),
									h.Attribute("x2", "198"),
									h.Attribute("y1", "140"),
									h.Attribute("y2", "62"),
								],
								[
									h.stop(
										[
											h.Attribute("offset", "0%"),
											h.Style({ "stop-color": "var(--service-1)" }),
										],
										[],
									),
									h.stop(
										[
											h.Attribute("offset", "100%"),
											h.Style({ "stop-color": "var(--service-6)" }),
										],
										[],
									),
								],
							),
							h.linearGradient(
								[
									h.Attribute("gradientUnits", "userSpaceOnUse"),
									h.Attribute("id", "sm-load-grad-0-2"),
									h.Attribute("x1", "144"),
									h.Attribute("x2", "198"),
									h.Attribute("y1", "140"),
									h.Attribute("y2", "218"),
								],
								[
									h.stop(
										[
											h.Attribute("offset", "0%"),
											h.Style({ "stop-color": "var(--service-1)" }),
										],
										[],
									),
									h.stop(
										[
											h.Attribute("offset", "100%"),
											h.Style({ "stop-color": "var(--service-3)" }),
										],
										[],
									),
								],
							),
							h.linearGradient(
								[
									h.Attribute("gradientUnits", "userSpaceOnUse"),
									h.Attribute("id", "sm-load-grad-1-3"),
									h.Attribute("x1", "322"),
									h.Attribute("x2", "376"),
									h.Attribute("y1", "62"),
									h.Attribute("y2", "108"),
								],
								[
									h.stop(
										[
											h.Attribute("offset", "0%"),
											h.Style({ "stop-color": "var(--service-6)" }),
										],
										[],
									),
									h.stop(
										[
											h.Attribute("offset", "100%"),
											h.Style({ "stop-color": "var(--service-11)" }),
										],
										[],
									),
								],
							),
							h.linearGradient(
								[
									h.Attribute("gradientUnits", "userSpaceOnUse"),
									h.Attribute("id", "sm-load-grad-2-3"),
									h.Attribute("x1", "322"),
									h.Attribute("x2", "376"),
									h.Attribute("y1", "218"),
									h.Attribute("y2", "108"),
								],
								[
									h.stop(
										[
											h.Attribute("offset", "0%"),
											h.Style({ "stop-color": "var(--service-3)" }),
										],
										[],
									),
									h.stop(
										[
											h.Attribute("offset", "100%"),
											h.Style({ "stop-color": "var(--service-11)" }),
										],
										[],
									),
								],
							),
							h.linearGradient(
								[
									h.Attribute("gradientUnits", "userSpaceOnUse"),
									h.Attribute("id", "sm-load-grad-2-4"),
									h.Attribute("x1", "322"),
									h.Attribute("x2", "376"),
									h.Attribute("y1", "218"),
									h.Attribute("y2", "218"),
								],
								[
									h.stop(
										[
											h.Attribute("offset", "0%"),
											h.Style({ "stop-color": "var(--service-3)" }),
										],
										[],
									),
									h.stop(
										[
											h.Attribute("offset", "100%"),
											h.Style({ "stop-color": "var(--service-13)" }),
										],
										[],
									),
								],
							),
						],
					),
					h.rect(
						[
							h.Attribute("fill", "url(#sm-load-grid)"),
							h.Attribute("height", "280"),
							h.Attribute("width", "520"),
							h.Attribute("x", "0"),
							h.Attribute("y", "0"),
						],
						[],
					),
					h.g(
						[],
						[
							h.g(
								[h.Class("sm-load-edge"), h.Style({ "animation-delay": "0.15s" })],
								[
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,62 198,62"),
											h.Attribute("stroke", "url(#sm-load-grad-0-1)"),
											h.Attribute("stroke-linecap", "round"),
											h.Attribute("stroke-opacity", "0.0575"),
											h.Attribute("stroke-width", "21"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,62 198,62"),
											h.Attribute("stroke", "url(#sm-load-grad-0-1)"),
											h.Attribute("stroke-opacity", "0.2025"),
											h.Attribute("stroke-width", "7"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,62 198,62"),
											h.Attribute("stroke-opacity", "0.61"),
											h.Attribute("stroke-width", "3"),
											h.Style({
												stroke: "var(--service-map-edge-core, var(--background))",
											}),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,62 198,62"),
											h.Attribute("stroke", "url(#sm-load-grad-0-1)"),
											h.Attribute("stroke-opacity", "0.2875"),
											h.Attribute("stroke-width", "1.2000000000000002"),
										],
										[],
									),
								],
							),
							h.g(
								[
									h.Class("sm-load-particle"),
									h.Style({
										"offset-path": 'path("M 144 140 C 184 140 158 62 198 62")',
										"animation-delay": "0.8s",
									}),
								],
								[
									h.circle(
										[
											h.Attribute("fill", "var(--service-1)"),
											h.Attribute("opacity", "0.22"),
											h.Attribute("r", "5"),
										],
										[],
									),
									h.circle(
										[
											h.Attribute("fill", "#ffffff"),
											h.Attribute("opacity", "0.95"),
											h.Attribute("r", "1.6"),
										],
										[],
									),
								],
							),
						],
					),
					h.g(
						[],
						[
							h.g(
								[h.Class("sm-load-edge"), h.Style({ "animation-delay": "0.25s" })],
								[
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,218 198,218"),
											h.Attribute("stroke", "url(#sm-load-grad-0-2)"),
											h.Attribute("stroke-linecap", "round"),
											h.Attribute("stroke-opacity", "0.0575"),
											h.Attribute("stroke-width", "21"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,218 198,218"),
											h.Attribute("stroke", "url(#sm-load-grad-0-2)"),
											h.Attribute("stroke-opacity", "0.2025"),
											h.Attribute("stroke-width", "7"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,218 198,218"),
											h.Attribute("stroke-opacity", "0.61"),
											h.Attribute("stroke-width", "3"),
											h.Style({
												stroke: "var(--service-map-edge-core, var(--background))",
											}),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M144,140 C184,140 158,218 198,218"),
											h.Attribute("stroke", "url(#sm-load-grad-0-2)"),
											h.Attribute("stroke-opacity", "0.2875"),
											h.Attribute("stroke-width", "1.2000000000000002"),
										],
										[],
									),
								],
							),
							h.g(
								[
									h.Class("sm-load-particle"),
									h.Style({
										"offset-path": 'path("M 144 140 C 184 140 158 218 198 218")',
										"animation-delay": "1.02s",
									}),
								],
								[
									h.circle(
										[
											h.Attribute("fill", "var(--service-1)"),
											h.Attribute("opacity", "0.22"),
											h.Attribute("r", "5"),
										],
										[],
									),
									h.circle(
										[
											h.Attribute("fill", "#ffffff"),
											h.Attribute("opacity", "0.95"),
											h.Attribute("r", "1.6"),
										],
										[],
									),
								],
							),
						],
					),
					h.g(
						[],
						[
							h.g(
								[h.Class("sm-load-edge"), h.Style({ "animation-delay": "0.35s" })],
								[
									h.path(
										[
											h.Attribute("d", "M322,62 C362,62 336,108 376,108"),
											h.Attribute("stroke", "url(#sm-load-grad-1-3)"),
											h.Attribute("stroke-linecap", "round"),
											h.Attribute("stroke-opacity", "0.0575"),
											h.Attribute("stroke-width", "21"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,62 C362,62 336,108 376,108"),
											h.Attribute("stroke", "url(#sm-load-grad-1-3)"),
											h.Attribute("stroke-opacity", "0.2025"),
											h.Attribute("stroke-width", "7"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,62 C362,62 336,108 376,108"),
											h.Attribute("stroke-opacity", "0.61"),
											h.Attribute("stroke-width", "3"),
											h.Style({
												stroke: "var(--service-map-edge-core, var(--background))",
											}),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,62 C362,62 336,108 376,108"),
											h.Attribute("stroke", "url(#sm-load-grad-1-3)"),
											h.Attribute("stroke-opacity", "0.2875"),
											h.Attribute("stroke-width", "1.2000000000000002"),
										],
										[],
									),
								],
							),
							h.g(
								[
									h.Class("sm-load-particle"),
									h.Style({
										"offset-path": 'path("M 322 62 C 362 62 336 108 376 108")',
										"animation-delay": "1.24s",
									}),
								],
								[
									h.circle(
										[
											h.Attribute("fill", "var(--service-6)"),
											h.Attribute("opacity", "0.22"),
											h.Attribute("r", "5"),
										],
										[],
									),
									h.circle(
										[
											h.Attribute("fill", "#ffffff"),
											h.Attribute("opacity", "0.95"),
											h.Attribute("r", "1.6"),
										],
										[],
									),
								],
							),
						],
					),
					h.g(
						[],
						[
							h.g(
								[h.Class("sm-load-edge"), h.Style({ "animation-delay": "0.45s" })],
								[
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,108 376,108"),
											h.Attribute("stroke", "url(#sm-load-grad-2-3)"),
											h.Attribute("stroke-linecap", "round"),
											h.Attribute("stroke-opacity", "0.0575"),
											h.Attribute("stroke-width", "21"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,108 376,108"),
											h.Attribute("stroke", "url(#sm-load-grad-2-3)"),
											h.Attribute("stroke-opacity", "0.2025"),
											h.Attribute("stroke-width", "7"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,108 376,108"),
											h.Attribute("stroke-opacity", "0.61"),
											h.Attribute("stroke-width", "3"),
											h.Style({
												stroke: "var(--service-map-edge-core, var(--background))",
											}),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,108 376,108"),
											h.Attribute("stroke", "url(#sm-load-grad-2-3)"),
											h.Attribute("stroke-opacity", "0.2875"),
											h.Attribute("stroke-width", "1.2000000000000002"),
										],
										[],
									),
								],
							),
							h.g(
								[
									h.Class("sm-load-particle"),
									h.Style({
										"offset-path": 'path("M 322 218 C 362 218 336 108 376 108")',
										"animation-delay": "1.46s",
									}),
								],
								[
									h.circle(
										[
											h.Attribute("fill", "var(--service-3)"),
											h.Attribute("opacity", "0.22"),
											h.Attribute("r", "5"),
										],
										[],
									),
									h.circle(
										[
											h.Attribute("fill", "#ffffff"),
											h.Attribute("opacity", "0.95"),
											h.Attribute("r", "1.6"),
										],
										[],
									),
								],
							),
						],
					),
					h.g(
						[],
						[
							h.g(
								[h.Class("sm-load-edge"), h.Style({ "animation-delay": "0.55s" })],
								[
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,218 376,218"),
											h.Attribute("stroke", "url(#sm-load-grad-2-4)"),
											h.Attribute("stroke-linecap", "round"),
											h.Attribute("stroke-opacity", "0.0575"),
											h.Attribute("stroke-width", "21"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,218 376,218"),
											h.Attribute("stroke", "url(#sm-load-grad-2-4)"),
											h.Attribute("stroke-opacity", "0.2025"),
											h.Attribute("stroke-width", "7"),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,218 376,218"),
											h.Attribute("stroke-opacity", "0.61"),
											h.Attribute("stroke-width", "3"),
											h.Style({
												stroke: "var(--service-map-edge-core, var(--background))",
											}),
										],
										[],
									),
									h.path(
										[
											h.Attribute("d", "M322,218 C362,218 336,218 376,218"),
											h.Attribute("stroke", "url(#sm-load-grad-2-4)"),
											h.Attribute("stroke-opacity", "0.2875"),
											h.Attribute("stroke-width", "1.2000000000000002"),
										],
										[],
									),
								],
							),
							h.g(
								[
									h.Class("sm-load-particle"),
									h.Style({
										"offset-path": 'path("M 322 218 C 362 218 336 218 376 218")',
										"animation-delay": "1.68s",
									}),
								],
								[
									h.circle(
										[
											h.Attribute("fill", "var(--service-3)"),
											h.Attribute("opacity", "0.22"),
											h.Attribute("r", "5"),
										],
										[],
									),
									h.circle(
										[
											h.Attribute("fill", "#ffffff"),
											h.Attribute("opacity", "0.95"),
											h.Attribute("r", "1.6"),
										],
										[],
									),
								],
							),
						],
					),
					h.g(
						[h.Class("sm-load-node"), h.Style({ "animation-delay": "0s" })],
						[
							h.path(
								[
									h.Attribute(
										"d",
										"M20,118 H137 Q144,118 144,125 V155 Q144,162 137,162 H20 Z",
									),
									h.Attribute("fill", "var(--card)"),
									h.Attribute("stroke", "var(--border)"),
									h.Attribute("stroke-width", "1"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--service-1)"),
									h.Attribute("height", "43"),
									h.Attribute("width", "3"),
									h.Attribute("x", "20"),
									h.Attribute("y", "118.5"),
								],
								[],
							),
							h.circle(
								[
									h.Attribute("cx", "33"),
									h.Attribute("cy", "131"),
									h.Attribute("fill", "var(--severity-info)"),
									h.Attribute("r", "2.4"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "4.5"),
									h.Attribute("opacity", "0.32"),
									h.Attribute("rx", "2.25"),
									h.Attribute("width", "64.8"),
									h.Attribute("x", "42"),
									h.Attribute("y", "128"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "33"),
									h.Attribute("y", "146"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "63"),
									h.Attribute("y", "146"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "93"),
									h.Attribute("y", "146"),
								],
								[],
							),
						],
					),
					h.g(
						[h.Class("sm-load-node"), h.Style({ "animation-delay": "0.08s" })],
						[
							h.path(
								[
									h.Attribute("d", "M198,40 H315 Q322,40 322,47 V77 Q322,84 315,84 H198 Z"),
									h.Attribute("fill", "var(--card)"),
									h.Attribute("stroke", "var(--border)"),
									h.Attribute("stroke-width", "1"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--service-6)"),
									h.Attribute("height", "43"),
									h.Attribute("width", "3"),
									h.Attribute("x", "198"),
									h.Attribute("y", "40.5"),
								],
								[],
							),
							h.circle(
								[
									h.Attribute("cx", "211"),
									h.Attribute("cy", "53"),
									h.Attribute("fill", "var(--severity-info)"),
									h.Attribute("r", "2.4"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "4.5"),
									h.Attribute("opacity", "0.32"),
									h.Attribute("rx", "2.25"),
									h.Attribute("width", "54"),
									h.Attribute("x", "220"),
									h.Attribute("y", "50"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "211"),
									h.Attribute("y", "68"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "241"),
									h.Attribute("y", "68"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "271"),
									h.Attribute("y", "68"),
								],
								[],
							),
						],
					),
					h.g(
						[h.Class("sm-load-node"), h.Style({ "animation-delay": "0.16s" })],
						[
							h.path(
								[
									h.Attribute(
										"d",
										"M198,196 H315 Q322,196 322,203 V233 Q322,240 315,240 H198 Z",
									),
									h.Attribute("fill", "var(--card)"),
									h.Attribute("stroke", "var(--border)"),
									h.Attribute("stroke-width", "1"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--service-3)"),
									h.Attribute("height", "43"),
									h.Attribute("width", "3"),
									h.Attribute("x", "198"),
									h.Attribute("y", "196.5"),
								],
								[],
							),
							h.circle(
								[
									h.Attribute("cx", "211"),
									h.Attribute("cy", "209"),
									h.Attribute("fill", "var(--severity-info)"),
									h.Attribute("r", "2.4"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "4.5"),
									h.Attribute("opacity", "0.32"),
									h.Attribute("rx", "2.25"),
									h.Attribute("width", "72"),
									h.Attribute("x", "220"),
									h.Attribute("y", "206"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "211"),
									h.Attribute("y", "224"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "241"),
									h.Attribute("y", "224"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "271"),
									h.Attribute("y", "224"),
								],
								[],
							),
						],
					),
					h.g(
						[h.Class("sm-load-node"), h.Style({ "animation-delay": "0.24s" })],
						[
							h.path(
								[
									h.Attribute(
										"d",
										"M376,86 H493 Q500,86 500,93 V123 Q500,130 493,130 H376 Z",
									),
									h.Attribute("fill", "var(--card)"),
									h.Attribute("stroke", "var(--border)"),
									h.Attribute("stroke-width", "1"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--service-11)"),
									h.Attribute("height", "43"),
									h.Attribute("width", "3"),
									h.Attribute("x", "376"),
									h.Attribute("y", "86.5"),
								],
								[],
							),
							h.circle(
								[
									h.Attribute("cx", "389"),
									h.Attribute("cy", "99"),
									h.Attribute("fill", "var(--severity-info)"),
									h.Attribute("r", "2.4"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "4.5"),
									h.Attribute("opacity", "0.32"),
									h.Attribute("rx", "2.25"),
									h.Attribute("width", "48.6"),
									h.Attribute("x", "398"),
									h.Attribute("y", "96"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "389"),
									h.Attribute("y", "114"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "419"),
									h.Attribute("y", "114"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "449"),
									h.Attribute("y", "114"),
								],
								[],
							),
						],
					),
					h.g(
						[h.Class("sm-load-node"), h.Style({ "animation-delay": "0.32s" })],
						[
							h.path(
								[
									h.Attribute(
										"d",
										"M376,196 H493 Q500,196 500,203 V233 Q500,240 493,240 H376 Z",
									),
									h.Attribute("fill", "var(--card)"),
									h.Attribute("stroke", "var(--border)"),
									h.Attribute("stroke-width", "1"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--service-13)"),
									h.Attribute("height", "43"),
									h.Attribute("width", "3"),
									h.Attribute("x", "376"),
									h.Attribute("y", "196.5"),
								],
								[],
							),
							h.circle(
								[
									h.Attribute("cx", "389"),
									h.Attribute("cy", "209"),
									h.Attribute("fill", "var(--severity-info)"),
									h.Attribute("r", "2.4"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "4.5"),
									h.Attribute("opacity", "0.32"),
									h.Attribute("rx", "2.25"),
									h.Attribute("width", "59.400000000000006"),
									h.Attribute("x", "398"),
									h.Attribute("y", "206"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "389"),
									h.Attribute("y", "224"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "419"),
									h.Attribute("y", "224"),
								],
								[],
							),
							h.rect(
								[
									h.Attribute("fill", "var(--muted-foreground)"),
									h.Attribute("height", "3"),
									h.Attribute("opacity", "0.18"),
									h.Attribute("rx", "1.5"),
									h.Attribute("width", "20"),
									h.Attribute("x", "449"),
									h.Attribute("y", "224"),
								],
								[],
							),
						],
					),
				],
			),
			h.div(
				[
					h.Class(
						"font-medium uppercase font-mono text-3xs tracking-widest text-muted-foreground/70 flex items-center gap-2",
					),
					h.Attribute("data-slot", "eyebrow"),
				],
				[
					h.span([], ["Mapping service connections"]),
					h.span(
						[h.Attribute("aria-hidden", "true"), h.Class("inline-flex")],
						[
							h.span([h.Class("pulse-dot")], ["."]),
							h.span([h.Class("pulse-dot")], ["."]),
							h.span([h.Class("pulse-dot")], ["."]),
						],
					),
				],
			),
		],
	)
