(function () {
function initPlugin($ui, ctx) {
const BRAND_ICON = "https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png";
const PROVIDER_MANIFEST_URL =
"https://raw.githubusercontent.com/SKRAPT/PT-Scans-Search/main/PT-Scans-Search.json"; // manifest com payloadURI actualizado

// AniList PIN flow config
const ANILIST_CLIENT_ID = ""; // optional
const ANILIST_CLIENT_SECRET = ""; // optional
const ANILIST_REDIRECT_URI = "https://anilist.co/api/v2/oauth/pin";
const ANILIST_AUTH_URL = "https://anilist.co/api/v2/oauth/authorize";
const ANILIST_TOKEN_URL = "https://anilist.co/api/v2/oauth/token";
const ANILIST_GRAPHQL = "https://graphql.anilist.co";

const tray = ctx.newTray({
tooltipText: "PT Scans Search",
iconUrl: BRAND_ICON,
withContent: false
});

const panel = ctx.newWebview({
slot: "fixed",
width: "100%",
maxWidth: "1280px",
height: "86vh",
hidden: true,
zIndex: 60,
window: {
draggable: true,
defaultPosition: "bottom-right",
frameless: true
}
});

const queryState = ctx.state("");
const loading = ctx.state(false);
const status = ctx.state("Pronto");
const results = ctx.state([]);

panel.channel.sync("results", results);
panel.channel.sync("status", status);
panel.channel.sync("loading", loading);
panel.channel.sync("query", queryState);

let providerPromise = null;

// utilitários
function normalizeText(value) {
return typeof value === "string" ? value.trim() : "";
}
function splitSourceId(value) {
const raw = normalizeText(value);
const idx = raw.indexOf(":");
if (idx === -1) return { source: "", id: raw };
return { source: raw.slice(0, idx), id: raw.slice(idx + 1) };
}
function sourceLabel(source) {
if (source === "mangaflix") return "MangaFlix";
if (source === "mangalivre") return "MangaLivre";
if (source === "hipercool") return "HiperCool";
if (source === "tiamanhwa") return "TiaManhwa";
if (source === "mangafire") return "MangaFire";
return source || "Desconhecido";
}
function stripProviderPrefix(title) {
return String(title || "")
.replace(/^\s*
(
M
a
n
g
a
F
l
i
x
∣
M
a
n
g
a
L
i
v
r
e
∣
H
i
p
e
r
C
o
o
l
∣
T
i
a
M
a
n
h
w
a
∣
M
a
n
g
a
F
i
r
e
)
(MangaFlix∣MangaLivre∣HiperCool∣TiaManhwa∣MangaFire)\s*/i, "")
.replace(/^\s*(MangaFlix|MangaLivre|HiperCool|TiaManhwa|MangaFire)\s*[- -:]\s*/i, "")
.trim();
}
function safeArray(value) {
return Array.isArray(value) ? value : [];
}

// AniList token em memória
function _saveAnilistTokenMemory(tokenObj) {
ctx._anilistToken = tokenObj;
}
function _loadAnilistTokenMemory() {
return ctx._anilistToken || null;
}
function _clearAnilistTokenMemory() {
ctx._anilistToken = null;
}

function buildAnilistPinUrl() {
const params = new URLSearchParams({
client_id: ANILIST_CLIENT_ID || "",
redirect_uri: ANILIST_REDIRECT_URI,
response_type: "code"
});
return ${ANILIST_AUTH_URL}?${params.toString()};
}

async function exchangePinForToken(pin) {
const body = new URLSearchParams({
grant_type: "authorization_code",
client_id: ANILIST_CLIENT_ID || "",
client_secret: ANILIST_CLIENT_SECRET || "",
redirect_uri: ANILIST_REDIRECT_URI,
code: pin
});
const res = await fetch(ANILIST_TOKEN_URL, {
method: "POST",
headers: { "Content-Type": "application/x-www-form-urlencoded" },
body: body.toString()
});
if (!res.ok) {
const t = await res.text();
throw new Error("Falha ao trocar PIN por token: " + res.status + " " + t);
}
const json = await res.json();
const now = Date.now();
const tokenObj = {
access_token: json.access_token,
expires_at: json.expires_in ? now + json.expires_in * 1000 : null,
obtained_at: now,
raw: json
};
_saveAnilistTokenMemory(tokenObj);
return tokenObj;
}

async function anilistGraphQL(query, variables = {}, token) {
const headers = { "Content-Type": "application/json", Accept: "application/json" };
if (token && token.access_token) headers["Authorization"] = "Bearer " + token.access_token;
const res = await fetch(ANILIST_GRAPHQL, {
method: "POST",
headers,
body: JSON.stringify({ query, variables })
});
if (!res.ok) {
const t = await res.text();
throw new Error("AniList GraphQL erro: " + res.status + " " + t);
}
return await res.json();
}

async function fetchViewerAndCollection(token, mediaType = "MANGA") {
const viewerQ = query { Viewer { id name } };
const viewerRes = await anilistGraphQL(viewerQ, {}, token);
const viewer = viewerRes && viewerRes.data && viewerRes.data.Viewer ? viewerRes.data.Viewer : null;
if (!viewer) return null;

const q = `
query ($userId: Int, $type: MediaType) {
MediaListCollection(userId: $userId, type: $type) {
lists {
name
entries {
id status score progress progressVolumes updatedAt
media {
id title { romaji english native } synonyms description coverImage { large medium } startDate { year } siteUrl
}
}
}
}
}
`;
const res = await anilistGraphQL(q, { userId: viewer.id, type: mediaType }, token);
const collection = res && res.data && res.data.MediaListCollection ? res.data.MediaListCollection : null;
return { viewer, collection };
}

// getProvider com validação segura do payload
async function getProvider() {
if (providerPromise) return providerPromise;

providerPromise = (async () => {
const res = await fetch(PROVIDER_MANIFEST_URL, {
headers: { Accept: "application/json, text/plain, /" }
});

if (!res.ok) {
throw new Error("Falha ao carregar provider manifest: HTTP " + res.status);
}

const manifest = await res.json();
const payload = String(manifest && manifest.payload ? manifest.payload : "").trim();

if (!payload) {
throw new Error("Provider sem payload. Verifica payloadURI no manifest e a disponibilidade do ficheiro.");
}

// validação heurística
function looksBroken(s) {
const backticks = (s.match(/`/g) || []).length;
const single = (s.match(/'/g) || []).length;
const double = (s.match(/"/g) || []).length;
if (backticks % 2 !== 0 || single % 2 !== 0 || double % 2 !== 0) return true;
if (!/function\s+Provider|class\s+Provider/.test(s)) return true;
return false;
}

const preview = payload.slice(0, 2000);
console.log("PT-Scans: provider payload preview:", preview);

if (looksBroken(payload)) {
console.error("PT-Scans: payload parece inválido/truncado; abortando avaliação. Preview:", preview);
throw new Error("Payload do provider inválido ou incompleto. Verifica payloadURI e o conteúdo remoto.");
}

try {
const ProviderClassFactory = new Function(payload + "\nreturn Provider;");
const provider = ProviderClassFactory();
provider.getDisableNsfwConfig = () => false;

// expõe AniList helpers no provider
provider.anilist = {
startPinAuth: async () => {
const url = buildAnilistPinUrl();
panel.channel.send("openExternalUrl", url);
},
submitPin: async (pin) => {
const token = await exchangePinForToken(String(pin).trim());
try {
const lib = await fetchViewerAndCollection(token, "MANGA");
panel.channel.send("anilistAuthState", !!lib);
panel.channel.send("anilistLibrary", lib || null);
} catch (e) {
panel.channel.send("anilistAuthState", true);
panel.channel.send("anilistLibrary", null);
}
return token;
},
logout: async () => {
_clearAnilistTokenMemory();
panel.channel.send("anilistAuthState", false);
panel.channel.send("anilistLibrary", null);
},
getUserLibrary: async (mediaType = "MANGA") => {
const token = _loadAnilistTokenMemory();
if (!token) return null;
try {
return await fetchViewerAndCollection(token, mediaType);
} catch (e) {
console.error("Erro getUserLibrary:", e);
return null;
}
}
};

return provider;
} catch (err) {
console.error("PT-Scans: Erro ao avaliar provider payload:", err && err.toString ? err.toString() : String(err));
try { console.error("PT-Scans: payload (first 5000 chars):", payload.slice(0,5000)); } catch(e){}
throw err;
}
})();

return providerPromise;
}

// library matching
let userLibraryMap = new Map();

function tryMatchLibraryForItem(item) {
const rawId = String(item.id || "");
const idx = rawId.indexOf(":");
const idPart = idx !== -1 ? rawId.slice(idx + 1) : rawId;
const byIdKey = ani:${idPart};
if (userLibraryMap.has(byIdKey)) return userLibraryMap.get(byIdKey);
const t = (stripProviderPrefix(item.title || "") || "").toLowerCase();
if (userLibraryMap.has(title:${t})) return userLibraryMap.get(title:${t});
for (const [k, v] of userLibraryMap.entries()) {
if (k.startsWith("title:") && k.includes(t) && t.length > 3) return v;
}
return null;
}

async function enrichWithChapters(provider, items) {
const limited = items.slice(0, 24);

const detailed = await Promise.allSettled(
limited.map(async (item) => {
let chapters = [];
try {
chapters = safeArray(await provider.findChapters(item.id));
} catch (e) {}

const src = splitSourceId(item.id).source;

const base = {
id: item.id,
source: sourceLabel(src),
rawSource: src,
title: stripProviderPrefix(item.title || ""),
originalTitle: item.title || "",
image: item.image || "",
year: item.year || null,
synonyms: safeArray(item.synonyms),
hasChapters: chapters.length > 0,
chapterCount: chapters.length,
latestChapter: chapters.length ? (chapters[chapters.length - 1].chapter || null) : null
};

try {
const match = tryMatchLibraryForItem(item);
if (match) {
base.ani = {
mediaId: match.mediaId,
progress: match.progress,
progressVolumes: match.progressVolumes,
cover: match.cover,
url: match.siteUrl,
rawMedia: match.rawMedia
};
}
} catch (e) {}

return base;
})
);

const ok = detailed
.filter((entry) => entry.status === "fulfilled")
.map((entry) => entry.value);

if (items.length > limited.length) {
const rest = items.slice(limited.length).map((item) => {
const src = splitSourceId(item.id).source;
return {
id: item.id,
source: sourceLabel(src),
rawSource: src,
title: stripProviderPrefix(item.title || ""),
originalTitle: item.title || "",
image: item.image || "",
year: item.year || null,
synonyms: safeArray(item.synonyms),
hasChapters: false,
chapterCount: 0,
latestChapter: null
};
});
return ok.concat(rest);
}

return ok;
}

async function runSearch(rawQuery) {
const query = normalizeText(rawQuery);
queryState.set(query);

if (!query) {
status.set("Escreve um título.");
results.set([]);
tray.updateBadge({ number: 0 });
return;
}

loading.set(true);
status.set("A carregar...");
results.set([]);

try {
const provider = await getProvider();

// load user library for matching
userLibraryMap = new Map();
try {
const token = _loadAnilistTokenMemory();
if (token) {
const lib = await provider.anilist.getUserLibrary("MANGA");
if (lib && lib.collection && Array.isArray(lib.collection.lists)) {
lib.collection.lists.forEach((list) => {
(list.entries || []).forEach((entry) => {
if (entry.status === "CURRENT") {
const media = entry.media;
const keyById = ani:${media.id};
userLibraryMap.set(keyById, {
mediaId: media.id,
title: media.title && (media.title.romaji || media.title.english || media.title.native),
progress: entry.progress,
progressVolumes: entry.progressVolumes,
siteUrl: media.siteUrl,
cover: media.coverImage && (media.coverImage.large || media.coverImage.medium),
rawMedia: media
});
const titles = [media.title.romaji, media.title.english, media.title.native].filter(Boolean);
(media.synonyms || []).forEach(s => titles.push(s));
titles.forEach(t => {
if (!t) return;
userLibraryMap.set(title:${t.toLowerCase()}, {
mediaId: media.id,
title: media.title && (media.title.romaji || media.title.english || media.title.native),
progress: entry.progress,
progressVolumes: entry.progressVolumes,
siteUrl: media.siteUrl,
cover: media.coverImage && (media.coverImage.large || media.coverImage.medium),
rawMedia: media
});
});
}
});
});
}
panel.channel.send("anilistLibrary", lib || null);
panel.channel.send("anilistAuthState", !!lib);
} else {
panel.channel.send("anilistLibrary", null);
panel.channel.send("anilistAuthState", false);
}
} catch (e) {
console.warn("AniList library load falhou:", e);
panel.channel.send("anilistLibrary", null);
panel.channel.send("anilistAuthState", false);
}

status.set("A pesquisar...");
let found = safeArray(await provider.search({ query }));
found = found.slice(0, 40);

status.set("A obter capítulos...");
const enriched = await enrichWithChapters(provider, found);

results.set(enriched);

const withCaps = enriched.filter((item) => item.hasChapters).length;
tray.updateBadge({
number: enriched.length,
intent: withCaps > 0 ? "info" : "warning"
});

status.set(enriched.length ? "Concluído" : "Sem resultados");
} catch (e) {
console.error("Erro no plugin:", e);
status.set("Erro: " + (e && e.message ? e.message : "falha desconhecida"));
results.set([]);
tray.updateBadge({ number: 0 });
} finally {
loading.set(false);
}
}

// UI / canais
tray.onClick(() => panel.show());

panel.channel.on("search", async (query) => {
await runSearch(query || "");
});
panel.channel.on("hide", () => panel.hide());
panel.channel.on("clear", () => {
queryState.set("");
status.set("Pronto");
loading.set(false);
results.set([]);
tray.updateBadge({ number: 0 });
});
panel.channel.on("reloadProvider", async () => {
providerPromise = null;
status.set("Cache limpa");
});

panel.channel.on("anilistStartPin", async () => {
try {
const provider = await getProvider();
await provider.anilist.startPinAuth();
panel.channel.send("showPastePin", true);
} catch (e) {
console.error("Erro iniciar PIN AniList:", e);
}
});
panel.channel.on("anilistSubmitPin", async (pin) => {
try {
const provider = await getProvider();
const token = await provider.anilist.submitPin(pin);
if (token) {
panel.channel.send("anilistAuthState", true);
const lib = await provider.anilist.getUserLibrary("MANGA");
panel.channel.send("anilistLibrary", lib || null);
} else {
panel.channel.send("anilistAuthState", false);
panel.channel.send("anilistLibrary", null);
}
} catch (e) {
console.error("Erro ao submeter PIN:", e);
panel.channel.send("anilistAuthState", false);
panel.channel.send("anilistLibrary", null);
panel.channel.send("anilistError", String(e && e.message ? e.message : e));
}
});
panel.channel.on("anilistLogout", async () => {
try {
const provider = await getProvider();
await provider.anilist.logout();
panel.channel.send("anilistAuthState", false);
panel.channel.send("anilistLibrary", null);
} catch (e) {
console.error("Erro logout AniList:", e);
}
});
panel.channel.on("anilistSyncToggle", async (enabled) => {
try {
const provider = await getProvider();
if (enabled) {
const lib = await provider.anilist.getUserLibrary("MANGA");
panel.channel.send("anilistLibrary", lib || null);
} else {
panel.channel.send("anilistLibrary", null);
}
} catch (e) {
console.error("Erro anilistSyncToggle:", e);
}
});

// webview content: injeta BRAND_ICON com JSON.stringify para segurança
const brandIconEscaped = JSON.stringify(BRAND_ICON);

panel.setContent(() => `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
/* mantém o teu CSS original aqui — copia exatamente o bloco CSS que usavas */
:root{--line:rgba(255,255,255,.09);--text:#edf4ff;--muted:#98a9c7;--blue:#5ea2ff;--purple:#9b7cff;--shadow:0 18px 50px rgba(0,0,0,.38)}
html{color-scheme:dark;overflow:hidden}*{box-sizing:border-box}body{margin:0;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:transparent;overflow:hidden}
/* ... restante CSS omitido por brevidade — usa exactamente o teu bloco CSS original aqui ... */
</style>
</head>
<body>
<div class="overlay">
<div class="blob"></div>
<div class="window">
<div class="shine"></div>
<div class="topbar">
<div class="brand">
<div class="brand-logo-wrap">
<img class="brand-logo" src=${brandIconEscaped} alt="PT Scans" />
</div>
<div class="brand-copy"><div class="brand-title">PT Scans Search</div></div>
</div>
<div class="searchbar">
<div class="search-shell"><input id="query" placeholder="Pesquisar..." /></div>
<button id="searchBtn" class="btn btn-primary">Pesquisar</button>
<button id="reloadBtn" class="btn">Reload</button>
<button id="clearBtn" class="btn">Limpar</button>
<button id="closeBtn" class="btn">Fechar</button>
<button id="anilistPinBtn" class="btn">Login AniList (PIN)</button>
<button id="anilistPastePinBtn" class="btn" style="display:none">Colar PIN</button>
<button id="anilistLogoutBtn" class="btn" style="display:none">Logout AniList</button>
<label id="anilistSyncWrap" class="pill" style="margin-left:8px">
<input id="anilistSyncToggle" type="checkbox" style="margin-right:8px" /> Sincronizar
</label>
</div>
</div>
<div class="meta">
<div class="status-wrap"><div class="status-dot"></div><div id="statusText">Pronto</div></div>
<div class="pill" id="resultMeta">0 resultados</div>
</div>
<div class="filters" id="sourceFilters"></div>
<div class="content"><div id="app"></div></div>
</div>
</div>

<script>
const BRAND_ICON = ${brandIconEscaped};
const state = { results:[], status:"Pronto", loading:false, query:"", sourceFilter:"all", anilistLibrary:null, anilistLoggedIn:false };

function esc(value){
return String(value==null?"":value)
.replace(/&/g,"&amp;")
.replace(/</g,"&lt;")
.replace(/>/g,"&gt;")
.replace(/"/g,"&quot;")
.replace(/'/g,"&#039;");
}

function renderSkeletons(){ return '<div class="loading-grid">'+Array.from({length:6}).map(()=>'<div class="skeleton"></div>').join('')+'</div>'; }

function getItemSource(item){
if(item.rawSource) return item.rawSource;
const rawId = String(item.id||"");
const idx = rawId.indexOf(":");
return idx !== -1 ? rawId.slice(0, idx) : "unknown";
}

function buildSourceCounts(items){
const counts = { all: items.length, mangaflix:0, mangalivre:0, hipercool:0, tiamanhwa:0, mangafire:0 };
items.forEach(item => { const s = getItemSource(item); if(counts[s]!=null) counts[s]++; });
return counts;
}

function renderFilters(items){
const wrap = document.getElementById("sourceFilters"); if(!wrap) return;
const counts = buildSourceCounts(items);
const defs = [{key:"all",label:"Todos"},{key:"mangaflix",label:"MangaFlix"},{key:"mangalivre",label:"MangaLivre"},{key:"hipercool",label:"HiperCool"},{key:"tiamanhwa",label:"TiaManhwa"},{key:"mangafire",label:"MangaFire"}];
wrap.innerHTML = defs.map(item=>{ const active = state.sourceFilter===item.key?"active":""; const count = counts[item.key]||0; return <button class="filter-chip ${active}" data-source="${esc(item.key)}" type="button">${esc(item.label)} (${count})</button> }).join("");
wrap.querySelectorAll(".filter-chip").forEach(btn=>btn.addEventListener("click",()=>{ state.sourceFilter = btn.dataset.source||"all"; render(); }));
}

function renderLibrary(){
if(!state.anilistLibrary||!state.anilistLibrary.collection||!Array.isArray(state.anilistLibrary.collection.lists)) return "";
const currentEntries = [];
state.anilistLibrary.collection.lists.forEach(l => { (l.entries||[]).forEach(e=>{ if(e.status==="CURRENT") currentEntries.push({entry:e, listName:l.name}); }); });
if(!currentEntries.length) return "";
return '<div style="margin-bottom:18px"><div style="font-weight:800;font-size:15px;margin-bottom:8px;color:#dbe7ff">Minha Biblioteca</div><div class="grid">'+currentEntries.map(obj=>{ const e = obj.entry; const lName = obj.listName||""; const media = e.media||{}; const cover = media.coverImage&&media.coverImage.large?<img class="cover" src="${esc(media.coverImage.large)}" />:'<div class="fallback">Sem capa</div>'; return <div class="card">${cover}<div class="info"><div><div class="title">${esc(media.title && (media.title.romaji||media.title.english||media.title.native) || "—")}</div><div class="stats"><div class="chip source">A acompanhar</div><div class="chip ok">Progresso: ${esc(e.progress||0)}</div><div class="chip">Lista: ${esc(lName||"-")}</div></div></div><div class="sub"><a href="${esc(media.siteUrl||"#")}" target="_blank" rel="noopener noreferrer" style="color:#9db1d3">Ver no AniList</a></div></div></div> }).join("") + '</div></div>';
}

function render(){
const app = document.getElementById("app");
const statusText = document.getElementById("statusText");
const resultMeta = document.getElementById("resultMeta");
const input = document.getElementById("query");
statusText.textContent = state.status || "Pronto";
if(document.activeElement !== input) input.value = state.query || "";
const allResults = Array.isArray(state.results)?state.results:[];
const filteredResults = state.sourceFilter==="all"?allResults:allResults.filter(item=>getItemSource(item)===state.sourceFilter);
resultMeta.textContent = filteredResults.length + " resultados";
renderFilters(allResults);
if(state.loading && allResults.length===0){ app.innerHTML = renderSkeletons(); return; }
const libraryHtml = renderLibrary();
if(filteredResults.length===0 && !libraryHtml){
app.innerHTML = ['<div class="empty">','<div class="empty-box">','<img class="empty-logo" src="'+esc(BRAND_ICON)+'" alt="PT Scans" />','<div style="font-size:18px;font-weight:800;color:#f4f8ff;margin-bottom:8px;">PT Scans</div>','<div style="font-size:13px;line-height:1.6;color:#9db1d3;">'+(allResults.length===0?'Pesquisa um título para começar.':'Não há resultados para este filtro.')+'</div>','</div>','</div>'].join("");
return;
} const resultsHtml = filteredResults.length?('<div class="grid">'+filteredResults.map(item=>{ const cover = item.image?<img class="cover" src="${esc(item.image)}" alt="${esc(item.title)}" />:'<div class="fallback">Sem capa</div>'; const aniChip = item.ani?('<div class="chip ok">Progresso AniList: '+esc(item.ani.progress||0)+'</div>'):''; return <div class="card">${cover}<div class="info"><div><div class="title">${esc(item.title)}</div><div class="stats"><div class="chip source">${esc(item.source||getItemSource(item))}</div><div class="chip ${item.hasChapters?'ok':'no'}">Capítulos: ${item.hasChapters?'Sim':'Não'}</div><div class="chip">Total: ${esc(item.chapterCount)}</div><div class="chip">Último: ${esc(item.latestChapter||"-")}</div>${item.year?('<div class="chip">Ano: '+esc(item.year)+'</div>'):''}${aniChip}</div></div><div class="sub">${esc(item.id||"")}</div></div></div> }).join("")+'</div>'):"";
app.innerHTML = (libraryHtml?libraryHtml:"") + resultsHtml;
}

document.getElementById("searchBtn").addEventListener("click",()=>{ window.webview.send("search", document.getElementById("query").value); });
document.getElementById("query").addEventListener("keydown",(e)=>{ if(e.key==="Enter") window.webview.send("search", document.getElementById("query").value); });
document.getElementById("clearBtn").addEventListener("click",()=>{ document.getElementById("query").value=""; state.sourceFilter="all"; window.webview.send("clear"); });
document.getElementById("closeBtn").addEventListener("click",()=>{ window.webview.send("hide"); });
document.getElementById("reloadBtn").addEventListener("click",()=>{ window.webview.send("reloadProvider"); });
document.getElementById("anilistPinBtn").addEventListener("click",()=>{ window.webview.send("anilistStartPin"); document.getElementById("anilistPastePinBtn").style.display=""; });
document.getElementById("anilistPastePinBtn").addEventListener("click",async ()=>{ const pin = prompt("Colar PIN de autorização AniList:"); if(pin) window.webview.send("anilistSubmitPin",pin); });
document.getElementById("anilistLogoutBtn").addEventListener("click",()=>{ window.webview.send("anilistLogout"); });
document.getElementById("anilistSyncToggle").addEventListener("change",(e)=>{ window.webview.send("anilistSyncToggle",!!e.target.checked); });

window.webview.on("results",(value)=>{ state.results = value||[]; render(); });
window.webview.on("status",(value)=>{ state.status = value||"Pronto"; render(); });
window.webview.on("loading",(value)=>{ state.loading = !!value; render(); });
window.webview.on("query",(value)=>{ state.query = value||""; render(); });
window.webview.on("anilistLibrary",(value)=>{ state.anilistLibrary = value||null; render(); });
window.webview.on("anilistAuthState",(isLoggedIn)=>{ state.anilistLoggedIn = !!isLoggedIn; document.getElementById("anilistPinBtn").style.display = state.anilistLoggedIn ? "none": ""; document.getElementById("anilistPastePinBtn").style.display = state.anilistLoggedIn ? "none": ""; document.getElementById("anilistLogoutBtn").style.display = state.anilistLoggedIn ? "":"none"; });
window.webview.on("anilistError",(msg)=>{ alert("Erro AniList: "+String(msg||"")); });
window.webview.on("showPastePin",(v)=>{ document.getElementById("anilistPastePinBtn").style.display = v? "":"none"; });

render();
</script>
</body>
</html>`); // end setContent

} // end initPlugin

// Register with host API (assume $ui global exists)
try {
if (typeof $ui !== "undefined" && $ui && $ui.register) {
$ui.register((ctx) => { initPlugin($ui, ctx); });
} else if (typeof module !== "undefined" && module.exports) {
// fallback for testing
module.exports = { initPlugin };
} else {
// try to call if host exposes global ctx
if (typeof init === "function") init();
}
} catch (e) {
console.error("PT-Scans: failed to register plugin:", e);
} })();
