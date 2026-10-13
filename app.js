/* =====================================================================
  SWAMY FOODS - app.js (the one script every page uses)
    SB          small Supabase client: login, session, function calls
    SwamyWeight parcel weight, read from sizes like "200 gm" or "1 kg"
    SwamyUtil   DOM helper, icons, forms, order summary
    (then)      catalog, cart, header, cookie notice, and each page's behaviour
  No libraries, no build step. Keep it next to config.js and your pages.
  ===================================================================== */
(function (global) {
 "use strict";

 /* ------------------------------ SB ------------------------------ */
 const cfg = global.SWAMY_CONFIG || {};
 const BASE = String(cfg.SUPABASE_URL || "").replace(/\/+$/, "");
 const ANON = String(cfg.SUPABASE_ANON_KEY || "");
 const configured = /^https?:\/\//i.test(BASE) && ANON.length > 20 && !/YOUR[-_]/i.test(BASE + ANON);
 const SESSION_KEY = "swamyfoods.session.v1";

 class SBError extends Error {
   constructor(message, status, code) {
     super(message);
     this.name = "SBError";
     this.status = status || 0;
     this.code = code || "";
   }
 }

 let session = readSession();
 const listeners = new Set();
 let refreshing = null;

 function readSession() {
   try {
     const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
     return s && s.access_token && s.refresh_token && s.user ? s : null;
   } catch (e) { return null; }
 }
 function writeSession(s) {
   session = s;
   try {
     if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
     else localStorage.removeItem(SESSION_KEY);
   } catch (e) { /* private mode: session lives in memory only */ }
   emit();
 }
 function emit() {
   listeners.forEach(fn => { try { fn(session); } catch (e) { console.error(e); } });
 }
 function toSession(d) {
   const u = d.user || {};
   const meta = u.user_metadata || {};
   return {
     access_token: d.access_token,
     refresh_token: d.refresh_token,
     expires_at: d.expires_at || (Math.floor(Date.now() / 1000) + (d.expires_in || 3600)),
     user: { id: u.id, email: u.email || "", name: meta.full_name || "" }
   };
 }
 // keep several open tabs in step
 global.addEventListener("storage", e => {
   if (e.key === SESSION_KEY) { session = readSession(); emit(); }
 });

 function messageFrom(data, status) {
   if (data && typeof data === "object") {
     const m = data.message || data.msg || data.error_description || data.error;
     if (m) return String(m);
   }
   if (status === 401 || status === 403) return "You don't have permission to do that.";
   if (status >= 500) return "The server had a problem. Please try again in a moment.";
   return "Something went wrong. Please try again.";
 }

 async function request(path, opts) {
   opts = opts || {};
   const ctrl = new AbortController();
   const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
   const headers = { apikey: ANON, "Content-Type": "application/json" };
   if (opts.token) headers.Authorization = "Bearer " + opts.token;
   else if (/^eyJ/.test(ANON)) headers.Authorization = "Bearer " + ANON;   // legacy JWT-style anon key
   let res, text;
   try {
     res = await fetch(BASE + path, {
       method: opts.method || "GET",
       headers,
       body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
       signal: ctrl.signal
     });
     text = await res.text();
   } catch (e) {
     throw new SBError(
       e && e.name === "AbortError"
         ? "The server took too long to answer. Please try again."
         : "Can't reach the server. Check your internet connection and try again.",
       0, "network");
   } finally {
     clearTimeout(timer);
   }
   let data = null;
   if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text.slice(0, 200) }; } }
   if (!res.ok) {
     throw new SBError(messageFrom(data, res.status), res.status,
                       data && (data.error_code || data.code || data.error) || "");
   }
   return data;
 }

 function refresh() {
   if (!session) return Promise.resolve(null);
   if (refreshing) return refreshing;
   refreshing = request("/auth/v1/token?grant_type=refresh_token", {
     method: "POST", body: { refresh_token: session.refresh_token }
   }).then(d => { writeSession(toSession(d)); return session; })
     .catch(e => {
       // only a rejected token ends the session - a flaky connection must not log people out
       if (e.status >= 400 && e.status < 500) writeSession(null);
       throw e;
     })
     .finally(() => { refreshing = null; });
   return refreshing;
 }

 async function freshToken() {
   if (!session) return null;
   if (session.expires_at - Date.now() / 1000 > 60) return session.access_token;
   await refresh();
   return session ? session.access_token : null;
 }

 async function rpc(name, args, _retried) {
   if (!configured) throw new SBError("The shop isn't connected to its database yet.", 0, "not_configured");
   let token = null;
   if (session) {
     try { token = await freshToken(); }
     catch (e) { if (e.code === "network") throw e; token = null; }   // session was rejected: carry on as a guest
   }
   try {
     return await request("/rest/v1/rpc/" + encodeURIComponent(name), {
       method: "POST", body: args || {}, token
     });
   } catch (e) {
     if (e.status === 401 && token && !_retried) {
       try { await refresh(); } catch (_) { /* fall through */ }
       return rpc(name, args, true);
     }
     throw e;
   }
 }

 const auth = {
   async signUp(email, password, fullName) {
     if (!configured) throw new SBError("The shop isn't connected to its database yet.", 0, "not_configured");
     const d = await request("/auth/v1/signup", {
       method: "POST", body: { email, password, data: { full_name: fullName || "" } }
     });
     if (d && d.access_token) { writeSession(toSession(d)); return { signedIn: true }; }
     return { signedIn: false };     // the project requires email confirmation first
   },
   async signIn(email, password) {
     if (!configured) throw new SBError("The shop isn't connected to its database yet.", 0, "not_configured");
     const d = await request("/auth/v1/token?grant_type=password", {
       method: "POST", body: { email, password }
     });
     writeSession(toSession(d));
     return session;
   },
   async signOut() {
     const t = session && session.access_token;
     writeSession(null);
     if (t) { try { await request("/auth/v1/logout", { method: "POST", token: t, timeout: 6000 }); } catch (e) { /* already signed out locally */ } }
   },
   getSession: () => session,
   getUser: () => (session ? session.user : null),
   onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
   refresh
 };

 global.SB = { configured, rpc, auth, SBError };

 /* -------------------------- SwamyWeight -------------------------- */
 // Delivery is charged by the quantity and weight of the order, so we show
 // the approximate parcel weight (read from sizes like "200 gm" or "1 kg").
 function parseGrams(label) {
   const m = String(label == null ? "" : label).match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilograms?|gm|gms|g|grams?)\b/i);
   if (!m) return null;
   const n = parseFloat(m[1]);
   return Math.round(/^k/i.test(m[2]) ? n * 1000 : n);
 }
 function fmtWeight(g) {
   if (g < 1000) return g + " g";
   return (Math.round(g / 10) / 100).toString() + " kg";
 }
 // items: [{ weight: "200 gm", qty: 2 }, ...]  ->  { grams, text } or null if any size has no readable weight
 function orderWeight(items) {
   let total = 0;
   for (const it of items) {
     const g = parseGrams(it.weight);
     if (g === null) return null;
     total += g * (Number(it.qty) || 0);
   }
   return total > 0 ? { grams: total, text: fmtWeight(total) } : null;
 }
 global.SwamyWeight = { parseGrams, fmtWeight, orderWeight };

 /* --------------------------- SwamyUtil --------------------------- */
 // h("div", {class:"x", onclick:fn}, "text", childNode) builds DOM using textContent only,
 // so nothing a customer types can ever become HTML.
 function h(tag, attrs) {
   const el = document.createElement(tag);
   if (attrs) {
     Object.keys(attrs).forEach(k => {
       const v = attrs[k];
       if (v === false || v === null || v === undefined) return;
       if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
       else if (k === "class") el.className = v;
       else if (k === "value") el.value = v;
       else if (k === "checked" || k === "disabled" || k === "selected" || k === "required") el[k] = !!v;
       else el.setAttribute(k, v === true ? "" : v);
     });
   }
   for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
   return el;
 }
 function append(el, c) {
   if (c === null || c === undefined || c === false) return;
   if (Array.isArray(c)) c.forEach(x => append(el, x));
   else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
 }
 const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
 const fmtMoney = n => money.format(Number(n) || 0);
 const fmtDate = iso => {
   if (!iso) return "";
   const d = new Date(iso);
   if (isNaN(d)) return "";
   return d.toLocaleString("en-AU", { timeZone: "Australia/Melbourne", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
 };
 const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

 /* ---- icons (simple outline set, drawn as inline SVG so they take the text colour) ---- */
 const ICONS = {
   user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
   bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
   menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
   close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
   chevron: '<polyline points="9 18 15 12 9 6"/>',
   check: '<polyline points="20 6 9 17 4 12"/>',
   alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
   info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
   back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
   trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
   lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
 };
 function icon(name) {
   const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
   svg.setAttribute("viewBox", "0 0 24 24");
   svg.setAttribute("fill", "none");
   svg.setAttribute("stroke", "currentColor");
   svg.setAttribute("stroke-width", "2");
   svg.setAttribute("stroke-linecap", "round");
   svg.setAttribute("stroke-linejoin", "round");
   svg.setAttribute("aria-hidden", "true");
   svg.innerHTML = ICONS[name] || "";
   return svg;
 }
 // a clear message block: kind = "info" | "error" | "success" | "warn"
 function alertBox(kind, title, body) {
   return h("div", { class: "alert " + (kind === "info" ? "" : kind), role: kind === "error" ? "alert" : "status" },
     icon(kind === "success" ? "check" : kind === "info" ? "info" : "alert"),
     h("div", null, title ? h("strong", null, title) : null, body));
 }
 const loadingRow = text => h("div", { class: "loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), text || "Loading…");

 /* ---- per-field error messages (shown under the field, linked for screen readers) ---- */
 function setFieldError(form, name, msg) {
   const el = form.elements[name];
   if (!el) return null;
   const wrap = el.closest(".field");
   const holder = wrap && wrap.querySelector(".field-error");
   if (!wrap || !holder) return el;
   if (msg) {
     el.setAttribute("aria-invalid", "true");
     wrap.classList.add("has-error");
     holder.textContent = msg;
     holder.hidden = false;
   } else {
     el.removeAttribute("aria-invalid");
     wrap.classList.remove("has-error");
     holder.textContent = "";
     holder.hidden = true;
   }
   return el;
 }
 function clearFieldErrors(form) {
   form.querySelectorAll(".field.has-error").forEach(w => {
     const el = w.querySelector("input,select,textarea");
     if (el && el.name) setFieldError(form, el.name, "");
   });
 }
 // a labelled input that clears its own error as soon as the customer starts fixing it
 function field(label, name, opts) {
   opts = opts || {};
   const key = opts.id || name;                    // pages with two forms pass opts.id so ids stay unique
   const id = opts.id || ("f-" + name);
   const common = { id, name, autocomplete: opts.ac || "off", "aria-describedby": "err-" + key + (opts.hint ? " hint-" + key : "") };
   const input = opts.type === "textarea"
     ? h("textarea", Object.assign({ maxlength: opts.max || 500, rows: 3, value: opts.value || "" }, common))
     : h("input", Object.assign({ type: opts.type || "text", value: opts.value || "", maxlength: opts.max || 120,
                                  inputmode: opts.mode, placeholder: opts.ph }, common));
   const wrap = h("div", { class: "field" },
     h("label", { for: id }, label, opts.optional ? h("span", { class: "opt" }, " (optional)") : null),
     input,
     opts.hint ? h("p", { class: "hint", id: "hint-" + key }, opts.hint) : null,
     h("p", { class: "field-error", id: "err-" + key, hidden: true }));
   input.addEventListener("input", () => {
     if (wrap.classList.contains("has-error")) { wrap.classList.remove("has-error"); input.removeAttribute("aria-invalid"); wrap.querySelector(".field-error").hidden = true; }
   });
   return wrap;
 }

 /* ---- order status, progress timeline and order summary (shop, thank-you, track, account) ---- */
 const STATUS = {
   submitted: ["Received", "made"], confirmed: ["Confirmed", "made"], invoiced: ["Invoice sent", "low"],
   paid: ["Paid", "in"], shipped: ["Shipped", "in"], cancelled: ["Cancelled", "out"]
 };
 const STEPS = ["submitted", "confirmed", "invoiced", "paid", "shipped"];
 const statusTag = s => { const st = STATUS[s] || [s, "neutral"]; return h("span", { class: "status " + st[1] }, st[0]); };
 function timeline(status) {
   if (status === "cancelled") return alertBox("warn", "This order was cancelled", "If you didn't expect this, please contact us.");
   const at = STEPS.indexOf(status);
   return h("ol", { class: "timeline", "aria-label": "Order progress" }, STEPS.map((s, i) =>
     h("li", { class: i < at ? "done" : i === at ? "now" : "", "aria-current": i === at ? "step" : null },
       STATUS[s][0], i === at ? h("span", { class: "sr-only" }, " (current step)") : null)));
 }
 function orderCard(o, opts) {
   opts = opts || {};
   const early = o.status === "submitted" || o.status === "confirmed";
   const fee = Number(o.shipping_fee) || 0;
   const disc = Number(o.discount) || 0;
   const rows = [h("div", { class: "srow" }, h("span", null, "Items"), h("span", null, fmtMoney(o.subtotal)))];
   if (disc > 0) rows.push(h("div", { class: "srow" }, h("span", null, "Discount"), h("span", null, "−" + fmtMoney(disc))));
   rows.push(h("div", { class: "srow" }, h("span", null, "Delivery"),
     fee > 0 ? h("span", null, fmtMoney(fee)) : h("span", { class: early ? "tbc" : "" }, early ? "To be confirmed" : "Free")));
   rows.push(h("div", { class: "srow total" }, h("span", null, early && fee === 0 ? "Items total" : "Total"), h("span", null, fmtMoney(o.total))));
   const w = SwamyWeight.orderWeight(o.items || []);
   return h("article", { class: "order" },
     h("div", { class: "order-head" },
       h("div", null, h("div", { class: "order-ref" }, o.ref), h("div", { class: "order-date" }, "Placed " + fmtDate(o.created_at))),
       statusTag(o.status)),
     opts.timeline ? timeline(o.status) : null,
     h("ul", { class: "order-items" }, (o.items || []).map(i =>
       h("li", null, h("span", null, i.name + " (" + i.weight + ")"), h("span", { class: "q" }, "× " + i.qty)))),
     rows,
     w ? h("p", { class: "small" }, "Approximate weight: " + w.text) : null,
     o.invoice_no ? h("p", { class: "small" }, "Invoice number: " + o.invoice_no) : null,
     early ? h("p", { class: "small" }, "We'll email your invoice with the final total and delivery once we've checked stock.") : null,
     opts.trackLink ? h("p", { class: "small" }, h("a", { href: "track.html?ref=" + encodeURIComponent(o.ref) }, "Track this order")) : null);
 }
 global.SwamyUtil = { h, fmtMoney, fmtDate, esc, icon, alertBox, loadingRow, setFieldError, clearFieldErrors, field, statusTag, timeline, orderCard, STATUS };
})(window);

/* =====================================================================
  SWAMY FOODS - the shop itself (catalog, cart, header, and every page's behaviour)
  Pages tell this file what they are with <body data-page="...">.
  ===================================================================== */
(function (global) {
 "use strict";
 const { h, fmtMoney, fmtDate, icon, alertBox, loadingRow, setFieldError, clearFieldErrors, field, orderCard } = SwamyUtil;
 const $ = (s, root) => (root || document).querySelector(s);

 /* ------------------------------ settings you might touch ------------------------------ */
 const CONTACT = { phone: "0493 129 799", tel: "+61493129799", email: "enquiry@swamyfoods.com.au" };
 const FACEBOOK_URL = "https://www.facebook.com/SwamyFoodsAus/";
 const IMAGE_FOLDER = "images/";       // product photos: images/<product-name-with-dashes>.png
 const LOW_STOCK_AT = 5;               // "Only 3 left" shows at or below this
 const MAX_PER_ITEM = 99;
 const KEYS = { cart: "swamyfoods.cart.v2", catalog: "swamyfoods.catalog.v3", lastOrder: "swamyfoods.lastOrder.v1", draft: "swamyfoods.checkoutDraft.v1", notice: "swamyfoods.notice.v1" };
 const AU_STATES = ["VIC", "NSW", "QLD", "SA", "WA", "TAS", "ACT", "NT"];
 const CATEGORIES = [
   { id: "spices", title: "Spice varieties", blurb: "Ground fresh once you order. Nothing sits on a shelf.", defaultType: "made" },
   { id: "appalam", title: "Appalam & vadam", blurb: "Imported and kept in stock, ready to ship.", defaultType: "stock" }
 ];
 // A copy of the price list, used ONLY to let people browse if the database can't be reached.
 const FALLBACK = [
   ["Nalla Karam Powder", "spices", "200 gm", "8.00"], ["Paruppu [Kandi] Powder", "spices", "200 gm", "7.50"],
   ["Idly / Dosa Chilli Powder", "spices", "200 gm", "7.00"], ["Peanut Chutney Powder", "spices", "200 gm", "8.00"],
   ["Ellu Podi / Nuvvula Kaaram", "spices", "200 gm", "7.50"], ["Sambar Powder", "spices", "500 gm", "15.00"],
   ["Curry Leaves Powder", "spices", "200 gm", "9.00"], ["Instant Adai [Dal Dosa] Mix", "spices", "500 gm", "7.00"],
   ["Mor Kozhambu Mix", "spices", "300 gm", "8.50"], ["Rasam Powder", "spices", "200 gm", "7.50"],
   ["Curry Powder", "spices", "200 gm", "7.50"], ["Energy & Protein Health Mix", "spices", "225 gm", "8.00"],
   ["Rice Appalam", "appalam", "200 gm", "5.00"], ["Tomato Appalam", "appalam", "200 gm", "5.00"],
   ["Ragi Appalam", "appalam", "200 gm", "5.00"], ["Tapioca [Marchini] Appalam", "appalam", "200 gm", "5.00"],
   ["Ilavadagam", "appalam", "200 gm", "5.00"], ["Sago [Javvarisi] Vadam", "appalam", "250 gm", "6.00"],
   ["Omapodi Vadam", "appalam", "250 gm", "6.00"], ["Ribbon Vadam", "appalam", "250 gm", "6.00"],
   ["Neetu [Rice] Vadam", "appalam", "250 gm", "6.00"]
 ];
 const CAT = new Map(CATEGORIES.map(c => [c.id, c]));
 const nameKey = n => String(n == null ? "" : n).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
 const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
 const validPhone = p => /^[0-9+() -]{8,20}$/.test(p) && p.replace(/\D/g, "").length >= 8;
 const SAFE_NEXT = ["checkout.html", "cart.html", "account.html", "track.html", "index.html"];
 const safeNext = v => (SAFE_NEXT.indexOf(String(v || "")) >= 0 ? v : "");

 /* ------------------------------ messages (no pop-ups) ------------------------------ */
 // Short confirmations are announced to screen readers through a hidden live region.
 // Anything a customer needs to act on is shown as a visible message on the page itself.
 let liveEl = null;
 function say(msg) {
   if (!liveEl) { liveEl = h("div", { class: "sr-only", role: "status", "aria-live": "polite" }); document.body.appendChild(liveEl); }
   liveEl.textContent = "";
   setTimeout(() => { liveEl.textContent = msg; }, 30);
 }
 // "Your cart was updated" is kept until a page shows it (it can happen while another page is loading).
 const NOTE_KEY = "swamyfoods.cartNote.v1";
 const setNote = msg => { try { sessionStorage.setItem(NOTE_KEY, msg); } catch (e) {} };
 const takeNote = () => { try { const m = sessionStorage.getItem(NOTE_KEY); sessionStorage.removeItem(NOTE_KEY); return m || ""; } catch (e) { return ""; } };
 const noteBox = msg => (msg ? alertBox("warn", "Your cart was updated", msg) : null);

 // keep keyboard focus on the "same" control when part of a screen is redrawn
 function keepFocus(container, rebuild) {
   const a = document.activeElement;
   const key = a && container.contains(a) ? a.getAttribute("data-fk") : null;
   rebuild();
   if (!key) return;
   const find = k => { for (const el of container.querySelectorAll("[data-fk]")) if (el.getAttribute("data-fk") === k) return el; return null; };
   const cut = key.indexOf(":");
   const base = cut < 0 ? key : key.slice(0, cut), rest = cut < 0 ? "" : key.slice(cut);
   const fallback = { add: "plus", minus: "add" }[base];
   const el = find(key) || (fallback && find(fallback + rest)) || find("first");
   if (el) el.focus();
 }

 /* ------------------------------ catalog ------------------------------ */
 function stockInfo(qty, catId) {
   if (qty === null || qty === undefined || isNaN(qty)) {
     return (CAT.get(catId) || {}).defaultType === "made"
       ? { cls: "made", text: "Made fresh to order", sellable: true, max: MAX_PER_ITEM }
       : { cls: "in", text: "In stock", sellable: true, max: MAX_PER_ITEM };
   }
   if (qty <= 0) return { cls: "out", text: "Out of stock", sellable: false, max: 0 };
   if (qty <= LOW_STOCK_AT) return { cls: "low", text: "Only " + qty + " left", sellable: true, max: Math.min(qty, MAX_PER_ITEM) };
   return { cls: "in", text: "In stock", sellable: true, max: Math.min(qty, MAX_PER_ITEM) };
 }
 function imageFor(row) {
   const f = String(row.image || "");
   return IMAGE_FOLDER + (/^[A-Za-z0-9._-]+\.png$/.test(f) ? f : nameKey(row.name) + ".png");
 }
 function normalize(rows) {
   const rank = new Map(CATEGORIES.map((c, i) => [c.id, i]));
   const out = (rows || []).map(r => {
     const catId = CAT.has(r.category) ? r.category : "spices";
     const variants = (r.variants || []).map(v => {
       const price = Number(v.price), ok = v.price !== null && v.price !== "" && isFinite(price);
       return { id: v.id || null, weight: String(v.weight || "1 pack"), priceValue: ok ? price : null, priceText: ok ? fmtMoney(price) : "Enquire",
                stock: stockInfo(v.stock === null || v.stock === undefined ? null : Number(v.stock), catId) };
     });
     return { id: r.id || null, name: String(r.name || ""), catId, note: String(r.note || ""), image: imageFor(r), variants,
              sort: Number(r.sort_order) || 0, anySellable: variants.some(v => v.stock.sellable) };
   }).filter(p => p.name && p.variants.length);
   out.sort((a, b) => (rank.get(a.catId) - rank.get(b.catId)) || (a.sort - b.sort) || a.name.localeCompare(b.name));
   return out;
 }
 const Catalog = {
   products: [], index: new Map(), source: "none", canOrder: false, fetchedAt: 0, raw: "", _subs: new Set(),
   onChange(fn) { this._subs.add(fn); },
   _apply(rows, source, at) {
     const raw = JSON.stringify(rows);
     this.fetchedAt = at;
     if (raw === this.raw && source === this.source) return false;
     this.raw = raw; this.source = source; this.canOrder = source === "server";
     this.products = normalize(rows);
     this.index.clear();
     this.products.forEach(p => p.variants.forEach(v => { if (v.id) this.index.set(v.id, { product: p, variant: v }); }));
     if (this.canOrder) Cart.reconcile();
     this._subs.forEach(fn => fn());
     return true;
   },
   _defaults() {
     const by = new Map();
     FALLBACK.forEach((d, i) => {
       if (!by.has(d[0])) by.set(d[0], { name: d[0], category: d[1], sort_order: i, variants: [] });
       by.get(d[0]).variants.push({ weight: d[2], price: d[3], stock: null });
     });
     this._apply([...by.values()], "default", 0);
   },
   async load(opts) {
     const force = opts && opts.force;
     let cached = null;
     try { const o = JSON.parse(localStorage.getItem(KEYS.catalog) || "null"); if (o && Array.isArray(o.rows) && o.at) cached = o; } catch (e) {}
     if (cached && this.source === "none") this._apply(cached.rows, "server", cached.at);
     if (!SB.configured) { if (this.source === "none") this._defaults(); return this; }
     if (!force && cached && Date.now() - cached.at < 60000) return this;
     try {
       const rows = await SB.rpc("get_catalog", {});
       if (!Array.isArray(rows)) throw new Error("unexpected reply");
       try { localStorage.setItem(KEYS.catalog, JSON.stringify({ rows, at: Date.now() })); } catch (e) {}
       this._apply(rows, "server", Date.now());
     } catch (e) {
       console.warn("Swamy Foods: couldn't load the product list:", e.message);
       if (this.source === "none") this._defaults();
     }
     return this;
   },
   forget() { try { localStorage.removeItem(KEYS.catalog); } catch (e) {} }
 };

 /* ------------------------------ cart (kept in the customer's browser) ------------------------------ */
 const Cart = (function () {
   let data = read();
   const subs = new Set();
   function read() {
     try {
       const o = JSON.parse(localStorage.getItem(KEYS.cart) || "{}"), out = {};
       Object.keys(o || {}).forEach(id => { const q = Math.floor(Number(o[id])); if (/^[0-9a-f-]{36}$/i.test(id) && q > 0 && q <= MAX_PER_ITEM) out[id] = q; });
       return out;
     } catch (e) { return {}; }
   }
   function save() { try { localStorage.setItem(KEYS.cart, JSON.stringify(data)); } catch (e) {} }
   function emit() { subs.forEach(fn => fn()); }
   global.addEventListener("storage", e => { if (e.key === KEYS.cart) { data = read(); emit(); } });
   const api = {
     onChange(fn) { subs.add(fn); },
     qty: id => data[id] || 0,
     count: () => Object.keys(data).reduce((n, id) => n + data[id], 0),
     isEmpty: () => Object.keys(data).length === 0,
     set(id, q) {
       const e = Catalog.index.get(id), max = e ? e.variant.stock.max : MAX_PER_ITEM;
       q = Math.floor(Number(q)) || 0;
       if (q > max) { q = max; say(max === 0 ? "Sorry, that item is out of stock." : "Only " + max + " available."); }
       if (q <= 0) delete data[id]; else data[id] = q;
       save(); emit();
     },
     clear() { data = {}; save(); emit(); },
     lines() {
       return Object.keys(data).map(id => {
         const e = Catalog.index.get(id);
         if (!e) return null;
         const price = e.variant.priceValue || 0;
         return { id, product: e.product, variant: e.variant, qty: data[id], line: Math.round(price * data[id] * 100) / 100 };
       }).filter(Boolean);
     },
     subtotal() { return Math.round(api.lines().reduce((s, l) => s + l.line, 0) * 100) / 100; },
     weight() { const w = SwamyWeight.orderWeight(api.lines().map(l => ({ weight: l.variant.weight, qty: l.qty }))); return w ? w.text : ""; },
     // after the product list changes, drop or trim anything that isn't available any more
     reconcile() {
       let changed = false;
       Object.keys(data).forEach(id => {
         const e = Catalog.index.get(id);
         if (!e || !e.variant.stock.sellable) { delete data[id]; changed = true; }
         else if (data[id] > e.variant.stock.max) { data[id] = e.variant.stock.max; changed = true; }
       });
       if (changed) { save(); setNote("We changed your cart to match what's available now. An item may have sold out or the stock may have dropped."); say("Your cart was updated."); emit(); }
     }
   };
   return api;
 })();

 /* ------------------------------ header, footer, notice ------------------------------ */
 const Chrome = {
   init(page) {
     const header = $(".site-header");
     const cartLink = $("#navCart"), cartCount = $("#cartCount"), acct = $("#navAccount"), acctLabel = $("#navAccountLabel");
     const paintCart = () => {
       const n = Cart.count();
       if (cartCount) { cartCount.textContent = n; cartCount.setAttribute("data-n", n); }
       if (cartLink) cartLink.setAttribute("aria-label", n ? "Cart, " + n + (n === 1 ? " item" : " items") : "Cart, empty");
       const bar = $("#cartBar");
       if (bar) {
         bar.classList.toggle("show", n > 0);
         document.body.classList.toggle("has-cart-bar", n > 0);
         const sub = Catalog.canOrder ? " · " + fmtMoney(Cart.subtotal()) : "";
         bar.replaceChildren(h("span", null, "View cart (" + n + (n === 1 ? " item" : " items") + ")" + sub), icon("chevron"));
       }
     };
     const paintAcct = () => {
       const u = SB.auth.getUser();
       if (acctLabel) acctLabel.textContent = u ? "Account" : "Log in";
       if (acct) acct.setAttribute("aria-label", u ? "Your account" : "Log in or create an account");
     };
     paintCart(); paintAcct();
     Cart.onChange(paintCart); Catalog.onChange(paintCart); SB.auth.onChange(paintAcct);
     const btn = $("#menuBtn");
     if (btn && header) {
       const set = open => { header.classList.toggle("nav-open", open); btn.setAttribute("aria-expanded", String(open)); btn.setAttribute("aria-label", open ? "Close menu" : "Open menu"); btn.replaceChildren(icon(open ? "close" : "menu")); };
       btn.addEventListener("click", () => set(!header.classList.contains("nav-open")));
       document.addEventListener("keydown", e => { if (e.key === "Escape" && header.classList.contains("nav-open")) { set(false); btn.focus(); } });
       header.querySelectorAll(".primary-nav a").forEach(a => a.addEventListener("click", () => set(false)));
       set(false);
     }
     document.querySelectorAll("[data-facebook]").forEach(a => { a.href = FACEBOOK_URL; });
     document.querySelectorAll("[data-year]").forEach(n => { n.textContent = new Date().getFullYear(); });
     Chrome.notice();
   },
   // We use no advertising, analytics or tracking. The only storage is the cart, login and this note.
   notice() {
     try { if (localStorage.getItem(KEYS.notice)) return; } catch (e) {}
     if ($("#storageNotice")) return;
     const dismiss = () => { try { localStorage.setItem(KEYS.notice, String(Date.now())); } catch (e) {} box.remove(); };
     const box = h("div", { class: "notice-card", id: "storageNotice", role: "region", "aria-label": "Cookies and browser storage" },
       h("strong", null, "Cookies and browser storage"),
       h("p", null, "We only use your browser's storage to remember your cart and keep you logged in. No ads, no tracking. ",
         h("a", { href: "privacy.html#storage" }, "Privacy policy"), "."),
       h("button", { class: "btn btn-sm", type: "button", onclick: dismiss }, "Got it"),
       h("button", { class: "notice-close", type: "button", "aria-label": "Close this notice", onclick: dismiss }, icon("close")));
     document.body.appendChild(box);
   }
 };

 /* ------------------------------ shared pieces ------------------------------ */
 function stepper(id, q, label, max) {
   return h("div", { class: "stepper", role: "group", "aria-label": "Quantity of " + label },
     h("button", { type: "button", "data-fk": "minus:" + id, "aria-label": "Remove one " + label, onclick: () => Cart.set(id, q - 1) }, "−"),
     h("output", { "aria-live": "polite" }, String(q)),
     h("button", { type: "button", "data-fk": "plus:" + id, "aria-label": "Add one more " + label, disabled: q >= max, onclick: () => Cart.set(id, q + 1) }, "+"));
 }
 function summaryBlock(lines, opts) {
   opts = opts || {};
   const w = Cart.weight();
   const n = lines.reduce((a, l) => a + l.qty, 0);
   return h("section", { class: "summary " + (opts.cls || ""), "aria-label": "Order summary" },
     h("h2", null, "Order summary"),
     opts.items === false ? null : h("ul", { class: "summary-items" }, lines.map(l =>
       h("li", null, h("span", null, l.product.name + " × " + l.qty), h("span", { class: "sub" }, l.variant.weight + " · " + l.variant.priceText + " each"), h("span", { class: "amt" }, fmtMoney(l.line))))),
     h("div", { class: "srow" }, h("span", null, "Items (" + n + ")"), h("span", null, fmtMoney(Cart.subtotal()))),
     h("div", { class: "srow" }, h("span", null, "Delivery"), h("span", { class: "tbc" }, "Confirmed on your invoice")),
     h("div", { class: "srow total" }, h("span", null, "Items total"), h("span", null, fmtMoney(Cart.subtotal()))),
     h("p", { class: "small" }, "Delivery depends on the quantity and weight of your order" + (w ? " (about " + w + ")" : "") + ". You don't pay on this website. We email you an invoice."),
     opts.footer || null);
 }
 const emptyCart = () => h("div", { class: "empty" }, h("strong", null, "Your cart is empty"), h("p", null, "Pick a few items and they'll show up here."),
   h("a", { class: "btn", href: "index.html#products" }, "Browse products"));
 function busy(btn, on, textOn, textOff) { btn.disabled = on; btn.classList.toggle("is-loading", on); btn.textContent = on ? textOn : textOff; }
 function applyErrors(form, errs, box) {
   clearFieldErrors(form);
   let first = null;
   errs.forEach(e => { const el = setFieldError(form, e[0], e[1]); if (el && !first) first = el; });
   if (box) { box.hidden = !errs.length; box.replaceChildren(...(errs.length ? [icon("alert"), h("div", null, h("strong", null, errs.length === 1 ? "Please fix the highlighted field." : "Please fix the highlighted fields."))] : [])); }
   if (first) first.focus();
 }
 const formAlert = () => h("div", { class: "alert error", role: "alert", hidden: true });
 function showFormAlert(box, title, body) { box.replaceChildren(icon("alert"), h("div", null, h("strong", null, title), body || null)); box.hidden = false; box.scrollIntoView({ block: "nearest" }); }
 function stateField(value) {
   const sel = h("select", { id: "f-state", name: "state", autocomplete: "address-level1", "aria-describedby": "err-state" },
     h("option", { value: "" }, "Choose…"), AU_STATES.map(s => h("option", { value: s, selected: s === value }, s)));
   const wrap = h("div", { class: "field" }, h("label", { for: "f-state" }, "State"), sel, h("p", { class: "field-error", id: "err-state", hidden: true }));
   sel.addEventListener("change", () => setFieldError(sel.form, "state", ""));
   return wrap;
 }
 function serverField(msg) {
   const m = String(msg || "").toLowerCase();
   const map = [[/^please enter your full name/, "name"], [/^please enter a valid email/, "email"], [/^please enter a valid phone/, "phone"],
     [/^please enter your street address/, "address_line1"], [/^address line 2/, "address_line2"], [/^please enter your suburb/, "suburb"],
     [/^please choose your state/, "state"], [/^please enter a 4-digit postcode/, "postcode"], [/^your note is too long/, "note"]];
   for (const [re, f] of map) if (re.test(m)) return f;
   return null;
 }
 const friendlyAuthError = e => {
   const m = String((e && e.message) || "");
   if (/invalid login/i.test(m)) return "That email and password don't match. Check them and try again.";
   if (/already (registered|exists)/i.test(m)) return "There's already an account with that email. Log in instead.";
   if (/not confirmed/i.test(m)) return "Please confirm your email first. Check your inbox for our link, then log in.";
   if (/rate limit|too many/i.test(m)) return "Too many attempts. Please wait a few minutes and try again.";
   if (/password/i.test(m) && /(least|short|weak)/i.test(m)) return "Please choose a longer password (at least 8 characters).";
   return m || "Something went wrong. Please try again.";
 };
 const pageRoot = id => $("#" + id) || $("main");

 /* ------------------------------ SHOP (index.html) ------------------------------ */
 const ctrls = new Map();
 function paintCtrl(id) {
   const host = ctrls.get(id), e = Catalog.index.get(id);
   if (!host || !e) return;
   const q = Cart.qty(id), label = e.product.name + " (" + e.variant.weight + ")";
   keepFocus(host, () => {
     host.replaceChildren(q ? stepper(id, q, label, e.variant.stock.max)
       : h("button", { class: "add-btn", type: "button", "data-fk": "add:" + id, "aria-label": "Add " + label + " to cart",
                       onclick: () => { Cart.set(id, 1); say(e.product.name + " added to your cart."); } }, "Add to cart"));
   });
 }
 function productCard(p) {
   const media = h("div", { class: "product-media" }, h("span", { class: "product-initial", "aria-hidden": "true" }, p.name.trim().charAt(0).toUpperCase()));
   const img = h("img", { src: p.image, alt: p.name, width: 600, height: 450, loading: "lazy", decoding: "async" });
   img.addEventListener("error", () => img.remove(), { once: true });
   media.appendChild(img);
   const list = h("div", { class: "variants" });
   p.variants.forEach(v => {
     const row = h("div", { class: "variant" },
       h("div", null, h("div", { class: "variant-size" }, v.weight), h("span", { class: "status " + v.stock.cls }, v.stock.text)),
       h("div", { class: "variant-price" }, v.priceText));
     if (Catalog.canOrder && v.id && v.stock.sellable && v.priceValue !== null) { const host = h("div", { class: "variant-ctrl" }); ctrls.set(v.id, host); row.appendChild(host); }
     list.appendChild(row);
   });
   return h("article", { class: "product" + (p.anySellable ? "" : " is-out") }, media,
     h("div", { class: "product-body" }, h("h3", null, p.name), p.note ? h("p", { class: "product-note" }, p.note) : null, list));
 }
 function renderShop(root) {
   ctrls.clear();
   root.removeAttribute("aria-busy");
   if (!Catalog.products.length) {
     root.replaceChildren(h("div", { class: "empty" }, h("strong", null, "Our list is being updated"),
       h("p", null, "Please call " + CONTACT.phone + " or email " + CONTACT.email + " and we'll tell you what's available today.")));
   } else {
     const frag = document.createDocumentFragment();
     const note = noteBox(takeNote());
     if (note) frag.appendChild(note);
     if (!Catalog.canOrder) {
       frag.appendChild(alertBox("warn", "Online ordering is paused right now.", h("span", null, "You can still browse everything below. To order, please call ",
         h("a", { href: "tel:" + CONTACT.tel }, CONTACT.phone), " or email ", h("a", { href: "mailto:" + CONTACT.email }, CONTACT.email), ".")));
     }
     CATEGORIES.forEach(cat => {
       const items = Catalog.products.filter(p => p.catId === cat.id);
       if (!items.length) return;
       frag.appendChild(h("section", { class: "category", id: "cat-" + cat.id, "aria-labelledby": "cat-h-" + cat.id },
         h("div", { class: "category-head" }, h("h3", { id: "cat-h-" + cat.id }, cat.title), h("p", null, cat.blurb)),
         h("div", { class: "product-grid" }, items.map(productCard))));
     });
     root.replaceChildren(frag);
     ctrls.forEach((_, id) => paintCtrl(id));
   }
   const total = Catalog.products.length;
   document.querySelectorAll("[data-product-count]").forEach(n => { n.textContent = total || "—"; });
   CATEGORIES.forEach(cat => {
     const c = Catalog.products.filter(p => p.catId === cat.id).length;
     document.querySelectorAll('[data-cat-count="' + cat.id + '"]').forEach(n => { n.textContent = c ? c + (c === 1 ? " product" : " products") : ""; });
   });
   const nav = $("#catNav");
   if (nav) nav.replaceChildren(...CATEGORIES.filter(c => Catalog.products.some(p => p.catId === c.id)).map(c =>
     h("li", null, h("a", { href: "#cat-" + c.id }, c.title, h("span", null, "(" + Catalog.products.filter(p => p.catId === c.id).length + ")")))));
 }
 async function pageShop() {
   const root = $("#productContainer");
   root.setAttribute("aria-busy", "true");
   root.replaceChildren(h("div", { class: "skeleton-grid", "aria-hidden": "true" }, Array.from({ length: 8 }, () => h("div", { class: "sk" }, h("i"), h("i"), h("i")))));
   Catalog.onChange(() => renderShop(root));
   Cart.onChange(() => Catalog.index.forEach((_, id) => { if (ctrls.has(id)) paintCtrl(id); }));
   await Catalog.load();
   if (!root.querySelector(".product, .empty, .alert")) renderShop(root);
   document.addEventListener("visibilitychange", () => {
     if (document.visibilityState === "visible" && Catalog.fetchedAt && Date.now() - Catalog.fetchedAt > 300000) Catalog.load({ force: true });
   });
   global.swamyPhotoFiles = () => { const rows = Catalog.products.map(p => ({ Product: p.name, "PNG file": p.image })); if (console.table) console.table(rows); return rows; };
 }

 /* ------------------------------ CART (cart.html) ------------------------------ */
 async function pageCart() {
   const root = pageRoot("cartRoot");
   root.replaceChildren(loadingRow("Loading your cart…"));
   await Catalog.load();
   const noteEl = noteBox(takeNote());
   const put = (...nodes) => root.replaceChildren(...[noteEl, ...nodes].filter(Boolean));
   const draw = () => keepFocus(root, () => {
     if (Cart.isEmpty()) { put(emptyCart()); return; }
     if (!Catalog.canOrder) {
       put(alertBox("error", "We can't load your cart right now.", h("span", null, "Please try again, or call ", h("a", { href: "tel:" + CONTACT.tel }, CONTACT.phone), " to order. ",
         h("button", { class: "btn-quiet", type: "button", onclick: async () => { root.replaceChildren(loadingRow("Loading your cart…")); await Catalog.load({ force: true }); draw(); } }, "Try again"))));
       return;
     }
     const lines = Cart.lines();
     if (!lines.length) { put(emptyCart()); return; }
     put(h("div", { class: "split" },
       h("div", null,
         h("ul", { class: "cart-list" }, lines.map(l => {
           const label = l.product.name + " (" + l.variant.weight + ")";
           return h("li", { class: "cart-row" },
             h("div", { class: "info" }, h("div", { class: "name" }, l.product.name), h("div", { class: "meta" }, l.variant.weight + " · " + l.variant.priceText + " each"),
               l.variant.stock.cls === "low" ? h("div", { class: "status low small" }, l.variant.stock.text) : null),
             h("div", { class: "qtycell" }, stepper(l.id, l.qty, label, l.variant.stock.max)),
             h("div", { class: "line" }, fmtMoney(l.line)),
             h("button", { class: "icon-btn rm", type: "button", "data-fk": "rm:" + l.id, "aria-label": "Remove " + label + " from cart", onclick: () => Cart.set(l.id, 0) }, icon("trash")));
         })),
         h("div", { class: "cart-foot" }, h("a", { class: "btn-quiet", href: "index.html#products" }, "← Continue shopping"))),
       h("div", { class: "sticky" }, summaryBlock(lines, { items: false, footer: h("a", { class: "btn btn-block", href: "checkout.html", style: "margin-top:18px", "data-fk": "first" }, "Continue to checkout") }))));
   });
   Cart.onChange(draw); draw();
 }

 /* ------------------------------ CHECKOUT (checkout.html): details, then on to the review page ------------------------------ */
 const pausedMessage = () => alertBox("error", "Online ordering is paused right now.", h("span", null, "Please call ", h("a", { href: "tel:" + CONTACT.tel }, CONTACT.phone), " or email ", h("a", { href: "mailto:" + CONTACT.email }, CONTACT.email), " to place your order."));
 const readDraft = () => { try { return JSON.parse(sessionStorage.getItem(KEYS.draft) || "null"); } catch (e) { return null; } };
 async function pageCheckout() {
   const root = pageRoot("checkoutRoot");
   root.replaceChildren(loadingRow("Getting your order ready…"));
   await Catalog.load();
   if (Cart.isEmpty() || !Catalog.canOrder || !Cart.lines().length) {
     root.replaceChildren(Cart.isEmpty() || Catalog.canOrder ? emptyCart() : pausedMessage());
     return;
   }
   const user = SB.auth.getUser();
   let p = {};
   if (user) { try { p = await SB.rpc("get_my_profile", {}); } catch (e) { p = {}; } }
   const d = readDraft(), dc = (d && d.customer) || {};          // coming back from the review page: keep what they typed
   const pick = (a, b) => (a !== undefined && a !== null && a !== "" ? a : b);
   const lines = Cart.lines();
   const noteEl = noteBox(takeNote());
   const top = formAlert();
   const form = h("form", { id: "checkoutForm", novalidate: true, "aria-label": "Your details" },
     h("div", { class: "hp", "aria-hidden": "true" }, h("label", { for: "f-website" }, "Leave this empty"), h("input", { id: "f-website", name: "website", tabindex: "-1", autocomplete: "off" })),
     h("h2", { class: "fieldset-title" }, "Contact"),
     field("Full name", "name", { value: pick(dc.name, p.full_name || (user && user.name) || ""), ac: "name", max: 100 }),
     h("div", { class: "field-row" },
       field("Email", "email", { type: "email", value: pick(dc.email, (user && user.email) || ""), ac: "email", max: 254, hint: "We'll send your invoice here." }),
       field("Phone", "phone", { type: "tel", value: pick(dc.phone, p.phone), ac: "tel", max: 20 })),
     h("h2", { class: "fieldset-title" }, "Delivery address"),
     field("Street address", "address_line1", { value: pick(dc.address_line1, p.address_line1), ac: "address-line1" }),
     field("Apartment, unit, etc.", "address_line2", { value: pick(dc.address_line2, p.address_line2), ac: "address-line2", optional: true }),
     h("div", { class: "field-row three" },
       field("Suburb", "suburb", { value: pick(dc.suburb, p.suburb), ac: "address-level2", max: 60 }), stateField(pick(dc.state, p.state)),
       field("Postcode", "postcode", { value: pick(dc.postcode, p.postcode), ac: "postal-code", mode: "numeric", max: 4 })),
     field("Note for us", "note", { type: "textarea", optional: true, max: 500, value: dc.note || "", hint: "Anything we should know about your order or delivery." }),
     user ? h("label", { class: "check" }, h("input", { type: "checkbox", name: "save", checked: d ? d.save !== false : true }), "Save these details to my account") : null);
   const reviewBtn = () => h("button", { class: "btn btn-block", type: "submit", form: "checkoutForm", "data-place": "1" }, "Review order");
   const intro = user
     ? h("p", { class: "muted small", style: "margin-bottom:20px" }, "Signed in as " + user.email + ". ", h("a", { href: "account.html" }, "Your account"))
     : h("p", { class: "muted small", style: "margin-bottom:20px" }, "Checking out as a guest. ", h("a", { href: "account.html?next=checkout.html" }, "Log in"), " to fill in your details automatically.");
   const mobile = h("details", { class: "mobile-summary" },
     h("summary", null, h("span", null, "Order summary"), h("span", null, fmtMoney(Cart.subtotal()))), summaryBlock(lines, { cls: "mobile" }));
   root.replaceChildren(h("div", { class: "split" },
     h("div", null, noteEl, mobile, top, intro, form,
       h("p", { class: "small muted", style: "margin-top:8px" }, "Next you'll check your address and quantities before anything is sent. Nothing is charged here. ", h("a", { href: "terms.html" }, "Terms"), " · ", h("a", { href: "privacy.html" }, "Privacy")),
       h("div", { class: "place-bar" }, reviewBtn())),
     h("div", { class: "sticky col-summary-desktop" }, summaryBlock(lines, { cls: "desk", footer: h("div", { style: "margin-top:18px" }, reviewBtn(), h("p", { class: "small", style: "margin-top:12px" }, h("a", { href: "cart.html" }, "Edit cart"))) }))));

   form.addEventListener("submit", ev => {
     ev.preventDefault();
     const fd = new FormData(form), v = k => String(fd.get(k) || "").trim();
     if (v("website")) return;                                    // a bot filled the hidden field
     const errs = [];
     if (v("name").length < 2) errs.push(["name", "Please enter your full name."]);
     if (!EMAIL_RE.test(v("email"))) errs.push(["email", "Please enter a valid email address."]);
     if (!validPhone(v("phone"))) errs.push(["phone", "Please enter a valid phone number."]);
     if (v("address_line1").length < 3) errs.push(["address_line1", "Please enter your street address."]);
     if (v("suburb").length < 2) errs.push(["suburb", "Please enter your suburb."]);
     if (!AU_STATES.includes(v("state"))) errs.push(["state", "Please choose your state."]);
     if (!/^[0-9]{4}$/.test(v("postcode"))) errs.push(["postcode", "Please enter a 4-digit postcode."]);
     if (errs.length) return applyErrors(form, errs, top);
     applyErrors(form, [], top);
     const customer = { name: v("name"), email: v("email"), phone: v("phone"), address_line1: v("address_line1"), address_line2: v("address_line2"),
                        suburb: v("suburb"), state: v("state"), postcode: v("postcode"), note: v("note") };
     try { sessionStorage.setItem(KEYS.draft, JSON.stringify({ customer, save: !!fd.get("save") })); } catch (e) {}
     location.assign("review.html");
   });
 }

 /* ------------------------------ REVIEW (review.html): check, then confirm ------------------------------ */
 async function pageReview() {
   const root = pageRoot("reviewRoot");
   root.replaceChildren(loadingRow("Getting your order ready…"));
   await Catalog.load();
   if (Cart.isEmpty() || !Catalog.canOrder || !Cart.lines().length) {
     root.replaceChildren(Cart.isEmpty() || Catalog.canOrder ? emptyCart() : pausedMessage());
     return;
   }
   const draft = readDraft();
   if (!draft || !draft.customer) {
     root.replaceChildren(alertBox("info", "We need your delivery details first.", "Enter them and we'll bring you straight back here to check your order."),
       h("a", { class: "btn", href: "checkout.html" }, "Enter delivery details"));
     return;
   }
   const c = draft.customer, user = SB.auth.getUser(), lines = Cart.lines(), top = formAlert(), noteEl = noteBox(takeNote());
   const brJoin = arr => arr.reduce((acc, x, i) => (i ? acc.concat([h("br"), x]) : [x]), []);
   const block = (id, title, href, change, ...body) => h("section", { class: "r-block", "aria-labelledby": id },
     h("div", { class: "r-head" }, h("h2", { id }, title), h("a", { href }, change)), ...body);
   const itemsBlock = block("rItems", "Your items", "cart.html", "Change quantities",
     h("ul", { class: "r-lines" }, lines.map(l => h("li", null,
       h("div", { class: "r-name" }, h("strong", null, l.product.name), h("span", { class: "sub" }, l.variant.weight + " · " + l.variant.priceText + " each")),
       h("div", { class: "r-qty" }, h("span", { class: "r-qty-label" }, "Qty"), h("strong", null, String(l.qty))),
       h("div", { class: "r-amt" }, fmtMoney(l.line))))));
   const toBlock = block("rTo", "Deliver to", "checkout.html", "Change address",
     h("p", { class: "r-address" }, ...brJoin([h("strong", null, c.name)].concat([c.address_line1, c.address_line2, c.suburb + " " + c.state + " " + c.postcode].filter(Boolean)))));
   const contactBlock = block("rContact", "Contact", "checkout.html", "Change contact",
     h("p", { class: "r-address" }, ...brJoin([c.email, c.phone])),
     h("p", { class: "small muted", style: "margin-top:8px" }, "Your invoice will be emailed to " + c.email + "."));
   const noteBlock = c.note ? block("rNote", "Your note", "checkout.html", "Change note", h("p", { class: "r-address" }, c.note)) : null;
   const confirmBtn = cls => h("button", { class: "btn btn-block " + (cls || ""), type: "submit", form: "reviewForm", "data-confirm": "1" }, "Confirm and place order");
   const form = h("form", { id: "reviewForm", novalidate: true },
     h("p", { class: "small muted" }, "By placing this order you confirm the address and quantities above are correct. Nothing is charged now. We email you an invoice, and you pay after that. ",
       h("a", { href: "terms.html" }, "Terms"), " · ", h("a", { href: "privacy.html" }, "Privacy")));
   root.replaceChildren(h("div", { class: "split" },
     h("div", null, noteEl, top, itemsBlock, toBlock, contactBlock, noteBlock, form, h("div", { class: "place-bar" }, confirmBtn())),
     h("div", { class: "sticky" }, summaryBlock(lines, { items: false, footer: h("div", { style: "margin-top:18px" }, confirmBtn("desk-only"), h("p", { class: "small", style: "margin-top:12px" }, h("a", { href: "checkout.html" }, "← Back to details"))) }))));

   let sending = false;
   const setBusy = on => document.querySelectorAll("[data-confirm]").forEach(b => busy(b, on, "Placing your order…", "Confirm and place order"));
   form.addEventListener("submit", async ev => {
     ev.preventDefault();
     if (sending) return;
     sending = true; setBusy(true); top.hidden = true;
     try {
       const items = Cart.lines().map(l => ({ variant_id: l.id, qty: l.qty }));
       const order = await SB.rpc("place_order", { p_customer: c, p_items: items });
       Cart.clear(); Catalog.forget();
       try { sessionStorage.removeItem(KEYS.draft); } catch (e) {}
       if (user && draft.save) {
         try { await SB.rpc("save_my_profile", { p: { full_name: c.name, phone: c.phone, address_line1: c.address_line1, address_line2: c.address_line2, suburb: c.suburb, state: c.state, postcode: c.postcode } }); } catch (e) {}
       }
       try { sessionStorage.setItem(KEYS.lastOrder, JSON.stringify({ order, email: c.email, loggedIn: !!user })); } catch (e) {}
       location.assign("thank-you.html?ref=" + encodeURIComponent(order.ref));
     } catch (e) {
       sending = false; setBusy(false);
       if (serverField(e.message)) showFormAlert(top, "One of your details needs fixing", h("span", null, e.message + " ", h("a", { href: "checkout.html" }, "Go back and fix it")));
       else if (/stock|left|available|cart|item/i.test(e.message || "") && e.code !== "network") {
         await Catalog.load({ force: true });
         showFormAlert(top, "Some items in your cart changed", h("span", null, e.message + " ", h("a", { href: "cart.html" }, "Review your cart")));
       } else showFormAlert(top, "We couldn't send your order", e.message);
     }
   });
 }

 /* ------------------------------ ACCOUNT (account.html) ------------------------------ */
 // A password box with a Show / Hide button (so people can check what they typed, especially on a phone).
 function pwField(label, id, opts) {
   const f = field(label, "password", Object.assign({ id, type: "password", max: 72 }, opts));
   const input = f.querySelector("input");
   const wrap = h("div", { class: "pw" });
   input.parentNode.insertBefore(wrap, input);
   wrap.appendChild(input);
   const btn = h("button", { class: "pw-toggle", type: "button", "aria-pressed": "false", "aria-controls": id, "aria-label": "Show password" }, "Show");
   btn.addEventListener("click", () => {
     const show = input.type === "password";
     input.type = show ? "text" : "password";
     btn.textContent = show ? "Hide" : "Show";
     btn.setAttribute("aria-pressed", String(show));
     btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
   });
   wrap.appendChild(btn);
   return f;
 }
 function authForm(kind, next) {
   const signup = kind === "signup";
   const err = formAlert(), ok = h("div", { class: "alert success", role: "status", hidden: true });
   const submit = h("button", { class: "btn btn-block", type: "submit" }, signup ? "Create account" : "Log in");
   const form = h("form", { novalidate: true, "aria-label": signup ? "Create an account" : "Log in" },
     signup ? field("Your name", "name", { id: "signup-name", ac: "name", max: 100, optional: true }) : null,
     field("Email", "email", { id: kind + "-email", type: "email", ac: signup ? "email" : "username", max: 254 }),
     pwField("Password", kind + "-password", { ac: signup ? "new-password" : "current-password", hint: signup ? "At least 8 characters." : null }),
     err, ok, submit,
     signup
       ? h("p", { class: "small muted form-note" }, "By creating an account you agree to our ", h("a", { href: "terms.html" }, "terms"), " and ", h("a", { href: "privacy.html" }, "privacy policy"), ".")
       : h("p", { class: "small muted form-note" }, "Can't get in? Call ", h("a", { href: "tel:" + CONTACT.tel }, CONTACT.phone), " and we'll help you back into your account."));
   let working = false;
   form.addEventListener("submit", async ev => {
     ev.preventDefault();
     if (working) return;
     ok.hidden = true;
     const fd = new FormData(form), email = String(fd.get("email") || "").trim(), password = String(fd.get("password") || ""), name = String(fd.get("name") || "").trim();
     const errs = [];
     if (!EMAIL_RE.test(email)) errs.push(["email", "Please enter a valid email address."]);
     if (!password) errs.push(["password", "Please enter your password."]);
     else if (signup && password.length < 8) errs.push(["password", "Please choose a password with at least 8 characters."]);
     if (errs.length) return applyErrors(form, errs, err);
     applyErrors(form, [], err);
     working = true; busy(submit, true, signup ? "Creating account…" : "Logging in…");
     try {
       if (signup) {
         const r = await SB.auth.signUp(email, password, name);
         if (!r.signedIn) { working = false; busy(submit, false, "", "Create account"); ok.replaceChildren(icon("check"), h("div", null, h("strong", null, "Almost done"), "Check your email for a confirmation link, then log in.")); ok.hidden = false; return; }
       } else await SB.auth.signIn(email, password);
       location.assign(next || "account.html");
     } catch (e) {
       working = false; busy(submit, false, "", signup ? "Create account" : "Log in");
       const msg = friendlyAuthError(e);
       if (/already an account/.test(msg)) applyErrors(form, [["email", msg]], null); else showFormAlert(err, signup ? "We couldn't create your account" : "We couldn't log you in", msg);
     }
   });
   return form;
 }
 function detailsForm(p) {
   const err = formAlert(), ok = h("div", { class: "alert success", role: "status", hidden: true });
   const submit = h("button", { class: "btn", type: "submit" }, "Save details");
   const form = h("form", { novalidate: true, "aria-label": "Delivery details" },
     h("div", { class: "field-row" }, field("Full name", "full_name", { value: p.full_name, ac: "name", max: 100 }), field("Phone", "phone", { value: p.phone, ac: "tel", type: "tel", max: 20 })),
     field("Street address", "address_line1", { value: p.address_line1, ac: "address-line1" }),
     field("Apartment, unit, etc.", "address_line2", { value: p.address_line2, ac: "address-line2", optional: true }),
     h("div", { class: "field-row three" }, field("Suburb", "suburb", { value: p.suburb, ac: "address-level2", max: 60 }), stateField(p.state),
       field("Postcode", "postcode", { value: p.postcode, ac: "postal-code", mode: "numeric", max: 4 })),
     err, ok, submit);
   let saving = false;
   form.addEventListener("submit", async ev => {
     ev.preventDefault();
     if (saving) return;
     ok.hidden = true;
     const fd = new FormData(form), data = {};
     ["full_name", "phone", "address_line1", "address_line2", "suburb", "state", "postcode"].forEach(k => { data[k] = String(fd.get(k) || "").trim(); });
     const errs = [];
     if (data.phone && !validPhone(data.phone)) errs.push(["phone", "Please enter a valid phone number."]);
     if (data.postcode && !/^[0-9]{4}$/.test(data.postcode)) errs.push(["postcode", "Please enter a 4-digit postcode."]);
     if (errs.length) return applyErrors(form, errs, err);
     applyErrors(form, [], err);
     saving = true; busy(submit, true, "Saving…");
     try { await SB.rpc("save_my_profile", { p: data }); saving = false; busy(submit, false, "", "Save details"); ok.replaceChildren(icon("check"), h("div", null, "Your details are saved.")); ok.hidden = false; }
     catch (e) { saving = false; busy(submit, false, "", "Save details"); showFormAlert(err, "We couldn't save your details", e.message); }
   });
   return form;
 }
 // One order in the "My orders" list: the short version first, the full breakdown on request.
 function orderRow(o) {
   const items = o.items || [], n = items.reduce((a, i) => a + i.qty, 0);
   const early = o.status === "submitted" || o.status === "confirmed";
   const fee = Number(o.shipping_fee) || 0, disc = Number(o.discount) || 0;
   const w = SwamyWeight.orderWeight(items);
   const rows = [h("div", { class: "srow" }, h("span", null, "Items"), h("span", null, fmtMoney(o.subtotal)))];
   if (disc > 0) rows.push(h("div", { class: "srow" }, h("span", null, "Discount"), h("span", null, "−" + fmtMoney(disc))));
   rows.push(h("div", { class: "srow" }, h("span", null, "Delivery"), fee > 0 ? h("span", null, fmtMoney(fee)) : h("span", { class: early ? "tbc" : "" }, early ? "To be confirmed" : "Free")));
   rows.push(h("div", { class: "srow total" }, h("span", null, early && fee === 0 ? "Items total" : "Total"), h("span", null, fmtMoney(o.total))));
   return h("article", { class: "o-row" },
     h("div", { class: "o-top" },
       h("a", { class: "o-ref", href: "track.html?ref=" + encodeURIComponent(o.ref) }, o.ref),
       SwamyUtil.statusTag(o.status)),
     h("p", { class: "o-meta" }, fmtDate(o.created_at) + " · " + n + (n === 1 ? " item" : " items") + " · " + fmtMoney(o.total) + (early && fee === 0 ? " + delivery" : "")),
     h("p", { class: "o-items" }, items.map(i => i.qty + " × " + i.name).join(", ")),
     h("details", { class: "o-details" },
       h("summary", null, "View details"),
       h("div", { class: "o-body" },
         SwamyUtil.timeline(o.status),
         h("ul", { class: "order-items" }, items.map(i => h("li", null, h("span", null, i.name + " (" + i.weight + ")"), h("span", { class: "q" }, "× " + i.qty)))),
         rows,
         w ? h("p", { class: "small" }, "Approximate weight: " + w.text) : null,
         o.invoice_no ? h("p", { class: "small" }, "Invoice number: " + o.invoice_no) : null,
         h("p", { class: "small" }, h("a", { href: "track.html?ref=" + encodeURIComponent(o.ref) }, "Track this order")))));
 }
 async function pageAccount() {
   const root = pageRoot("accountRoot");
   const intro = $("#accountIntro"), title = $("h1");
   const q = new URLSearchParams(location.search);
   const next = safeNext(q.get("next"));
   const say = (h1, p) => { if (title) title.textContent = h1; if (intro) intro.textContent = p; };
   let setMode = null;                  // lets the address (#login / #signup) switch the form on the page

   /* ---- logged out: one form at a time, notes beside it ---- */
   const drawLoggedOut = () => {
     say("Your account", "Log in to see your orders and use your saved delivery details. An account is optional. You can always check out as a guest.");
     const slot = h("div", { class: "seg-panel", role: "tabpanel" });
     const tabBtn = (mode, label) => h("button", { class: "seg-btn", type: "button", role: "tab", id: "tab-" + mode, "data-mode": mode }, label);
     const tabs = h("div", { class: "seg", role: "tablist", "aria-label": "Log in or create an account" }, tabBtn("login", "Log in"), tabBtn("signup", "Create account"));
     let mode = q.get("mode") === "signup" || location.hash === "#signup" ? "signup" : "login";
     const show = (m, focus) => {
       const old = slot.querySelector('input[type="email"]'), typed = old ? old.value : "";
       mode = m;
       tabs.querySelectorAll(".seg-btn").forEach(b => { const on = b.dataset.mode === m; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
       slot.setAttribute("aria-labelledby", "tab-" + m);
       slot.replaceChildren(h("h2", { class: "panel-title" }, m === "login" ? "Welcome back" : "Create your account"),
         h("p", { class: "panel-sub" }, m === "login" ? "Log in to see your orders and save time at checkout." : "It takes a few seconds and makes ordering quicker next time."),
         authForm(m, next));
       const em = slot.querySelector('input[type="email"]'); if (em && typed) em.value = typed;
       try { history.replaceState(null, "", location.pathname + location.search + "#" + m); } catch (e) {}
       if (focus) { const f = slot.querySelector("input"); if (f) f.focus(); }
     };
     tabs.addEventListener("click", e => { const b = e.target.closest(".seg-btn"); if (b) show(b.dataset.mode, true); });
     tabs.addEventListener("keydown", e => {
       const order = ["login", "signup"], i = order.indexOf(mode);
       const to = e.key === "ArrowRight" ? order[(i + 1) % 2] : e.key === "ArrowLeft" ? order[(i + 1) % 2] : e.key === "Home" ? "login" : e.key === "End" ? "signup" : null;
       if (to) { e.preventDefault(); show(to); $("#tab-" + to).focus(); }
     });
     show(mode, false);
     setMode = m => show(m, false);
     root.replaceChildren(h("div", { class: "split acct-split" },
       h("div", { class: "panel" }, tabs, slot),
       h("aside", { class: "aside", "aria-label": "About accounts" },
         h("h2", null, "Why create an account?"),
         h("ul", { class: "ticks" }, h("li", null, "Your delivery details filled in for you at checkout"), h("li", null, "Every order and its progress in one place"), h("li", null, "No marketing emails. Ever.")),
         h("h3", null, "Prefer not to?"),
         h("p", null, "No problem. ", h("a", { href: "index.html#products" }, "Shop as a guest"), " and add your details at checkout."),
         h("h3", null, "Already ordered as a guest?"),
         h("p", null, h("a", { href: "track.html" }, "Track your order"), " with its reference and email. No account needed."))));
     if (q.get("mode") === "signup") { const f = slot.querySelector("input"); if (f) f.focus(); }   // arriving from a "create account" link: cursor in the first field
   };

   /* ---- logged in: orders and delivery details ---- */
   const drawLoggedIn = async user => {
     const tab = location.hash === "#details" ? "details" : "orders";
     const first = String(user.name || "").trim().split(/\s+/)[0];
     say("Your account", first ? "Welcome back, " + first + "." : "Manage your orders and delivery details.");
     const body = h("div", { class: "acct-body" }, loadingRow(tab === "orders" ? "Loading your orders…" : "Loading your details…"));
     root.replaceChildren(h("div", { class: "acct" },
       h("div", { class: "acct-head" },
         h("p", { class: "muted" }, "Signed in as ", h("strong", { style: "color:var(--ink)" }, user.email)),
         h("button", { class: "btn btn-secondary btn-sm", type: "button", id: "logoutBtn", onclick: async () => { await SB.auth.signOut(); location.assign("index.html"); } }, "Log out")),
       h("nav", { class: "tabs-line", "aria-label": "Account sections" },
         h("a", { href: "#orders", "aria-current": tab === "orders" ? "true" : null }, "My orders"),
         h("a", { href: "#details", "aria-current": tab === "details" ? "true" : null }, "Delivery details")),
       body));
     try {
       if (tab === "orders") {
         const list = await SB.rpc("my_orders", {});
         body.replaceChildren(list.length
           ? h("div", null, h("p", { class: "muted small", style: "margin-bottom:16px" }, list.length + (list.length === 1 ? " order" : " orders")), ...list.map(orderRow))
           : h("div", { class: "empty" }, h("strong", null, "No orders yet"), h("p", null, "Orders you place while logged in will show up here."), h("a", { class: "btn", href: "index.html#products" }, "Browse products")));
       } else {
         let p = {}; try { p = await SB.rpc("get_my_profile", {}); } catch (e) {}
         body.replaceChildren(h("div", { class: "panel narrow" }, h("h2", { class: "panel-title" }, "Delivery details"), h("p", { class: "panel-sub" }, "We'll fill these in for you at checkout."), detailsForm(p)));
       }
     } catch (e) { body.replaceChildren(alertBox("error", "We couldn't load this", e.message)); }
   };

   const draw = () => { const u = SB.auth.getUser(); return u ? drawLoggedIn(u) : drawLoggedOut(); };
   await draw();
   global.addEventListener("hashchange", () => {
     const u = SB.auth.getUser();
     if (u) drawLoggedIn(u);
     else if (setMode && (location.hash === "#login" || location.hash === "#signup")) setMode(location.hash.slice(1));
   });
   SB.auth.onChange(sess => { if (!sess) drawLoggedOut(); });
 }

 /* ------------------------------ TRACK (track.html) ------------------------------ */
 function pageTrack() {
   const root = pageRoot("trackRoot");
   const q = new URLSearchParams(location.search);
   const user = SB.auth.getUser();
   const err = formAlert(), out = h("div", { "aria-live": "polite", style: "margin-top:32px" });
   const submit = h("button", { class: "btn", type: "submit" }, "Track order");
   const form = h("form", { novalidate: true, "aria-label": "Track an order" },
     field("Order reference", "ref", { ph: "SF-AB12CD", max: 12, value: (q.get("ref") || "").slice(0, 12), hint: "It starts with SF- and is on your confirmation page and email." }),
     field("Email address", "email", { type: "email", ac: "email", max: 254, value: user ? user.email : "", hint: "The email you used when you ordered." }),
     err, submit);
   let checking = false;
   form.addEventListener("submit", async ev => {
     ev.preventDefault();
     if (checking) return;
     out.replaceChildren();
     const fd = new FormData(form), ref = String(fd.get("ref") || "").trim(), email = String(fd.get("email") || "").trim(), errs = [];
     if (!ref) errs.push(["ref", "Please enter your order reference."]);
     if (!EMAIL_RE.test(email)) errs.push(["email", "Please enter the email you ordered with."]);
     if (errs.length) return applyErrors(form, errs, err);
     applyErrors(form, [], err);
     checking = true; busy(submit, true, "Checking…");
     out.replaceChildren(loadingRow("Looking up your order…"));
     try {
       const o = await SB.rpc("track_order", { p_ref: ref, p_email: email });
       out.replaceChildren(h("h2", { style: "margin-bottom:16px" }, "Order status"), orderCard(o, { timeline: true }));
       out.scrollIntoView({ block: "nearest" });
     } catch (e) { out.replaceChildren(); showFormAlert(err, "We couldn't find that order", e.message + " Check the reference and the email you ordered with."); }
     checking = false; busy(submit, false, "", "Track order");
   });
   root.replaceChildren(h("div", { class: "split" },
     h("div", null, h("div", { class: "panel" }, form), out),
     h("aside", { class: "stack small muted" }, h("h2", { style: "font-size:1.125rem;color:var(--ink)" }, "Where do I find my reference?"),
       h("p", null, "Your order reference was shown on the confirmation page after you ordered and starts with SF-. If you have an account, your orders are listed under ", h("a", { href: "account.html" }, "your account"), "."),
       h("p", null, "Can't find it? Call ", h("a", { href: "tel:" + CONTACT.tel }, CONTACT.phone), " or email ", h("a", { href: "mailto:" + CONTACT.email }, CONTACT.email), "."))));
 }

 /* ------------------------------ THANK YOU (thank-you.html) ------------------------------ */
 function pageThanks() {
   const root = pageRoot("thanksRoot");
   let ref = (new URLSearchParams(location.search).get("ref") || "").toUpperCase();
   if (!/^SF-[A-Z0-9]{6}$/.test(ref)) ref = "";
   let saved = null;
   try { saved = JSON.parse(sessionStorage.getItem(KEYS.lastOrder) || "null"); } catch (e) {}
   const order = saved && saved.order && (!ref || saved.order.ref === ref) ? saved.order : null;
   const email = order && saved.email ? saved.email : "";
   const shown = order ? order.ref : ref;
   if (!shown) {
     root.replaceChildren(h("h1", null, "No recent order found"),
       h("p", { class: "lead", style: "margin-top:12px" }, "We can't see an order on this device. If you've just ordered, check your email, or look it up with your order reference."),
       h("div", { class: "actions" }, h("a", { class: "btn", href: "track.html" }, "Track an order"), h("a", { class: "btn btn-secondary", href: "index.html#products" }, "Back to the shop")));
     return;
   }
   root.replaceChildren(h("div", { class: "done" },
     h("div", { class: "done-mark" }, icon("check")),
     h("h1", { tabindex: "-1" }, "Thank you. We've got your order."),
     h("p", { class: "lead", style: "margin-top:10px" }, "Your order reference"),
     h("div", { class: "done-ref" }, shown),
     order ? orderCard(order) : null,
     h("h2", { style: "font-size:1.25rem;margin-top:32px" }, "What happens next"),
     h("ol", { class: "next" },
       h("li", null, "We check that everything is in stock."),
       h("li", null, email ? "We email your invoice to " + email + " with the final total, delivery and payment details." : "We email you an invoice with the final total, delivery and payment details."),
       h("li", null, "Once payment is arranged, we pack and send your order.")),
     h("p", { class: "muted small" }, "Keep your reference. Questions? Call ", h("a", { href: "tel:" + CONTACT.tel }, CONTACT.phone), " or email ", h("a", { href: "mailto:" + CONTACT.email }, CONTACT.email), "."),
     h("div", { class: "actions" }, h("a", { class: "btn", href: "index.html#products" }, "Back to the shop"), h("a", { class: "btn btn-secondary", href: "track.html?ref=" + encodeURIComponent(shown) }, "Track this order"))));
   document.title = "Order received (" + shown + ") | Swamy Foods";
   const hd = root.querySelector("h1"); if (hd) { hd.style.outline = "none"; hd.focus(); }
 }

 /* ------------------------------ start ------------------------------ */
 const PAGES = { shop: pageShop, cart: pageCart, checkout: pageCheckout, review: pageReview, account: pageAccount, track: pageTrack, thanks: pageThanks };
 function boot() {
   const page = document.body.getAttribute("data-page") || "";
   if (page === "admin" || page === "check") return;
   Chrome.init(page);
   const run = PAGES[page];
   if (!run) return;
   Promise.resolve().then(run).catch(e => {
     console.error("Swamy Foods: this page hit a problem:", e);
     const root = $("main") || document.body;
     root.replaceChildren(h("div", { class: "wrap page" }, alertBox("error", "Something went wrong loading this page.", h("span", null, "Please refresh. If it keeps happening, call ", h("a", { href: "tel:" + CONTACT.tel }, CONTACT.phone), "."))));
   });
 }
 global.SwamyApp = { Catalog, Cart, boot };
 if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(window);
 