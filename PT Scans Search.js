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

    // ── LocalStorage helpers ─────────────────────────────────────────────────
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

    // ── History ──────────────────────────────────────────────────────────────
    function loadHistory()  { historyState.set(lsGet(HISTORY_KEY, [])); }
    function addToHistory(query) {
      if (!query) return;
      let hist = lsGet(HISTORY_KEY, []);
      hist = hist.filter(q => q !== query);
      hist.unshift(query);
      if (hist.length > MAX_HISTORY) hist = hist.slice(0, MAX_HISTORY);
      lsSet(HISTORY_KEY, hist);
      historyState.set(hist);
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

    // ── Favorites ────────────────────────────────────────────────────────────
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

    // ── Provider ─────────────────────────────────────────────────────────────
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
.blob,.blob::before,.blob::after{position:absolute;border-radius:999px;filter:blur(40px);pointer-events:none}
.blob{width:280px;height:280px;left:-60px;top:-40px;background:rgba(91,168,255,.18);animation:driftA 14s ease-in-out infinite}
.blob::before{content:"";width:210px;height:210px;left:980px;top:80px;background:rgba(164,118,255,.14);animation:driftB 16s ease-in-out infinite}
.blob::after{content:"";width:240px;height:240px;left:460px;top:520px;background:rgba(86,234,181,.10);animation:driftC 18s ease-in-out infinite}
@keyframes driftA{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(60px,35px,0) scale(1.08)}}
@keyframes driftB{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-70px,25px,0) scale(1.12)}}
@keyframes driftC{0%,100%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(35px,-55px,0) scale(1.06)}}
.window{position:relative;width:100%;height:calc(86vh - 6px);border-radius:28px;overflow:hidden;background:linear-gradient(180deg,rgba(14,20,36,.84),rgba(8,12,23,.78));border:1px solid rgba(255,255,255,.11);box-shadow:var(--shadow);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);animation:fadeUp .35s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px) scale(.988)}to{opacity:1;transform:translateY(0) scale(1)}}
.shine{position:absolute;inset:0 auto auto -20%;width:45%;height:2px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent);opacity:.45;animation:shine 5.6s linear infinite}
@keyframes shine{from{transform:translateX(-15%)}to{transform:translateX(250%)}}
.topbar{display:flex;align-items:center;gap:14px;padding:18px 20px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.02))}
.brand{display:flex;align-items:center;gap:14px;min-width:220px}
.brand-logo-wrap{position:relative;width:54px;height:54px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(180deg,rgba(94,162,255,.18),rgba(155,124,255,.16));border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 30px rgba(74,120,255,.20);overflow:hidden}
.brand-logo-wrap::after{content:"";position:absolute;inset:-20%;background:conic-gradient(from 180deg,transparent,rgba(255,255,255,.18),transparent 35%);animation:spin 6s linear infinite}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.brand-logo{position:relative;z-index:1;width:34px;height:34px;object-fit:contain;filter:drop-shadow(0 3px 10px rgba(0,0,0,.35))}
.brand-title{font-size:17px;font-weight:800;color:#f8fbff;letter-spacing:.2px}
.searchbar{flex:1;display:flex;gap:10px;min-width:0;align-items:center}
.search-shell{flex:1;position:relative;min-width:0}
.search-shell::before{content:"⌕";position:absolute;left:14px;top:50%;transform:translateY(-50%);color:#9bb8eb;font-size:15px;opacity:.9;pointer-events:none}
.searchbar input{width:100%;height:50px;border-radius:16px;border:1px solid rgba(255,255,255,.09);background:rgba(6,10,19,.42);color:white;padding:0 16px 0 40px;outline:none;font-size:14px;transition:.2s ease}
.searchbar input:focus{border-color:rgba(94,162,255,.45);box-shadow:0 0 0 4px rgba(94,162,255,.12);background:rgba(7,12,24,.55)}
.btn{height:50px;border-radius:16px;border:1px solid rgba(255,255,255,.09);padding:0 16px;color:white;cursor:pointer;font-weight:800;font-size:13px;background:rgba(255,255,255,.045);transition:transform .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease}
.btn:hover{transform:translateY(-1px);background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14)}
.btn-primary{background:linear-gradient(135deg,#3b82f6,#2563eb);border-color:rgba(108,164,255,.45);box-shadow:0 14px 28px rgba(37,99,235,.28)}
.meta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,.05);color:var(--muted);font-size:13px;background:rgba(255,255,255,.02)}
.status-wrap{display:inline-flex;align-items:center;gap:10px;min-width:0}
.status-dot{width:9px;height:9px;border-radius:999px;background:var(--blue);box-shadow:0 0 18px rgba(94,162,255,.8);animation:pulse 1.3s ease-in-out infinite;flex-shrink:0}
@keyframes pulse{0%,100%{transform:scale(.88);opacity:.72}50%{transform:scale(1.2);opacity:1}}
.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:9px 13px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);color:#dbe7ff}
.tabs{display:flex;gap:4px;padding:12px 20px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.tab{height:36px;padding:0 18px;border-radius:12px 12px 0 0;border:1px solid transparent;font-size:13px;font-weight:700;cursor:pointer;color:var(--muted);background:transparent;transition:.18s ease}
.tab:hover{color:#fff;background:rgba(255,255,255,.05)}
.tab.active{color:#fff;background:linear-gradient(180deg,rgba(94,162,255,.16),rgba(155,124,255,.10));border-color:rgba(255,255,255,.1) rgba(255,255,255,.1) transparent}
.filters{display:flex;gap:10px;padding:12px 20px 0;flex-wrap:wrap}
.filter-chip{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#d7e5ff;height:38px;padding:0 14px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:800;transition:.18s ease}
.filter-chip:hover{background:rgba(255,255,255,.08);transform:translateY(-1px)}
.filter-chip.active{background:linear-gradient(135deg,rgba(59,130,246,.22),rgba(147,51,234,.18));border-color:rgba(94,162,255,.32);color:#ffffff;box-shadow:0 8px 20px rgba(59,130,246,.16)}
.content{position:relative;padding:18px 20px 22px;height:calc(100% - 220px);overflow:auto;scroll-behavior:smooth}
.content::-webkit-scrollbar{width:10px}
.content::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:999px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:18px}
.card{position:relative;display:flex;gap:14px;padding:14px;min-height:190px;border-radius:24px;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.025)),rgba(13,18,30,.72);border:1px solid rgba(255,255,255,.08);box-shadow:0 16px 34px rgba(0,0,0,.18);transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;overflow:hidden;animation:cardIn .35s ease both}
.card:nth-child(1){animation-delay:.02s}.card:nth-child(2){animation-delay:.04s}.card:nth-child(3){animation-delay:.06s}.card:nth-child(4){animation-delay:.08s}.card:nth-child(5){animation-delay:.10s}.card:nth-child(6){animation-delay:.12s}
@keyframes cardIn{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
.card::before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,transparent 0%,rgba(255,255,255,.05) 20%,transparent 42%);transform:translateX(-120%);transition:transform .65s ease;pointer-events:none}
.card:hover{transform:translateY(-3px);border-color:rgba(110,170,255,.24);box-shadow:0 24px 40px rgba(0,0,0,.24)}
.card:hover::before{transform:translateX(140%)}
.card-fav-btn{position:absolute;top:12px;right:12px;z-index:2;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.38);cursor:pointer;display:grid;place-items:center;font-size:16px;transition:.18s ease;backdrop-filter:blur(6px)}
.card-fav-btn:hover{transform:scale(1.18);border-color:rgba(251,191,36,.5)}
.card-fav-btn.fav{border-color:rgba(251,191,36,.55);background:rgba(245,158,11,.22)}
.cover,.fallback{width:106px;height:150px;border-radius:18px;flex-shrink:0}
.cover{object-fit:cover;background:rgba(7,10,18,.55);border:1px solid rgba(255,255,255,.07);box-shadow:0 8px 20px rgba(0,0,0,.22)}
.fallback{border:1px solid rgba(255,255,255,.07);background:radial-gradient(circle at 30% 20%,rgba(94,162,255,.20),transparent 28%),linear-gradient(180deg,rgba(20,27,43,.95),rgba(9,12,20,.95));display:flex;align-items:center;justify-content:center;color:#8ea2c5;font-size:12px;text-align:center;padding:12px}
.info{min-width:0;width:100%;display:flex;flex-direction:column;justify-content:space-between}
.title{font-size:17px;font-weight:800;line-height:1.34;margin:0 0 10px 0;color:#f7fbff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.chip{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.05);color:#d8e4fb}
.chip.ok{color:#c8ffe0;background:rgba(34,197,94,.11);border-color:rgba(34,197,94,.19)}
.chip.no{color:#ffd0d8;background:rgba(239,68,68,.10);border-color:rgba(239,68,68,.18)}
.chip.source{color:#d5e7ff;background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.18)}
.sub{color:var(--muted);font-size:12px;line-height:1.45;word-break:break-word;opacity:.95}
.history-wrap{padding:0}
.history-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.history-header h3{margin:0;font-size:15px;font-weight:800;color:#d8e8ff}
.btn-sm{height:32px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.05);color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;transition:.16s ease}
.btn-sm:hover{background:rgba(239,68,68,.16);border-color:rgba(239,68,68,.28);color:#fca5a5}
.history-list{display:flex;flex-direction:column;gap:8px}
.history-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;border-radius:14px;cursor:pointer;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);transition:.16s ease}
.history-item:hover{background:rgba(94,162,255,.10);border-color:rgba(94,162,255,.22)}
.history-item-text{font-size:13px;font-weight:600;color:#cdd9f0;flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.history-del{width:26px;height:26px;border-radius:8px;border:none;background:transparent;color:#6b7fa0;font-size:14px;cursor:pointer;display:grid;place-items:center;flex-shrink:0;transition:.14s ease}
.history-del:hover{background:rgba(239,68,68,.16);color:#fca5a5}
.history-empty{text-align:center;color:var(--muted);font-size:13px;padding:40px 0}
.fav-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.fav-header h3{margin:0;font-size:15px;font-weight:800;color:#fde68a}
.fav-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
.fav-card{position:relative;border-radius:18px;overflow:hidden;cursor:pointer;background:rgba(13,18,30,.72);border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 22px rgba(0,0,0,.18);transition:.18s ease;animation:cardIn .3s ease both}
.fav-card:hover{transform:translateY(-3px);border-color:rgba(251,191,36,.28)}
.fav-cover{width:100%;aspect-ratio:2/3;object-fit:cover;display:block}
.fav-cover-placeholder{width:100%;aspect-ratio:2/3;display:flex;align-items:center;justify-content:center;background:rgba(20,27,43,.9);color:#8ea2c5;font-size:11px;text-align:center;padding:8px}
.fav-info{padding:9px 10px}
.fav-title{font-size:12px;font-weight:700;color:#f0f6ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fav-source{font-size:11px;color:var(--muted);margin-top:3px}
.fav-remove{position:absolute;top:8px;right:8px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.5);color:#f87171;font-size:13px;cursor:pointer;display:grid;place-items:center;backdrop-filter:blur(6px);transition:.16s ease}
.fav-remove:hover{background:rgba(239,68,68,.3);border-color:rgba(239,68,68,.5)}
.fav-empty{text-align:center;color:var(--muted);font-size:13px;padding:40px 0}
.empty{display:flex;align-items:center;justify-content:center;min-height:380px;border-radius:26px;border:1px dashed rgba(255,255,255,.10);background:radial-gradient(circle at top,rgba(94,162,255,.08),transparent 36%),rgba(255,255,255,.025);color:#9db1d3;text-align:center;padding:32px;animation:fadeUp .3s ease}
.empty-box{max-width:460px}
.empty-logo{width:70px;height:70px;object-fit:contain;opacity:.94;margin-bottom:14px;filter:drop-shadow(0 10px 18px rgba(0,0,0,.22));animation:floaty 3s ease-in-out infinite}
@keyframes floaty{0%,100%{transform:translateY(0px)}50%{transform:translateY(-5px)}}
.loading-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:18px}
.skeleton{position:relative;min-height:190px;border-radius:24px;overflow:hidden;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02)),rgba(13,18,30,.6);border:1px solid rgba(255,255,255,.07)}
.skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent);animation:skeleton 1.4s infinite}
@keyframes skeleton{100%{transform:translateX(100%)}}
@media(max-width:920px){.topbar{flex-direction:column;align-items:stretch}.searchbar{width:100%;flex-wrap:wrap}.btn{flex:1}.content{height:calc(100% - 260px)}}
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
          <img class="brand-logo" src="${BRAND_ICON}" alt="PT Scans"/>
        </div>
        <div class="brand-copy">
          <div class="brand-title">PT Scans Search</div>
        </div>
      </div>
      <div class="searchbar">
        <div class="search-shell">
          <input id="query" placeholder="Pesquisar..."/>
        </div>
        <button id="searchBtn" class="btn btn-primary">Pesquisar</button>
        <button id="reloadBtn" class="btn">Reload</button>
        <button id="clearBtn"  class="btn">Limpar</button>
        <button id="statsBtn"  class="btn">Stats</button>
        <button id="closeBtn"  class="btn">Fechar</button>
      </div>
    </div>
    <div class="meta">
      <div class="status-wrap">
        <div class="status-dot"></div>
        <div id="statusText">Pronto</div>
      </div>
      <div class="pill" id="resultMeta">0 resultados</div>
    </div>
    <div class="meta" style="border-top:1px solid rgba(255,255,255,.04)">
      <div class="pill" id="statsMeta">Pesquisas: 0 · Favoritos: 0 · Abertos: 0</div>
      <div class="pill" id="hintMeta">Ctrl+Enter pesquisar · Esc fechar</div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="search">🔍 Resultados</button>
      <button class="tab"        data-tab="history">🕑 Histórico</button>
      <button class="tab"        data-tab="favorites">⭐ Favoritos</button>
    </div>
    <div class="filters" id="sourceFilters"></div>
    <div class="content">
      <div id="app"></div>
    </div>
  </div>
</div>
<script>
const BRAND_ICON = "https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png";
const state = { results:[], status:"Pronto", loading:false, query:"", sourceFilter:"all", activeTab:"search", history:[], favorites:[], stats:{ searches:0, opens:0, favorites:0 } };
function esc(v){ return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }
function getSrc(item){ if(item.rawSource)return item.rawSource; const r=String(item.id||""),i=r.indexOf(":"); return i!==-1?r.slice(0,i):"unknown"; }
function isFav(id){ return state.favorites.some(f=>f.id===id); }
function renderSkeletons(){ return '<div class="loading-grid">'+Array.from({length:6}).map(()=>'<div class="skeleton"></div>').join("")+'</div>'; }
function buildCounts(items){ const c={all:items.length,mangaflix:0,mangalivre:0,hipercool:0,tiamanhwa:0,mangafire:0}; items.forEach(i=>{const s=getSrc(i);if(c[s]!=null)c[s]++;}); return c; }
function renderFilters(items){
  const wrap=document.getElementById("sourceFilters"); if(!wrap)return;
  const show=state.activeTab==="search"; wrap.style.display=show?"flex":"none"; if(!show)return;
  const cnt=buildCounts(items);
  const defs=[{key:"all",label:"Todos"},{key:"mangaflix",label:"MangaFlix"},{key:"mangalivre",label:"MangaLivre"},{key:"hipercool",label:"HiperCool"},{key:"tiamanhwa",label:"TiaManhwa"},{key:"mangafire",label:"MangaFire"}];
  wrap.innerHTML=defs.map(d=>'<button class="filter-chip '+(state.sourceFilter===d.key?"active":"")+'" data-source="'+esc(d.key)+'" type="button">'+esc(d.label)+' ('+(cnt[d.key]||0)+')</button>').join("");
  wrap.querySelectorAll(".filter-chip").forEach(btn=>{ btn.addEventListener("click",()=>{ state.sourceFilter=btn.dataset.source||"all"; render(); }); });
}
function renderSearch(){
  const all=Array.isArray(state.results)?state.results:[];
  const filtered=state.sourceFilter==="all"?all:all.filter(i=>getSrc(i)===state.sourceFilter);
  document.getElementById("resultMeta").textContent=filtered.length+" resultados";
  renderFilters(all);
  if(state.loading&&all.length===0)return renderSkeletons();
  if(filtered.length===0)return'<div class="empty"><div class="empty-box"><img class="empty-logo" src="'+esc(BRAND_ICON)+'" alt="PT Scans"/><div style="font-size:18px;font-weight:800;color:#f4f8ff;margin-bottom:8px;">PT Scans</div><div style="font-size:13px;line-height:1.6;color:#9db1d3;">'+(all.length===0?'Pesquisa um título para começar.':'Sem resultados para este filtro.')+'</div><div style="margin-top:14px;font-size:12px;color:#89a5cf;">Sugestão: abre um favorito ou usa histórico para repetir rapidamente.</div></div></div>';
  return '<div class="grid">'+filtered.map(item=>{
    const cover=item.image?'<img class="cover" src="'+esc(item.image)+'" alt="'+esc(item.title)+'"/>':"<div class='fallback'>Sem capa</div>";
    return '<div class="card"><button class="card-fav-btn '+(isFav(item.id)?"fav":"")+'" data-id="'+esc(item.id)+'" data-fav="1" title="Favorito">'+(isFav(item.id)?"⭐":"☆")+'</button>'+cover+'<div class="info"><div><div class="title">'+esc(item.title)+'</div><div class="stats"><div class="chip source">'+esc(item.source||getSrc(item))+'</div><div class="chip '+(item.hasChapters?"ok":"no")+'">Caps: '+(item.hasChapters?"Sim":"Não")+'</div><div class="chip">Total: '+esc(item.chapterCount)+'</div><div class="chip">Último: '+esc(item.latestChapter||"-")+'</div>'+(item.year?'<div class="chip">Ano: '+esc(item.year)+'</div>':'')+'</div></div><div class="sub">'+esc(item.id||"")+'</div></div></div>';
  }).join("")+'</div>';
}
function renderHistory(){
  renderFilters([]);
  document.getElementById("resultMeta").textContent=state.history.length+" entradas";
  const hist=state.history;
  if(hist.length===0)return'<div class="history-empty">Nenhuma pesquisa guardada ainda.</div>';
  return'<div class="history-wrap"><div class="history-header"><h3>🕑 Histórico de Pesquisas</h3><button class="btn-sm" id="clearHistBtn">Limpar tudo</button></div><div class="history-list">'+hist.map(q=>'<div class="history-item" data-hist="'+esc(q)+'"><span class="history-item-text">'+esc(q)+'</span><button class="history-del" data-del-hist="'+esc(q)+'" title="Remover">✕</button></div>').join("")+'</div></div>';
}
function renderFavorites(){
  renderFilters([]);
  const favs=state.favorites;
  document.getElementById("resultMeta").textContent=favs.length+" favoritos";
  if(favs.length===0)return'<div class="fav-empty">Sem favoritos ainda.<br/><span style="font-size:11px;opacity:.6">Clica no ☆ em qualquer resultado para guardar.</span></div>';
  return'<div class="fav-header"><h3>⭐ Favoritos</h3></div><div class="fav-grid">'+favs.map(f=>'<div class="fav-card" data-fav-search="'+esc(f.title)+'">'+(f.image?'<img class="fav-cover" src="'+esc(f.image)+'" alt="'+esc(f.title)+'"/>':"<div class='fav-cover-placeholder'>Sem capa</div>")+'<div class="fav-info"><div class="fav-title">'+esc(f.title)+'</div><div class="fav-source">'+esc(f.source||"")+(f.year?" · "+esc(f.year):"")+'</div></div><button class="fav-remove" data-rm-fav="'+esc(f.id)+'" title="Remover">✕</button></div>').join("")+'</div>';
}
function render(){
  const app=document.getElementById("app");
  document.getElementById("statusText").textContent=state.status||"Pronto";
  const input=document.getElementById("query");
  const sm=document.getElementById("statsMeta");
  if(sm) sm.textContent = 'Pesquisas: ' + (state.stats.searches||0) + ' · Favoritos: ' + state.favorites.length + ' · Abertos: ' + (state.stats.opens||0);
  if(document.activeElement!==input)input.value=state.query||"";
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===state.activeTab));
  let html="";
  if(state.activeTab==="search")html=renderSearch();
  else if(state.activeTab==="history")html=renderHistory();
  else if(state.activeTab==="favorites")html=renderFavorites();
  app.innerHTML=html;
  app.querySelectorAll("[data-fav='1']").forEach(btn=>{ btn.addEventListener("click",(e)=>{ e.stopPropagation(); const item=state.results.find(r=>r.id===btn.dataset.id); if(item)window.webview.send("toggleFavorite",item); }); });
  app.querySelectorAll(".history-item").forEach(row=>{ row.addEventListener("click",(e)=>{ if(e.target.closest("[data-del-hist]"))return; state.activeTab="search"; window.webview.send("search",row.dataset.hist); }); });
  app.querySelectorAll("[data-del-hist]").forEach(btn=>{ btn.addEventListener("click",(e)=>{ e.stopPropagation(); window.webview.send("removeHistory",btn.dataset.delHist); }); });
  const chb=document.getElementById("clearHistBtn"); if(chb)chb.addEventListener("click",()=>window.webview.send("clearHistory"));
  app.querySelectorAll("[data-rm-fav]").forEach(btn=>{ btn.addEventListener("click",(e)=>{ e.stopPropagation(); window.webview.send("removeFavorite",btn.dataset.rmFav); }); });
  app.querySelectorAll("[data-fav-search]").forEach(card=>{ card.addEventListener("click",(e)=>{ if(e.target.closest("[data-rm-fav]"))return; state.activeTab="search"; window.webview.send("search",card.dataset.favSearch); }); });
}
document.getElementById("searchBtn").addEventListener("click",()=>{ state.activeTab="search"; window.webview.send("search",document.getElementById("query").value); });
document.getElementById("query").addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ state.activeTab="search"; window.webview.send("search",document.getElementById("query").value); } });
document.getElementById("clearBtn").addEventListener("click",()=>{ document.getElementById("query").value=""; state.sourceFilter="all"; window.webview.send("clear"); });
document.getElementById("closeBtn").addEventListener("click",()=>window.webview.send("hide"));
document.getElementById("reloadBtn").addEventListener("click",()=>window.webview.send("reloadProvider"));
document.getElementById("statsBtn").addEventListener("click",()=>{ state.activeTab='history'; render(); });
document.querySelectorAll(".tab").forEach(tab=>{ tab.addEventListener("click",()=>{ state.activeTab=tab.dataset.tab; render(); }); });
window.webview.on("results",  v=>{ state.results  =v||[]; render(); });
window.webview.on("status",   v=>{ state.status   =v||"Pronto"; render(); });
window.webview.on("loading",  v=>{ state.loading  =!!v; render(); });
window.webview.on("query",    v=>{ state.query    =v||""; render(); });
window.webview.on("history",  v=>{ state.history  =v||[]; render(); });
window.webview.on("favorites",v=>{ state.favorites=v||[]; render(); });
window.webview.on("stats",v=>{ state.stats=v||{ searches:0, opens:0, favorites:0 }; render(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.webview.send('hide');
  if (e.ctrlKey && e.key === 'Enter') window.webview.send('search', document.getElementById('query').value);
});
render();
</script>
</body>
</html>
    `);
  });
}
