function init() {
  $ui.register((ctx) => {
    const BRAND_ICON = "https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png";
    const PROVIDER_MANIFEST_URL =
      "https://raw.githubusercontent.com/SKRAPT/PT-Scans/refs/heads/main/ptscans-provider.json";

    const HISTORY_KEY   = "ptscans_search_history";
    const FAVORITES_KEY = "ptscans_favorites";
    const CACHE_KEY     = "ptscans_search_cache";
    const STATS_KEY     = "ptscans_stats";
    const MAX_HISTORY   = 20;

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
      window: { draggable: true, defaultPosition: "bottom-right", frameless: true }
    });

    const queryState     = ctx.state("");
    const loading        = ctx.state(false);
    const status         = ctx.state("Pronto");
    const results        = ctx.state([]);
    const historyState   = ctx.state([]);
    const favoritesState = ctx.state([]);
    const statsState     = ctx.state({ searches: 0, opens: 0, favorites: 0 });

    panel.channel.sync("results",   results);
    panel.channel.sync("status",    status);
    panel.channel.sync("loading",   loading);
    panel.channel.sync("query",     queryState);
    panel.channel.sync("history",   historyState);
    panel.channel.sync("favorites", favoritesState);
    panel.channel.sync("stats", statsState);

    function lsGet(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    }
    function lsSet(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }

    function loadStats() { statsState.set(lsGet(STATS_KEY, { searches: 0, opens: 0, favorites: 0 })); }
    function saveStats(v) { lsSet(STATS_KEY, v); statsState.set(v); }
    function incStat(key, delta = 1) {
      const s = Object.assign({ searches: 0, opens: 0, favorites: 0 }, lsGet(STATS_KEY, { searches: 0, opens: 0, favorites: 0 }));
      s[key] = (s[key] || 0) + delta;
      saveStats(s);
    }
    function cacheGet(query) {
      const cache = lsGet(CACHE_KEY, {});
      const hit = cache[query];
      if (!hit) return null;
      if (Date.now() - hit.ts > 60 * 60 * 1000) return null;
      return hit.results || null;
    }
    function cacheSet(query, results) {
      const cache = lsGet(CACHE_KEY, {});
      cache[query] = { ts: Date.now(), results };
      lsSet(CACHE_KEY, cache);
    }

    function loadHistory()  { historyState.set((lsGet(HISTORY_KEY, []) || []).slice()); }
    function addToHistory(query) {
      if (!query) return;
      const current = lsGet(HISTORY_KEY, []);
      let hist = Array.isArray(current) ? current.slice() : [];
      hist = hist.filter(q => q !== query);
      hist.unshift(query);
      if (hist.length > MAX_HISTORY) hist = hist.slice(0, MAX_HISTORY);
      lsSet(HISTORY_KEY, hist);
      historyState.set(hist.slice());
    }
        function removeFromHistory(query) {
      const hist = lsGet(HISTORY_KEY, []).filter(q => q !== query);
      lsSet(HISTORY_KEY, hist);
      historyState.set(hist);
    }
    function clearHistory() {
      lsSet(HISTORY_KEY, []);
      historyState.set([]);
    }

    function loadFavorites() { favoritesState.set(lsGet(FAVORITES_KEY, [])); }
    function toggleFavorite(item) {
      let favs = lsGet(FAVORITES_KEY, []);
      const idx = favs.findIndex(f => f.id === item.id);
      if (idx === -1) {
        favs.unshift({ id: item.id, title: item.title, image: item.image,
          source: item.source, year: item.year || null, addedAt: Date.now() });
      } else { favs.splice(idx, 1); }
      lsSet(FAVORITES_KEY, favs);
      favoritesState.set(favs);
      saveStats(Object.assign({ searches: 0, opens: 0, favorites: 0 }, lsGet(STATS_KEY, { searches: 0, opens: 0, favorites: 0 }), { favorites: favs.length }));
    }
    function removeFavorite(id) {
      const favs = lsGet(FAVORITES_KEY, []).filter(f => f.id !== id);
      lsSet(FAVORITES_KEY, favs);
      favoritesState.set(favs);
      saveStats(Object.assign({ searches: 0, opens: 0, favorites: 0 }, lsGet(STATS_KEY, { searches: 0, opens: 0, favorites: 0 }), { favorites: favs.length }));
    }
    function isFavorite(id) {
      return lsGet(FAVORITES_KEY, []).some(f => f.id === id);
    }

    let providerPromise = null;

    function normalizeText(v)  { return typeof v === "string" ? v.trim() : ""; }
    function splitSourceId(v) {
      const raw = normalizeText(v); const idx = raw.indexOf(":");
      return idx === -1 ? { source: "", id: raw } : { source: raw.slice(0, idx), id: raw.slice(idx + 1) };
    }
    function sourceLabel(s) {
      return s === "mangaflix" ? "MangaFlix" : s === "mangalivre" ? "MangaLivre" :
             s === "hipercool" ? "HiperCool" : s === "tiamanhwa"  ? "TiaManhwa"  :
             s === "mangafire" ? "MangaFire" : s || "Desconhecido";
    }
    function stripProviderPrefix(title) {
      return String(title || "")
        .replace(/^\s*\[(MangaFlix|MangaLivre|HiperCool|TiaManhwa|MangaFire)\]\s*/i, "")
        .replace(/^\s*(MangaFlix|MangaLivre|HiperCool|TiaManhwa|MangaFire)\s*[•\-:]\s*/i, "")
        .trim();
    }
    function safeArray(v) { return Array.isArray(v) ? v : []; }

    async function getProvider() {
      if (providerPromise) return providerPromise;
      providerPromise = (async () => {
        const res = await fetch(PROVIDER_MANIFEST_URL, { headers: { Accept: "application/json, text/plain, */*" } });
        if (!res.ok) throw new Error("Falha ao carregar provider: HTTP " + res.status);
        const manifest = await res.json();
        const payload = String(manifest && manifest.payload ? manifest.payload : "").trim();
        if (!payload) throw new Error("Provider sem payload.");
        const ProviderClass = new Function(payload + "\nreturn Provider;")();
        const provider = new ProviderClass();
        provider.getDisableNsfwConfig = () => false;
        return provider;
      })();
      return providerPromise;
    }
        async function enrichWithChapters(provider, items) {
      const limited = items.slice(0, 24);
      const detailed = await Promise.allSettled(
        limited.map(async (item) => {
          let chapters = [];
          try { chapters = safeArray(await provider.findChapters(item.id)); } catch {}
          const src = splitSourceId(item.id).source;
          return {
            id: item.id, source: sourceLabel(src), rawSource: src,
            title: stripProviderPrefix(item.title || ""), originalTitle: item.title || "",
            image: item.image || "", year: item.year || null,
            synonyms: safeArray(item.synonyms),
            hasChapters: chapters.length > 0, chapterCount: chapters.length,
            latestChapter: chapters.length ? (chapters[chapters.length - 1].chapter || null) : null,
            isFavorite: isFavorite(item.id)
          };
        })
      );
      const ok = detailed.filter(e => e.status === "fulfilled").map(e => e.value);
      if (items.length > limited.length) {
        const rest = items.slice(limited.length).map(item => {
          const src = splitSourceId(item.id).source;
          return { id: item.id, source: sourceLabel(src), rawSource: src,
            title: stripProviderPrefix(item.title || ""), originalTitle: item.title || "",
            image: item.image || "", year: item.year || null, synonyms: safeArray(item.synonyms),
            hasChapters: false, chapterCount: 0, latestChapter: null, isFavorite: isFavorite(item.id) };
        });
        return ok.concat(rest);
      }
      return ok;
    }

    async function runSearch(rawQuery) {
      const query = normalizeText(rawQuery);
      queryState.set(query);
      if (!query) { status.set("Escreve um título."); results.set([]); tray.updateBadge({ number: 0 }); return; }
      loading.set(true); status.set("A carregar..."); results.set([]);
      try {
        const provider = await getProvider();
        const cached = cacheGet(query);
        if (cached) {
          results.set(cached);
          tray.updateBadge({ number: cached.length, intent: cached.some(i => i.hasChapters) ? "info" : "warning" });
          status.set("Cache usado");
          addToHistory(query);
          incStat("searches", 1);
          return;
        }
        status.set("A pesquisar...");
        let found = safeArray(await provider.search({ query }));
        found = found.slice(0, 40);
        status.set("A obter capítulos...");
        const enriched = await enrichWithChapters(provider, found);
        results.set(enriched);
        const withCaps = enriched.filter(i => i.hasChapters).length;
        tray.updateBadge({ number: enriched.length, intent: withCaps > 0 ? "info" : "warning" });
        status.set(enriched.length ? "Concluído" : "Sem resultados");
        addToHistory(query);
        cacheSet(query, enriched);
        incStat("searches", 1);
      } catch (e) {
        console.error("Erro no plugin:", e);
        status.set("Erro: " + (e && e.message ? e.message : "falha desconhecida"));
        results.set([]); tray.updateBadge({ number: 0 });
      } finally { loading.set(false); }
    }

    loadHistory();
    loadFavorites();
    loadStats();
        tray.onClick(() => { panel.show(); });
    panel.channel.on("search",         async (q) => { await runSearch(q || ""); });
    panel.channel.on("hide",           () => { panel.hide(); });
    panel.channel.on("clear",          () => { queryState.set(""); status.set("Pronto"); loading.set(false); results.set([]); tray.updateBadge({ number: 0 }); });
    panel.channel.on("reloadProvider", async () => { providerPromise = null; status.set("Cache limpa"); });
    panel.channel.on("removeHistory",  (q)    => { removeFromHistory(q); });
    panel.channel.on("clearHistory",   ()     => { clearHistory(); });
    panel.channel.on("toggleFavorite", (item) => { toggleFavorite(item); });
    panel.channel.on("removeFavorite", (id)   => { removeFavorite(id); });

    panel.setContent(() => `
<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<style>
html{color-scheme:dark;overflow:hidden}
:root{--line:rgba(255,255,255,.09);--text:#edf4ff;--muted:#98a9c7;--blue:#5ea2ff;--shadow:0 18px 50px rgba(0,0,0,.38)}
*{box-sizing:border-box}
body{margin:0;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:transparent;overflow:hidden}
.overlay{position:relative;width:100%;height:100vh;padding:18px;overflow:hidden;background:radial-gradient(circle at 12% 12%,rgba(94,162,255,.20),transparent 24%),radial-gradient(circle at 86% 14%,rgba(155,124,255,.18),transparent 24%),rgba(2,6,18,.42);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%)}
.window{position:relative;width:100%;height:calc(86vh - 6px);border-radius:28px;overflow:hidden;background:linear-gradient(180deg,rgba(14,20,36,.84),rgba(8,12,23,.78));border:1px solid rgba(255,255,255,.11);box-shadow:var(--shadow);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}
.topbar,.meta,.tabs,.filters{display:flex;gap:10px}
.topbar{align-items:center;padding:18px 20px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:14px;min-width:220px}
.brand-logo{width:34px;height:34px;object-fit:contain}
.brand-title{font-size:17px;font-weight:800}
.searchbar{flex:1;display:flex;gap:10px;align-items:center}
.searchbar input{width:100%;height:50px;border-radius:16px;border:1px solid rgba(255,255,255,.09);background:rgba(6,10,19,.42);color:#fff;padding:0 16px 0 40px;outline:none;font-size:14px}
.btn{height:50px;border-radius:16px;border:1px solid rgba(255,255,255,.09);padding:0 16px;color:#fff;cursor:pointer;font-weight:800;font-size:13px;background:rgba(255,255,255,.045)}
.btn-primary{background:linear-gradient(135deg,#3b82f6,#2563eb)}
.meta{justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,.05);color:var(--muted);font-size:13px}
.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:9px 13px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);color:#dbe7ff}
.tabs{padding:12px 20px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.tab{height:36px;padding:0 18px;border-radius:12px 12px 0 0;border:1px solid transparent;font-size:13px;font-weight:700;cursor:pointer;color:var(--muted);background:transparent}
.tab.active{color:#fff;background:linear-gradient(180deg,rgba(94,162,255,.16),rgba(155,124,255,.10));border-color:rgba(255,255,255,.1) rgba(255,255,255,.1) transparent}
.filters{padding:12px 20px 0;flex-wrap:wrap}
.filter-chip{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#d7e5ff;height:38px;padding:0 14px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:800}
.content{position:relative;padding:18px 20px 22px;height:calc(100% - 220px);overflow:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:18px}
.card{position:relative;display:flex;gap:14px;padding:14px;min-height:190px;border-radius:24px;background:rgba(13,18,30,.72);border:1px solid rgba(255,255,255,.08)}
.cover,.fallback{width:106px;height:150px;border-radius:18px;flex-shrink:0}
.cover{object-fit:cover}
.fallback{display:flex;align-items:center;justify-content:center;color:#8ea2c5;font-size:12px}
.info{min-width:0;width:100%;display:flex;flex-direction:column;justify-content:space-between}
.title{font-size:17px;font-weight:800;line-height:1.34;margin:0 0 10px 0;color:#f7fbff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.chip{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.05);color:#d8e4fb}
.sub{color:var(--muted);font-size:12px;line-height:1.45;word-break:break-word;opacity:.95}
.empty,.history-empty,.fav-empty{text-align:center;color:var(--muted);font-size:13px;padding:40px 0}
.history-list,.fav-grid{display:grid;gap:8px}
.history-item,.fav-card{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)}
.history-item-text,.fav-title{font-size:13px;font-weight:600;color:#cdd9f0;flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.history-del,.fav-remove{width:26px;height:26px;border-radius:8px;border:none;background:rgba(239,68,68,.16);color:#fca5a5;cursor:pointer}
.fav-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.fav-card{position:relative;display:block;padding:0;overflow:hidden}
.fav-cover{width:100%;aspect-ratio:2/3;object-fit:cover;display:block}
.fav-info{padding:9px 10px}
.fav-source{font-size:11px;color:var(--muted);margin-top:3px}
.content::-webkit-scrollbar{width:10px}
.content::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:999px}
</style>
</head>
<body>
<div class="overlay"><div class="window"><div class="topbar"><div class="brand"><img class="brand-logo" src="${BRAND_ICON}" alt="PT Scans"/><div><div class="brand-title">PT Scans Search</div></div></div><div class="searchbar"><input id="query" placeholder="Pesquisar..."/><button id="searchBtn" class="btn btn-primary">Pesquisar</button><button id="reloadBtn" class="btn">Reload</button><button id="clearBtn" class="btn">Limpar</button><button id="statsBtn" class="btn">Stats</button><button id="closeBtn" class="btn">Fechar</button></div></div><div class="meta"><div class="pill"><div id="statusText">Pronto</div></div><div class="pill" id="resultMeta">0 resultados</div></div><div class="meta"><div class="pill" id="statsMeta">Pesquisas: 0 · Favoritos: 0 · Abertos: 0</div><div class="pill">Ctrl+Enter pesquisar · Esc fechar</div></div><div class="tabs"><button class="tab active" data-tab="search">🔍 Resultados</button><button class="tab" data-tab="history">🕑 Histórico</button><button class="tab" data-tab="favorites">⭐ Favoritos</button></div><div class="filters" id="sourceFilters"></div><div class="content"><div id="app"></div></div></div></div>
<script>
const BRAND_ICON = "https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png";
const state={results:[],status:"Pronto",loading:false,query:"",sourceFilter:"all",activeTab:"search",history:[],favorites:[],stats:{searches:0,opens:0,favorites:0}};
function esc(v){return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}
function getSrc(i){if(i.rawSource)return i.rawSource;const r=String(i.id||""),x=r.indexOf(":");return x!==-1?r.slice(0,x):"unknown"}
function isFav(id){return state.favorites.some(f=>f.id===id)}
function renderSkeletons(){return '<div class="grid">'+Array.from({length:6}).map(()=>'<div class="card"></div>').join('')+'</div>'}
function renderFilters(items){const w=document.getElementById('sourceFilters');if(!w)return;const show=state.activeTab==='search';w.style.display=show?'flex':'none';if(!show)return;const c={all:items.length,mangaflix:0,mangalivre:0,hipercool:0,tiamanhwa:0,mangafire:0};items.forEach(i=>{const s=getSrc(i);if(c[s]!=null)c[s]++});const d=[['all','Todos'],['mangaflix','MangaFlix'],['mangalivre','MangaLivre'],['hipercool','HiperCool'],['tiamanhwa','TiaManhwa'],['mangafire','MangaFire']];w.innerHTML=d.map(a=>'<button class="filter-chip '+(state.sourceFilter===a[0]?'active':'')+'" data-source="'+a[0]+'">'+a[1]+' ('+(c[a[0]]||0)+')</button>').join('');w.querySelectorAll('.filter-chip').forEach(b=>b.addEventListener('click',()=>{state.sourceFilter=b.dataset.source||'all';render()}))}
function renderSearch(){const all=Array.isArray(state.results)?state.results:[];const filtered=state.sourceFilter==='all'?all:all.filter(i=>getSrc(i)===state.sourceFilter);document.getElementById('resultMeta').textContent=filtered.length+' resultados';renderFilters(all);if(state.loading&&all.length===0)return renderSkeletons();if(filtered.length===0)return '<div class="empty">'+(all.length===0?'Pesquisa um título para começar.':'Sem resultados para este filtro.')+'</div>';return '<div class="grid">'+filtered.map(item=>{const cover=item.image?'<img class="cover" src="'+esc(item.image)+'" alt="'+esc(item.title)+'"/>':'<div class="fallback">Sem capa</div>';return '<div class="card"><button class="fav-remove" data-id="'+esc(item.id)+'" data-fav="1">'+(isFav(item.id)?'⭐':'☆')+'</button>'+cover+'<div class="info"><div><div class="title">'+esc(item.title)+'</div><div class="stats"><div class="chip">'+esc(item.source||getSrc(item))+'</div><div class="chip">Caps: '+(item.hasChapters?'Sim':'Não')+'</div><div class="chip">Total: '+esc(item.chapterCount)+'</div><div class="chip">Último: '+esc(item.latestChapter||'-')+'</div>'+(item.year?'<div class="chip">Ano: '+esc(item.year)+'</div>':'')+'</div></div><div class="sub">'+esc(item.id||'')+'</div></div></div>'}).join('')+'</div>'}
function renderHistory(){renderFilters([]);const hist=Array.isArray(state.history)?state.history.slice():[];document.getElementById('resultMeta').textContent=hist.length+' entradas';if(hist.length===0)return '<div class="history-empty">Nenhuma pesquisa guardada ainda.</div>';return '<div class="history-list">'+hist.map(q=>'<div class="history-item" data-hist="'+esc(q)+'"><span class="history-item-text">'+esc(q)+'</span><button class="history-del" data-del-hist="'+esc(q)+'">✕</button></div>').join('')+'</div>'}
function renderFavorites(){renderFilters([]);const favs=state.favorites;document.getElementById('resultMeta').textContent=favs.length+' favoritos';if(favs.length===0)return '<div class="fav-empty">Sem favoritos ainda.</div>';return '<div class="fav-grid">'+favs.map(f=>'<div class="fav-card" data-fav-search="'+esc(f.title)+'">'+(f.image?'<img class="fav-cover" src="'+esc(f.image)+'" alt="'+esc(f.title)+'"/>':'<div class="fav-cover" style="display:flex;align-items:center;justify-content:center;background:rgba(20,27,43,.9);color:#8ea2c5">Sem capa</div>')+'<div class="fav-info"><div class="fav-title">'+esc(f.title)+'</div><div class="fav-source">'+esc(f.source||'')+(f.year?' · '+esc(f.year):'')+'</div></div><button class="fav-remove" data-rm-fav="'+esc(f.id)+'">✕</button></div>').join('')+'</div>'}
function render(){const app=document.getElementById('app');document.getElementById('statusText').textContent=state.status||'Pronto';const input=document.getElementById('query');document.getElementById('statsMeta').textContent='Pesquisas: '+(state.stats.searches||0)+' · Favoritos: '+state.favorites.length+' · Abertos: '+(state.stats.opens||0);if(document.activeElement!==input)input.value=state.query||'';document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===state.activeTab));app.innerHTML=state.activeTab==='search'?renderSearch():state.activeTab==='history'?renderHistory():renderFavorites();app.querySelectorAll('[data-fav="1"]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();const item=state.results.find(r=>r.id===btn.dataset.id);if(item)window.webview.send('toggleFavorite',item)}));app.querySelectorAll('.history-item').forEach(row=>row.addEventListener('click',e=>{if(e.target.closest('[data-del-hist]'))return;state.activeTab='search';window.webview.send('search',row.dataset.hist)}));app.querySelectorAll('[data-del-hist]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();window.webview.send('removeHistory',btn.dataset.delHist)}));app.querySelectorAll('[data-rm-fav]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();window.webview.send('removeFavorite',btn.dataset.rmFav)}));app.querySelectorAll('[data-fav-search]').forEach(card=>card.addEventListener('click',e=>{if(e.target.closest('[data-rm-fav]'))return;state.activeTab='search';window.webview.send('search',card.dataset.favSearch)}));const c=document.getElementById('clearHistBtn');if(c)c.addEventListener('click',()=>window.webview.send('clearHistory'))}
document.getElementById('searchBtn').addEventListener('click',()=>{state.activeTab='search';window.webview.send('search',document.getElementById('query').value)});document.getElementById('query').addEventListener('keydown',e=>{if(e.key==='Enter'){state.activeTab='search';window.webview.send('search',document.getElementById('query').value)}});document.getElementById('clearBtn').addEventListener('click',()=>{document.getElementById('query').value='';state.sourceFilter='all';window.webview.send('clear')});document.getElementById('closeBtn').addEventListener('click',()=>window.webview.send('hide'));document.getElementById('reloadBtn').addEventListener('click',()=>window.webview.send('reloadProvider'));document.getElementById('statsBtn').addEventListener('click',()=>{state.activeTab='history';render()});document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{state.activeTab=tab.dataset.tab;render()}));window.webview.on('results',v=>{state.results=v||[];render()});window.webview.on('status',v=>{state.status=v||'Pronto';render()});window.webview.on('loading',v=>{state.loading=!!v;render()});window.webview.on('query',v=>{state.query=v||'';render()});window.webview.on('history',v=>{state.history=Array.isArray(v)?v.slice():[];render()});window.webview.on('favorites',v=>{state.favorites=v||[];render()});window.webview.on('stats',v=>{state.stats=v||{searches:0,opens:0,favorites:0};render()});document.addEventListener('keydown',e=>{if(e.key==='Escape')window.webview.send('hide');if(e.ctrlKey&&e.key==='Enter')window.webview.send('search',document.getElementById('query').value)});render();
</script>
</body>
</html>
    `);
  });
}
