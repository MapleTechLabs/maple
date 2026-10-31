// The page's one inline script, written as plain ES5 so it runs anywhere without a build step.
// `PAGE_SCRIPT_LOGIC` mirrors `history.ts` and `format.ts`; `script.test.ts` runs it against them.

/** Pure helpers: dates, labels, window bounds and month grids. Declares functions only. */
export const PAGE_SCRIPT_LOGIC = `var M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function pad(n){return(n<10?"0":"")+n}
function dms(d){var p=d.split("-");return Date.UTC(+p[0],p[1]-1,+p[2])}
function shift(d,o){return new Date(dms(d)+o*864e5).toISOString().slice(0,10)}
function mlabel(d){var p=d.split("-");return M[p[1]-1]+" "+p[0]}
function fday(d){var p=d.split("-");return M[p[1]-1]+" "+(+p[2])+", "+p[0]}
function bounds(len,pg){var to=len-pg*90;return{from:to-90,to:to}}
function state(c){return!c||c[0]===0?"none":c[2]>0?"down":c[1]>0?"degraded":"ok"}
function tip(d,c){var s=state(c);return fday(d)+": "+(s==="none"?"No data":s==="ok"?"No downtime, "+c[0]+" checks":s==="degraded"?c[1]+" of "+c[0]+" checks failed":"Down during "+c[2]+" of "+c[0]+" checks")}
function pct(p){return(Math.floor(+(p*100).toFixed(6))/100).toFixed(2).replace(/\\.?0+$/,"")+"%"}
function cells(y,m){var lead=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7,n=new Date(Date.UTC(y,m,0)).getUTCDate(),t=Math.ceil((lead+n)/7)*7,r=[];for(var i=0;i<t;i++){var d=i-lead+1;r.push(d>=1&&d<=n?d:0)}return r}
function mback(d,b){var p=d.split("-"),i=p[0]*12+(p[1]-1)-b;return Math.floor(i/12)+"-"+pad(i%12+1)}
`

/** DOM glue: relative times and the delayed banner, then paging and the calendar's day panel. */
const PAGE_SCRIPT_DOM = `var b=document.body,u=+b.getAttribute("data-updated-at"),s=+b.getAttribute("data-stale-after");
function age(ms){var m=Math.floor(Math.max(0,ms)/6e4);if(m<1)return"just now";if(m<60)return m+" min ago";var h=Math.floor(m/60);return h<48?h+" h ago":Math.floor(h/24)+" d ago"}
function tick(){var g=Date.now()-u,e=document.getElementById("updated"),d=document.getElementById("delayed");if(e)e.textContent="Updated "+age(g);if(d&&g>s)d.hidden=false}
tick();setInterval(tick,3e4);
var src=document.getElementById("sp-data");if(!src)return;var D=JSON.parse(src.textContent),W=0,C=0;
function mk(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function nav(n,pos,max){document.querySelectorAll('[data-nav="'+n+'"]').forEach(function(a){a.hidden=false;a.disabled=a.getAttribute("data-dir")==="older"?pos>=max-1:pos<=0})}
function drawWindow(){var r=bounds(D.len,W),first=shift(D.end,r.from-D.len+1),last=shift(D.end,r.to-D.len),l=document.getElementById("window-label");if(l)l.textContent=mlabel(first)+" - "+mlabel(last);
document.querySelectorAll("[data-component]").forEach(function(row){var bars=D.bars[row.getAttribute("data-component")],ol=row.querySelector(".bars");if(!bars||!ol)return;ol.textContent="";var ch=0,dn=0;for(var i=r.from;i<r.to;i++){var c=i>=0?bars[i]:0,d=shift(D.end,i-D.len+1),st=state(c),li=mk("li","d-"+st);li.setAttribute("data-day",d);li.setAttribute("data-state",st);li.title=tip(d,c);ol.appendChild(li);if(c){ch+=c[0];dn+=c[2]}}
ol.setAttribute("aria-label","Uptime, "+fday(first)+" to "+fday(last));var up=row.querySelector(".uptime");if(up)up.textContent=ch?pct((ch-dn)/ch*100)+" uptime":"No data"});nav("window",W,D.windows)}
function closePanel(){var p=document.getElementById("cal-panel");if(p){p.hidden=true;p.textContent=""}document.querySelectorAll('#cal-body [aria-expanded="true"]').forEach(function(a){a.setAttribute("aria-expanded","false")})}
function dayNode(day,n){var k=D.days[day],e;if(k){e=mk("button","day t-"+k[0],String(n));e.type="button";e.setAttribute("data-day",day);e.setAttribute("aria-label",k[2]);e.title=k[2];e.setAttribute("aria-expanded","false");e.setAttribute("aria-controls","cal-panel")}else e=mk("span","day",String(n));if(day===D.today){e.className+=" today";e.setAttribute("aria-current","date")}return e}
function drawMonth(){var ym=mback(D.today,C),y=+ym.slice(0,4),m=+ym.slice(5,7),l=document.getElementById("month-label"),body=document.getElementById("cal-body");if(l)l.textContent=M[m-1]+" "+y;if(!body)return;body.textContent="";var cs=cells(y,m),tr=null;for(var i=0;i<cs.length;i++){if(i%7===0){tr=mk("tr");body.appendChild(tr)}var td=mk("td");tr.appendChild(td);if(cs[i])td.appendChild(dayNode(ym+"-"+pad(cs[i]),cs[i]))}closePanel();nav("month",C,D.months)}
function openPanel(a){var day=a.getAttribute("data-day"),k=D.days[day],p=document.getElementById("cal-panel"),was=a.getAttribute("aria-expanded")==="true";closePanel();if(was||!k||!p)return;a.setAttribute("aria-expanded","true");p.appendChild(mk("h3",null,fday(day)));var ul=mk("ul");k[1].forEach(function(i){var x=D.entries[i],li=mk("li","s-"+x.tone),t;if(x.href){t=mk("a","title",x.title);t.href=x.href}else t=mk("span","title",x.title);li.appendChild(t);li.appendChild(mk("span","meta",x.meta));ul.appendChild(li)});p.appendChild(ul);p.hidden=false}
document.addEventListener("click",function(ev){var a=ev.target&&ev.target.closest?ev.target.closest("button"):null;if(!a)return;var n=a.getAttribute("data-nav"),older=a.getAttribute("data-dir")==="older";if(n==="window"){W=Math.max(0,Math.min(D.windows-1,W+(older?1:-1)));drawWindow()}else if(n==="month"){C=Math.max(0,Math.min(D.months-1,C+(older?1:-1)));drawMonth()}else if(a.hasAttribute("data-day"))openPanel(a)});
nav("window",W,D.windows);nav("month",C,D.months);`

/** Ages "Updated ..." and the delayed banner, and pages the bars and calendar from the embedded data. */
export const PAGE_SCRIPT = `(function(){${PAGE_SCRIPT_LOGIC}${PAGE_SCRIPT_DOM}})();`
