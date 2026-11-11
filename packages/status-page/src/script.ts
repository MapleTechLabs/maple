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

/** DOM glue: relative times and the delayed banner, the subscribe dialog and its copy buttons, paging, the calendar's day panel and bar tooltips. */
const PAGE_SCRIPT_DOM = `var b=document.body,u=+b.getAttribute("data-updated-at"),s=+b.getAttribute("data-stale-after");
function age(ms){var m=Math.floor(Math.max(0,ms)/6e4);if(m<1)return"just now";if(m<60)return m+" min ago";var h=Math.floor(m/60);return h<48?h+" h ago":Math.floor(h/24)+" d ago"}
function tick(){var g=Date.now()-u,e=document.getElementById("updated"),d=document.getElementById("delayed");if(e)e.textContent="Updated "+age(g);if(d&&g>s)d.hidden=false}
tick();setInterval(tick,3e4);
b.classList.add("js");
var dlg=document.getElementById("subscribe"),box=dlg.querySelector(".modal-box"),title=document.getElementById("sub-title"),form=dlg.querySelector(".sub-form"),addr=form.elements.email,boxes=form.querySelectorAll('[name="componentIds"]'),opener=null;
form.noValidate=true;
document.querySelectorAll("[data-copy],.picks-head").forEach(function(c){c.hidden=false});
function isOpen(){return dlg.classList.contains("open")}
function openSub(){opener=document.activeElement;dlg.classList.add("open");box.focus({preventScroll:true})}
function closeSub(){if(!dlg.querySelector(".sub-done").hidden){form.reset();count();dlg.querySelector(".sub-done").hidden=true;dlg.querySelector(".sub-tabs").hidden=false;title.textContent="Subscribe to updates"}dlg.classList.remove("open");if(location.hash==="#subscribe")history.replaceState(null,"",location.pathname+location.search);if(opener&&opener.focus)opener.focus()}
function err(k,t){var e=form.querySelector('[data-sub-error="'+k+'"]');if(!e)return;if(typeof t==="string"&&t)e.textContent=t;e.hidden=!t}
function count(){var n=0;boxes.forEach(function(x){if(x.checked)n++});var c=form.querySelector("[data-sub-count]");if(c)c.textContent=n+" of "+boxes.length+" selected";if(n)err("components",false)}
function fail(t){var a=form.querySelector(".sub-alert");a.textContent=t||"Subscriptions are unavailable right now. Try again in a few minutes.";a.hidden=false}
function done(v){dlg.querySelector("[data-sub-address]").textContent=v;dlg.querySelector(".sub-tabs").hidden=true;dlg.querySelector(".sub-done").hidden=false;title.textContent="Confirm your subscription";box.focus({preventScroll:true})}
function send(v){var btn=form.querySelector("[type=submit]");btn.disabled=true;form.querySelector(".sub-alert").hidden=true;fetch(form.action,{method:"POST",body:new URLSearchParams(new FormData(form))}).then(function(r){return r.text().then(function(t){if(r.ok)return done(v);var p=new DOMParser().parseFromString(t,"text/html").querySelector(".result p");fail(p?p.textContent:"")})},function(){fail("")}).then(function(){btn.disabled=false})}
form.addEventListener("input",function(ev){if(ev.target===addr)err("email",false)});
form.addEventListener("change",count);
form.addEventListener("submit",function(ev){var v=addr.value.trim(),ok=true;ev.preventDefault();
if(!v){err("email","Please enter your email address");ok=false}else if(addr.validity.typeMismatch){err("email","Please enter a valid email address");ok=false}
if(form.querySelector('[value="some"]:checked')&&!form.querySelectorAll('[name="componentIds"]:checked').length){err("components",true);ok=false}
if(ok)send(v)});
function pick(c){c.focus();c.select()}
function copy(a){var c=a.parentNode.querySelector("input"),k=function(){pick(c)};if(navigator.clipboard)navigator.clipboard.writeText(c.value).then(function(){a.setAttribute("data-copied","");setTimeout(function(){a.removeAttribute("data-copied")},1500)},k);else k()}
document.addEventListener("click",function(ev){var t=ev.target;if(!t||!t.closest)return;var a=t.closest("[data-copy]"),p=t.closest("[data-sub-pick]");if(a)copy(a);if(p){var all=p.getAttribute("data-sub-pick")==="all";boxes.forEach(function(x){x.checked=all});count()}
if(t.closest('a[href="#subscribe"]')){ev.preventDefault();openSub()}else if(t.closest("[data-sub-close]")){ev.preventDefault();closeSub()}});
document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&isOpen())closeSub()});
document.addEventListener("focusin",function(ev){if(isOpen()&&!dlg.contains(ev.target))box.focus({preventScroll:true})});
if(location.hash==="#subscribe")openSub();
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
nav("window",W,D.windows);nav("month",C,D.months);
var T=mk("div","tip");T.hidden=true;T.setAttribute("role","tooltip");b.appendChild(T);
function hideTip(){T.hidden=true}
function showTip(li){var t=li.getAttribute("aria-label");if(!t){t=li.title;li.setAttribute("aria-label",t);li.removeAttribute("title")}T.textContent=t;T.hidden=false;var r=li.getBoundingClientRect(),w=T.offsetWidth,top=r.top-T.offsetHeight-6;T.style.left=Math.max(8,Math.min(window.innerWidth-w-8,r.left+r.width/2-w/2))+"px";T.style.top=(top<8?r.bottom+6:top)+"px"}
document.addEventListener("pointerover",function(ev){var t=ev.target,p=t&&t.parentNode;if(p&&p.className==="bars")showTip(t);else hideTip()});
window.addEventListener("scroll",hideTip,true);`

/** Ages "Updated ..." and the delayed banner, and pages the bars and calendar from the embedded data. */
export const PAGE_SCRIPT = `(function(){${PAGE_SCRIPT_LOGIC}${PAGE_SCRIPT_DOM}})();`
