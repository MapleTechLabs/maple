import type { ResolvedStatusPageTheme } from "@maple/domain/status-page"
import { tokenVariables } from "./theme"

/** The colour scheme: both sets behind the media query in auto, one forced set otherwise. */
const schemeStyles = (theme: ResolvedStatusPageTheme): string =>
	theme.appearance === "auto"
		? `:root{color-scheme:light dark;${tokenVariables(theme.light)}}
@media (prefers-color-scheme:dark){:root{${tokenVariables(theme.dark)}}}`
		: `:root{color-scheme:${theme.appearance};${tokenVariables(theme.appearance === "light" ? theme.light : theme.dark)}}`

/** Shared page chrome: flat, system fonts, no animation; colours, radius and font from the theme. */
export const baseStyles = (theme: ResolvedStatusPageTheme): string => `
${schemeStyles(theme)}
:root{--radius:${Math.max(0, Math.round(theme.radiusPx))}px;--font:${theme.fontStack}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--link)}
[hidden]{display:none!important}
.wrap{max-width:712px;margin:0 auto;padding:40px 20px 56px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:32px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:18px;color:var(--fg);text-decoration:none;letter-spacing:-.01em}
.mono-mark{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:var(--radius);background:var(--primary);color:var(--primary-fg);font-size:15px;font-weight:700;letter-spacing:0}
.brand img{max-height:36px;max-width:200px;display:block}
.site{font-size:14px;color:var(--secondary)}
.s-operational{--c:var(--ok);--tint:var(--ok-tint)}.s-degraded{--c:var(--degraded);--tint:var(--degraded-tint)}.s-partial_outage{--c:var(--partial);--tint:var(--partial-tint)}.s-major_outage{--c:var(--major);--tint:var(--major-tint)}.s-maintenance{--c:var(--maint);--tint:var(--maint-tint)}
.dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--c)}
.notice{padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:16px;font-size:14px;background:color-mix(in srgb,var(--degraded) 10%,var(--bg))}
.notice.ok{background:color-mix(in srgb,var(--ok) 10%,var(--bg))}
section{margin-top:32px}
h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 12px}
.card{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);padding:16px 20px;margin-bottom:12px;box-shadow:var(--shadow,none)}
.meta{font-size:13px;color:var(--muted)}
.empty{color:var(--muted);font-size:14px;margin:0}
footer{margin-top:40px;display:grid;gap:6px;justify-items:center;text-align:center;font-size:13px;color:var(--muted)}
footer p{margin:0}
footer a{color:var(--secondary)}
.powered a{display:inline-flex;align-items:center;gap:4px;vertical-align:bottom}
.maple-mark{flex:none;display:block}
@media (max-width:560px){.wrap{padding:24px 16px 40px}}
`

