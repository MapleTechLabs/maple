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
.wrap{max-width:760px;margin:0 auto;padding:40px 20px 56px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:32px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px;font-weight:600;font-size:18px;color:var(--fg);text-decoration:none}
.brand img{max-height:36px;max-width:200px;display:block}
.site{font-size:14px;color:var(--secondary)}
.s-operational{--c:var(--ok)}.s-degraded{--c:var(--degraded)}.s-partial_outage{--c:var(--partial)}.s-major_outage{--c:var(--major)}.s-maintenance{--c:var(--maint)}
.dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--c)}
.notice{padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:16px;font-size:14px;background:color-mix(in srgb,var(--degraded) 10%,var(--bg))}
.notice.ok{background:color-mix(in srgb,var(--ok) 10%,var(--bg))}
section{margin-top:32px}
h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 12px}
.card{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);padding:16px 20px;margin-bottom:12px}
.meta{font-size:13px;color:var(--muted)}
.empty{color:var(--muted);font-size:14px;margin:0}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
footer a{color:var(--secondary)}
@media (max-width:560px){.wrap{padding:24px 16px 40px}}
`

export const pageStyles = `
.banner{display:flex;align-items:center;gap:12px;padding:16px 20px;border:1px solid var(--line);border-radius:var(--radius);background:color-mix(in srgb,var(--c) 8%,var(--bg))}
.banner h1{font-size:17px;margin:0;font-weight:600}
.card h3{font-size:15px;margin:0 0 2px;display:flex;gap:8px;align-items:center}
.updates{list-style:none;margin:12px 0 0;padding:0}
.updates li{padding:10px 0 0;margin-top:10px;border-top:1px solid var(--line)}
.body{white-space:pre-wrap;overflow-wrap:anywhere;margin:2px 0}
.components{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--card)}
.group+.group{border-top:1px solid var(--line)}
.group-head{display:flex;justify-content:space-between;gap:12px;padding:10px 20px;font-weight:600;background:color-mix(in srgb,var(--fg) 4%,var(--card));border-bottom:1px solid var(--line)}
.component{padding:14px 20px}
.component+.component{border-top:1px solid var(--line)}
.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.name{font-weight:500;overflow-wrap:anywhere}
.status{font-size:14px;color:var(--c);white-space:nowrap}
.desc{font-size:13px;color:var(--muted);margin:2px 0 0}
.bars{display:flex;gap:2px;height:28px;margin:10px 0 6px;padding:0;list-style:none}
.bars li{flex:1;min-width:0;border-radius:calc(var(--radius)/4);background:var(--none)}
.bars .d-ok{background:var(--ok)}.bars .d-degraded{background:var(--degraded)}.bars .d-down{background:var(--major)}
.bar-foot{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
@media (max-width:560px){.bars{gap:1px;height:24px}}
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