export const pageStyles = `
.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ico{flex:none;display:block}
.ico circle{fill:var(--c)}
.ico path{fill:none;stroke:var(--card);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.hero{margin-top:0;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);overflow:hidden;box-shadow:var(--shadow,none)}
.hero-head{display:flex;align-items:center;gap:10px;padding:16px 16px 4px}
.hero:not(.s-operational){border-color:var(--c);background:var(--tint)}
.hero:not(.s-operational) .hero-body{color:var(--fg)}
.hero:not(.s-operational) .ico path{stroke:var(--tint)}
.hero h1{font-size:17px;line-height:1.35;margin:0;font-weight:500}
.hero-body{padding:0 16px 16px 44px;font-size:14px;color:var(--muted)}
.hero-body p,.hero-body ul{margin:0}
.hero-body ul{padding-left:18px;display:grid;gap:4px}
.hero-body a{color:var(--fg);text-underline-offset:2px}
section.list{margin-top:32px}
.list h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 12px}
.incident h3{font-size:15px;margin:0 0 2px;display:flex;gap:8px;align-items:center;overflow-wrap:anywhere}
.updates{list-style:none;margin:12px 0 0;padding:0}
.updates li{padding:10px 0 0;margin-top:10px;border-top:1px solid var(--line)}
.body{white-space:pre-wrap;overflow-wrap:anywhere;margin:2px 0}
.panel{margin-top:24px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);overflow:hidden;box-shadow:var(--shadow,none)}
.panel-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--line)}
.panel-head h2{font-size:16px;font-weight:500;margin:0;color:var(--fg);text-transform:none;letter-spacing:0}
.pager{display:flex;align-items:center;gap:4px;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.pager button{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:calc(var(--radius)/2);background:none;color:var(--muted);cursor:pointer}
.pager button:hover:not(:disabled){color:var(--link);background:color-mix(in srgb,var(--primary) 12%,transparent)}
.pager button:disabled{opacity:.35;cursor:default}
.pager svg path,.cal-panel svg path{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
button:focus-visible,a:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.group+.group{border-top:1px solid var(--line)}
.group-head{padding:12px 16px 0;font-weight:500;font-size:13px;color:var(--muted)}
.group-head .ico{width:14px;height:14px}
.component{padding:14px 16px}
.component+.component{border-top:1px solid var(--line)}
.group-head+.component{padding-top:10px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center}
.name{display:flex;align-items:center;gap:8px;font-weight:500;min-width:0;overflow-wrap:anywhere}
.st{display:flex}
.uptime{font-size:13px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.desc{font-size:13px;color:var(--muted);margin:2px 0 0 24px}
.bars{display:flex;gap:2px;height:24px;margin:10px 0 0;padding:0;list-style:none}
.bars li{flex:1;min-width:0;border-radius:calc(var(--radius)/4);background:var(--none)}
.bars .d-ok{background:var(--ok)}.bars .d-degraded{background:var(--degraded)}.bars .d-down{background:var(--major)}
.cal{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px}
.cal th{font-weight:400;color:var(--muted);padding:10px 0;border-bottom:1px solid var(--line)}
.cal td{height:40px;text-align:center;border-top:1px solid var(--line);border-left:1px solid var(--line);padding:0}
.cal tbody tr:first-child td{border-top:0}
.cal td:first-child{border-left:0}
.day{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;color:var(--muted);font:inherit;font-variant-numeric:tabular-nums}
button.day{border:1.5px solid var(--c);background:none;color:var(--fg);cursor:pointer;padding:0}
button.day[aria-expanded=true]{background:var(--tint)}
.day.today{font-weight:700;background:var(--primary);color:var(--primary-fg)}
.day.today[aria-expanded=true]{background:var(--primary)}
.t-degraded{--c:var(--degraded);--tint:var(--degraded-tint)}.t-partial_outage{--c:var(--partial);--tint:var(--partial-tint)}.t-major_outage{--c:var(--major);--tint:var(--major-tint)}.t-maintenance{--c:var(--maint);--tint:var(--maint-tint)}.t-notice{--c:var(--muted);--tint:var(--card)}
.cal-panel{border-top:1px solid var(--line);padding:14px 16px}
.cal-panel h3{font-size:14px;font-weight:500;margin:0 0 8px}
.cal-panel ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.cal-panel li{display:grid;gap:2px;padding-left:12px;border-left:2px solid var(--c)}
.cal-panel .title{font-weight:500;color:var(--fg);overflow-wrap:anywhere}
.cal-panel .meta{font-size:13px}
.cal-panel .s-notice{--c:var(--muted)}
@media (max-width:560px){.bars{gap:1px;height:22px}.cal td{height:36px}.panel-head{padding:12px}.component{padding:12px}}
`

export const manageStyles = `
form{display:grid;gap:16px}
label{display:grid;gap:6px;font-size:14px;font-weight:500}
input[type=text],input[type=password],select,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:calc(var(--radius)*.75);padding:8px 10px;width:100%}
textarea{min-height:140px;resize:vertical}
fieldset{border:1px solid var(--line);border-radius:var(--radius);padding:12px 16px;margin:0}
legend{font-size:14px;font-weight:500;padding:0 4px}
.check{display:flex;gap:8px;align-items:center;font-weight:400}
button{font:inherit;font-weight:500;padding:10px 16px;border-radius:calc(var(--radius)*.75);border:1px solid var(--fg);background:var(--fg);color:var(--bg);cursor:pointer;justify-self:start}
`

/** Each preset's card shadow, from its shadcn theme. */
export const presetStyles = `
[data-preset=default]{--shadow:0px 1px 2px 0px rgba(0,0,0,0.18)}
[data-preset=maple]{--shadow:none}
[data-preset=mono]{--shadow:none}
[data-preset=midnight]{--shadow:0px 4px 10px 0px rgba(45,45,83,0.12)}
[data-preset=paper]{--shadow:2px 3px 5px 0px rgba(58,51,44,0.12)}
`
