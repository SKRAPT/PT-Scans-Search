function init() {
  $ui.register((ctx) => {
    const BRAND_ICON = "https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png";
    const PROVIDER_MANIFEST_URL = "https://raw.githubusercontent.com/SKRAPT/PT-Scans/refs/heads/main/ptscans-provider.json";

    const tray = ctx.newTray({ tooltipText: "PT Scans Search", iconUrl: BRAND_ICON, withContent: false });
    const panel = ctx.newWebview({
      slot: "fixed", width: "100%", maxWidth: "1280px", height: "86vh",
      hidden: true, zIndex: 60,
      window: { draggable: true, defaultPosition: "bottom-right", frameless: true }
    });

    const queryState    = ctx.state("");
    const loading       = ctx.state(false);
    const status        = ctx.state("Pronto");
    const results       = ctx.state([]);
    const mode          = ctx.state("search");
    const libraryData   = ctx.state([]);
    const providerModal = ctx.state(null);

    panel.channel.sync("results",       results);
    panel.channel.sync("status",        status);
    panel.channel.sync("loading",       loading);
    panel.channel.sync("query",         queryState);
    panel.channel.sync("mode",          mode);
    panel.channel.sync("libraryData",   libraryData);
    panel.channel.sync("providerModal", providerModal);

    let providerPromise = null;

    function normalizeText(v) { return typeof v === "string" ? v.trim() : ""; }
    function splitSourceId(v) {
      const raw = normalizeText(v);
      const idx = raw.indexOf(":");
      if (idx === -1) return { source: "", id: raw };
      return { source: raw.slice(0, idx), id: raw.slice(idx + 1) };
    }
    function sourceLabel(s) {
      const m = { mangaflix: "MangaFlix", mangalivre: "MangaLivre", hipercool: "HiperCool", tiamanhwa: "TiaManhwa", mangafire: "MangaFire" };
      return m[s] || s || "Desconhecido";
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
        const p = new ProviderClass();
        p.getDisableNsfwConfig = () => false;
        return p;
      })();
      return providerPromise;
    }

    async function enrichWithChapters(provider, items) {
      const limited = items.slice(0, 24);
      const detailed = await Promise.allSettled(
        limited.map(async (item) => {
          let chapters = [];
          try { chapters = safeArray(await provider.findChapters(item.id)); } catch (e) {}
          const src = splitSourceId(item.id).source;
          return {
            id: item.id, source: sourceLabel(src), rawSource: src,
            title: stripProviderPrefix(item.title || ""), image: item.image || "",
            year: item.year || null, synonyms: safeArray(item.synonyms),
            hasChapters: chapters.length > 0, chapterCount: chapters.length,
            latestChapter: chapters.length ? (chapters[chapters.length - 1].chapter || null) : null
          };
        })
      );
      const ok = detailed.filter(e => e.status === "fulfilled").map(e => e.value);
      if (items.length > limited.length) {
        return ok.concat(items.slice(limited.length).map(item => {
          const src = splitSourceId(item.id).source;
          return { id: item.id, source: sourceLabel(src), rawSource: src, title: stripProviderPrefix(item.title || ""), image: item.image || "", year: item.year || null, synonyms: safeArray(item.synonyms), hasChapters: false, chapterCount: 0, latestChapter: null };
        }));
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
        status.set("A pesquisar...");
        let found = safeArray(await provider.search({ query }));
        found = found.slice(0, 40);
        status.set("A obter capítulos...");
        const enriched = await enrichWithChapters(provider, found);
        results.set(enriched);
        const withCaps = enriched.filter(i => i.hasChapters).length;
        tray.updateBadge({ number: enriched.length, intent: withCaps > 0 ? "info" : "warning" });
        status.set(enriched.length ? "Concluído" : "Sem resultados");
      } catch (e) {
        status.set("Erro: " + (e && e.message ? e.message : "falha desconhecida"));
        results.set([]); tray.updateBadge({ number: 0 });
      } finally { loading.set(false); }
    }

    panel.channel.on("fetchAniList", async (username) => {
      if (!username || !username.trim()) { status.set("Insere um nome de utilizador"); return; }
      const user = username.trim();
      status.set("A carregar biblioteca de " + user + "..."); loading.set(true);
      try {
        const userRes = await fetch("https://graphql.anilist.co", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: 'query { User(name: "' + user.replace(/"/g, '\\"') + '") { id } }' })
        });
        const userData = await userRes.json();
        if (!userData.data || !userData.data.User) throw new Error("Utilizador não encontrado no AniList");
        const userId = userData.data.User.id;
        const listRes = await fetch("https://graphql.anilist.co", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "query { MediaListCollection(userId: " + userId + ", type: MANGA, status: CURRENT) { lists { entries { progress media { id chapters title { romaji english } coverImage { large } } } } } }" })
        });
        const listData = await listRes.json();
        if (!listData.data || !listData.data.MediaListCollection) throw new Error("Erro ao carregar lista do AniList");
        const entries = (listData.data.MediaListCollection.lists[0] || {}).entries || [];
        libraryData.set(entries.map(e => ({
          id: e.media.id, title: e.media.title.english || e.media.title.romaji,
          image: e.media.coverImage.large, chapters: e.media.chapters, progress: e.progress
        })));
        status.set("Biblioteca carregada — " + entries.length + " mangas");
      } catch (e) {
        libraryData.set([]); status.set("Erro AniList: " + (e && e.message ? e.message : "falha"));
      } finally { loading.set(false); }
    });

    panel.channel.on("searchProviders", async (mangaTitle) => {
      if (!mangaTitle) return;
      status.set("A pesquisar \"" + mangaTitle + "\" nos providers...");
      providerModal.set({ title: mangaTitle, loading: true, grouped: {} });
      try {
        const provider = await getProvider();
        const found = safeArray(await provider.search({ query: mangaTitle }));
        const grouped = {};
        await Promise.allSettled(found.map(async (item) => {
          const src = splitSourceId(item.id).source;
          let chapters = [];
          try { chapters = safeArray(await provider.findChapters(item.id)); } catch (e) {}
          if (!grouped[src]) grouped[src] = { label: sourceLabel(src), items: [] };
          grouped[src].items.push({ title: stripProviderPrefix(item.title || ""), chapters: chapters.length, latestChapter: chapters.length ? (chapters[chapters.length - 1].chapter || null) : null });
        }));
        providerModal.set({ title: mangaTitle, loading: false, grouped });
        status.set("Concluído");
      } catch (e) {
        providerModal.set({ title: mangaTitle, loading: false, grouped: {}, error: e.message || "Falha" });
        status.set("Erro providers: " + (e && e.message ? e.message : "falha"));
      }
    });

    tray.onClick(() => { panel.show(); });
    panel.channel.on("search", async (q) => { await runSearch(q || ""); });
    panel.channel.on("hide",   () => { panel.hide(); });
    panel.channel.on("clear",  () => { queryState.set(""); status.set("Pronto"); loading.set(false); results.set([]); tray.updateBadge({ number: 0 }); });
    panel.channel.on("reloadProvider", () => { providerPromise = null; status.set("Cache limpa"); });
    panel.channel.on("setMode", (m) => { mode.set(m); });
    panel.channel.on("closeModal", () => { providerModal.set(null); });

    /* ════════════════════════════════════════ WEBVIEW HTML ════════════════════════════════════════ */
    panel.setContent(() => `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700;900&family=Rajdhani:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
:root {
  --bg:        #0a0808;
  --surface:   #110d0d;
  --surface2:  #1c1515;
  --border:    rgba(180,20,20,0.22);
  --red:       #cc1a1a;
  --red-hot:   #e8322a;
  --red-glow:  rgba(204,26,26,0.35);
  --gold:      #c8a84b;
  --text:      #e8d8d8;
  --muted:     #8a7070;
  --faint:     #4a3535;
  --font-jp:   'Noto Serif JP', serif;
  --font-ui:   'Rajdhani', sans-serif;
  --r:         0.375rem;
  --tr:        180ms cubic-bezier(0.16,1,0.3,1);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;-webkit-font-smoothing:antialiased}
body{font-family:var(--font-ui);background:var(--bg);color:var(--text);display:flex;flex-direction:column}

/* ── SCROLLBAR ── */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:var(--surface)}
::-webkit-scrollbar-thumb{background:var(--red);border-radius:2px}

/* ── TOP BAR ── */
.topbar{
  flex:0 0 auto;
  display:flex;align-items:center;gap:12px;
  padding:10px 16px;
  background:linear-gradient(to bottom,rgba(10,8,8,0.98) 0%,rgba(10,8,8,0.92) 100%);
  border-bottom:1px solid var(--border);
  position:relative;
  user-select:none;
}
.topbar::before{
  content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
  background:linear-gradient(to bottom,transparent,var(--red-hot),transparent);
}

/* Logo/icon */
.logo{
  display:flex;align-items:center;gap:8px;flex-shrink:0;
}
.logo-icon{width:28px;height:28px;border-radius:50%;overflow:hidden;border:1.5px solid var(--border);}
.logo-icon img{width:100%;height:100%;object-fit:cover;}
.logo-title{font-family:var(--font-jp);font-size:13px;font-weight:700;color:var(--text);letter-spacing:0.06em;}
.logo-title span{color:var(--red-hot);}

/* Mode tabs */
.tabs{display:flex;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:2px;}
.tab-btn{
  font-family:var(--font-ui);font-size:11px;font-weight:600;
  letter-spacing:0.12em;text-transform:uppercase;
  color:var(--muted);padding:5px 12px;border-radius:calc(var(--r) - 1px);
  background:none;border:none;cursor:pointer;
  transition:all var(--tr);white-space:nowrap;
}
.tab-btn:hover{color:var(--text);}
.tab-btn.active{background:var(--red);color:#fff;box-shadow:0 0 8px var(--red-glow);}

/* Search bar */
.search-wrap{flex:1;position:relative;min-width:0;}
.search-input{
  width:100%;padding:8px 40px 8px 14px;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  font-family:var(--font-ui);font-size:13px;font-weight:500;color:var(--text);
  transition:border-color var(--tr),box-shadow var(--tr);
  outline:none;
}
.search-input::placeholder{color:var(--faint);}
.search-input:focus{border-color:rgba(204,26,26,0.5);box-shadow:0 0 0 3px rgba(204,26,26,0.1);}
.search-btn{
  position:absolute;right:8px;top:50%;transform:translateY(-50%);
  background:none;border:none;cursor:pointer;color:var(--muted);
  display:flex;align-items:center;justify-content:center;padding:4px;
  transition:color var(--tr);
}
.search-btn:hover{color:var(--red-hot);}

/* AniList input */
.anilist-wrap{display:flex;gap:8px;align-items:center;}
.anilist-input{
  flex:1;padding:8px 14px;
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  font-family:var(--font-ui);font-size:13px;color:var(--text);outline:none;
  transition:border-color var(--tr);
}
.anilist-input:focus{border-color:rgba(204,26,26,0.5);}
.anilist-input::placeholder{color:var(--faint);}

/* Buttons */
.btn{
  font-family:var(--font-ui);font-size:11px;font-weight:700;
  letter-spacing:0.1em;text-transform:uppercase;
  padding:7px 14px;border-radius:var(--r);cursor:pointer;
  border:1px solid transparent;transition:all var(--tr);white-space:nowrap;
}
.btn-red{background:var(--red);color:#fff;border-color:rgba(255,60,40,0.4);box-shadow:0 0 8px var(--red-glow);}
.btn-red:hover{background:var(--red-hot);box-shadow:0 0 14px rgba(232,50,42,0.5);}
.btn-ghost{background:none;color:var(--muted);border-color:var(--border);}
.btn-ghost:hover{color:var(--text);border-color:rgba(180,20,20,0.4);}

/* Status bar */
.statusbar{
  flex:0 0 auto;display:flex;align-items:center;gap:10px;
  padding:5px 16px;
  background:var(--surface);border-bottom:1px solid var(--border);
  font-size:11px;color:var(--muted);letter-spacing:0.08em;
}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--faint);flex-shrink:0;transition:background var(--tr);}
.status-dot.active{background:var(--red-hot);box-shadow:0 0 6px var(--red-glow);animation:pulse 1.2s ease-in-out infinite;}
.status-dot.done{background:#3a9a3a;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.status-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.status-count{color:var(--gold);font-weight:600;}

/* ── MAIN CONTENT ── */
.content{flex:1;overflow-y:auto;overflow-x:hidden;position:relative;}

/* ── SEARCH RESULTS GRID ── */
.results-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(160px,1fr));
  gap:12px;padding:16px;
}

/* Card */
.card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  overflow:hidden;cursor:pointer;position:relative;
  transition:transform var(--tr),border-color var(--tr),box-shadow var(--tr);
}
.card:hover{
  transform:translateY(-3px);
  border-color:rgba(204,26,26,0.5);
  box-shadow:0 8px 24px rgba(0,0,0,0.4),0 0 12px rgba(204,26,26,0.15);
}
.card-thumb{
  width:100%;aspect-ratio:2/3;object-fit:cover;display:block;
  background:var(--surface2);
}
.card-thumb-placeholder{
  width:100%;aspect-ratio:2/3;
  background:linear-gradient(135deg,var(--surface2) 0%,var(--surface) 100%);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--font-jp);font-size:28px;color:var(--faint);
}
.card-body{padding:8px 10px 10px;}
.card-title{
  font-family:var(--font-ui);font-size:12px;font-weight:600;
  color:var(--text);line-height:1.35;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  margin-bottom:5px;
}
.card-meta{display:flex;align-items:center;justify-content:space-between;gap:4px;flex-wrap:wrap;}
.card-source{
  font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
  padding:2px 6px;border-radius:2px;
  background:rgba(204,26,26,0.15);color:var(--red-hot);border:1px solid rgba(204,26,26,0.2);
}
.card-chapters{font-size:10px;color:var(--muted);}
.card-chapters.has{color:var(--gold);}

/* Chapter badge top-right */
.card-badge{
  position:absolute;top:6px;right:6px;
  background:rgba(10,8,8,0.85);border:1px solid var(--border);
  border-radius:3px;padding:2px 6px;
  font-size:9px;font-weight:700;color:var(--gold);letter-spacing:0.06em;
  backdrop-filter:blur(4px);
}

/* Slash accent on hover */
.card::after{
  content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(to right,var(--red-hot),transparent);
  opacity:0;transition:opacity var(--tr);
}
.card:hover::after{opacity:1;}

/* ── LIBRARY GRID ── */
.library-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(200px,1fr));
  gap:14px;padding:16px;
}
.lib-card{
  background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
  display:flex;gap:10px;padding:10px;cursor:pointer;
  transition:all var(--tr);
}
.lib-card:hover{border-color:rgba(204,26,26,0.45);box-shadow:0 4px 16px rgba(0,0,0,0.3);}
.lib-thumb{width:48px;height:64px;object-fit:cover;border-radius:3px;flex-shrink:0;background:var(--surface2);}
.lib-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}
.lib-title{font-size:12px;font-weight:600;color:var(--text);line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.lib-progress{font-size:11px;color:var(--muted);}
.lib-progress strong{color:var(--gold);}
.lib-search-btn{
  margin-top:auto;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;
  color:var(--red-hot);background:none;border:1px solid rgba(204,26,26,0.25);
  border-radius:3px;padding:3px 8px;cursor:pointer;
  transition:all var(--tr);align-self:flex-start;
}
.lib-search-btn:hover{background:rgba(204,26,26,0.12);}

/* ── EMPTY / LOADING STATES ── */
.empty-state{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;padding:40px;text-align:center;
  min-height:300px;
}
.empty-jp{font-family:var(--font-jp);font-size:48px;color:var(--faint);line-height:1;}
.empty-title{font-size:14px;font-weight:600;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;}
.empty-sub{font-size:12px;color:var(--faint);}

/* Spinner */
.spinner{
  width:32px;height:32px;border-radius:50%;
  border:2.5px solid var(--border);
  border-top-color:var(--red-hot);
  animation:spin 0.7s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── PROVIDER MODAL ── */
.modal-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,0.75);
  z-index:100;display:flex;align-items:center;justify-content:center;
  backdrop-filter:blur(4px);
  animation:fadeIn 0.15s ease;
}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r);width:min(560px,92vw);max-height:70vh;
  display:flex;flex-direction:column;
  box-shadow:0 20px 60px rgba(0,0,0,0.6),0 0 0 1px rgba(204,26,26,0.1);
  position:relative;overflow:hidden;
}
.modal::before{
  content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(to right,var(--red),var(--red-hot),transparent);
}
.modal-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 16px;border-bottom:1px solid var(--border);
}
.modal-title-jp{font-family:var(--font-jp);font-size:15px;font-weight:700;color:var(--text);}
.modal-title-sub{font-size:10px;color:var(--muted);letter-spacing:0.15em;text-transform:uppercase;margin-top:2px;}
.modal-close{
  width:28px;height:28px;border-radius:50%;background:var(--surface2);
  border:1px solid var(--border);cursor:pointer;color:var(--muted);
  display:flex;align-items:center;justify-content:center;
  transition:all var(--tr);font-size:14px;
}
.modal-close:hover{color:#fff;border-color:rgba(204,26,26,0.5);background:rgba(204,26,26,0.15);}
.modal-body{overflow-y:auto;padding:12px 16px;flex:1;}

.provider-group{margin-bottom:14px;}
.provider-group-label{
  font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;
  color:var(--red-hot);margin-bottom:6px;
  display:flex;align-items:center;gap:6px;
}
.provider-group-label::after{content:'';flex:1;height:1px;background:var(--border);}
.provider-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 10px;background:var(--bg);border-radius:3px;margin-bottom:3px;
  border:1px solid var(--border);font-size:12px;
}
.provider-row-title{color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.provider-row-caps{font-size:11px;color:var(--gold);font-weight:600;flex-shrink:0;margin-left:8px;}

/* ── ANILIST PANEL ── */
.anilist-header{
  padding:16px;border-bottom:1px solid var(--border);
  background:linear-gradient(135deg,var(--surface) 0%,var(--bg) 100%);
}
.anilist-header-title{
  font-family:var(--font-jp);font-size:16px;font-weight:700;color:var(--text);
  margin-bottom:10px;
}

/* Close button top right */
.close-panel{
  position:absolute;top:10px;right:12px;z-index:20;
  width:26px;height:26px;border-radius:50%;
  background:var(--surface2);border:1px solid var(--border);
  cursor:pointer;color:var(--muted);display:flex;align-items:center;justify-content:center;
  transition:all var(--tr);font-size:12px;
}
.close-panel:hover{color:#fff;border-color:rgba(204,26,26,0.5);background:rgba(204,26,26,0.15);}

/* ── DECORATIVE BG PATTERN ── */
.bg-deco{
  position:fixed;top:0;right:0;width:300px;height:300px;pointer-events:none;z-index:0;
  opacity:0.025;
  background:radial-gradient(circle at 70% 30%,#cc1a1a 0%,transparent 70%);
}

/* JP watermark */
.jp-watermark{
  position:fixed;bottom:16px;left:16px;z-index:0;pointer-events:none;
  font-family:var(--font-jp);font-size:80px;font-weight:900;
  color:rgba(180,20,20,0.05);line-height:1;user-select:none;
}
</style>
</head>
<body>

<div class="bg-deco"></div>
<div class="jp-watermark">漫画</div>

<!-- TOP BAR -->
<div class="topbar" id="topbar">
  <div class="logo">
    <div class="logo-icon"><img src="https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png" alt="PT Scans"/></div>
    <div class="logo-title">PT<span>Scans</span></div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" data-tab="search" onclick="switchTab('search')">Pesquisa</button>
    <button class="tab-btn" data-tab="library" onclick="switchTab('library')">AniList</button>
  </div>

  <!-- Search mode bar -->
  <div class="search-wrap" id="bar-search">
    <input id="searchInput" class="search-input" type="text" placeholder="Título do manga..." autocomplete="off"
      onkeydown="if(event.key==='Enter')doSearch()"/>
    <button class="search-btn" onclick="doSearch()" aria-label="Pesquisar">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    </button>
  </div>

  <!-- AniList mode bar -->
  <div class="anilist-wrap" id="bar-library" style="display:none;flex:1;">
    <input id="anilistInput" class="anilist-input" type="text" placeholder="Username AniList..." autocomplete="off"
      onkeydown="if(event.key==='Enter')doAniList()"/>
    <button class="btn btn-red" onclick="doAniList()">Carregar</button>
  </div>

  <div style="display:flex;gap:6px;flex-shrink:0;">
    <button class="btn btn-ghost" onclick="doClear()" title="Limpar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
    <button class="btn btn-ghost" onclick="reloadProvider()" title="Recarregar provider">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
    </button>
    <button class="close-panel" onclick="hidePanel()" title="Fechar">✕</button>
  </div>
</div>

<!-- STATUS BAR -->
<div class="statusbar">
  <div class="status-dot" id="statusDot"></div>
  <span class="status-text" id="statusText">Pronto</span>
  <span class="status-count" id="statusCount"></span>
</div>

<!-- MAIN CONTENT -->
<div class="content" id="content">
  <div class="empty-state" id="emptyState">
    <div class="empty-jp">漫画</div>
    <div class="empty-title">PT Scans Search</div>
    <div class="empty-sub">Pesquisa um título para começar</div>
  </div>
  <div class="results-grid" id="resultsGrid" style="display:none;"></div>
  <div class="library-grid" id="libraryGrid" style="display:none;"></div>
</div>

<!-- PROVIDER MODAL -->
<div class="modal-overlay" id="modalOverlay" style="display:none;" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div class="modal-title-jp" id="modalTitle">—</div>
        <div class="modal-title-sub">Disponibilidade nos Providers</div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
let _results     = [];
let _mode        = "search";
let _loading     = false;
let _libraryData = [];
let _modal       = null;

/* ── channel bridge ── */
channel.on("results",       v => { _results = v || []; renderResults(); });
channel.on("status",        v => { updateStatus(v, _loading); });
channel.on("loading",       v => { _loading = v; updateDot(); });
channel.on("query",         v => { const el = document.getElementById("searchInput"); if(el && document.activeElement !== el) el.value = v || ""; });
channel.on("mode",          v => { _mode = v; });
channel.on("libraryData",   v => { _libraryData = v || []; renderLibrary(); });
channel.on("providerModal", v => { _modal = v; renderModal(); });

/* ── UI helpers ── */
function updateStatus(text, isLoading) {
  const t = document.getElementById("statusText");
  const d = document.getElementById("statusDot");
  if(t) t.textContent = text || "";
  if(d) {
    d.className = "status-dot" + (isLoading ? " active" : (text && text.toLowerCase().includes("concluído") ? " done" : ""));
  }
}
function updateDot() {
  const d = document.getElementById("statusDot");
  if(!d) return;
  if(_loading) d.className = "status-dot active";
}
function setCount(n) {
  const c = document.getElementById("statusCount");
  if(c) c.textContent = n > 0 ? n + " resultados" : "";
}

/* ── Tab switch ── */
function switchTab(tab) {
  _mode = tab;
  channel.emit("setMode", tab);
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("bar-search").style.display  = tab === "search"  ? "" : "none";
  document.getElementById("bar-library").style.display = tab === "library" ? "" : "none";
  document.getElementById("resultsGrid").style.display  = "none";
  document.getElementById("libraryGrid").style.display  = "none";
  document.getElementById("emptyState").style.display   = "";
  if(tab === "library" && _libraryData.length) renderLibrary();
  else if(tab === "search" && _results.length) renderResults();
}

/* ── Actions ── */
function doSearch() {
  const q = document.getElementById("searchInput").value.trim();
  if(!q) return;
  channel.emit("search", q);
}
function doAniList() {
  const u = document.getElementById("anilistInput").value.trim();
  if(!u) return;
  channel.emit("fetchAniList", u);
}
function doClear()          { channel.emit("clear"); document.getElementById("searchInput").value = ""; renderEmpty(); }
function hidePanel()        { channel.emit("hide"); }
function reloadProvider()   { channel.emit("reloadProvider"); }
function closeModal()       { channel.emit("closeModal"); }

function renderEmpty() {
  document.getElementById("emptyState").style.display  = "";
  document.getElementById("resultsGrid").style.display  = "none";
  document.getElementById("libraryGrid").style.display  = "none";
  setCount(0);
}

/* ── Render search results ── */
function renderResults() {
  const grid  = document.getElementById("resultsGrid");
  const empty = document.getElementById("emptyState");
  const lib   = document.getElementById("libraryGrid");
  if(!_results.length) { renderEmpty(); return; }
  empty.style.display = "none";
  lib.style.display   = "none";
  grid.style.display  = "";
  setCount(_results.length);
  grid.innerHTML = _results.map(item => {
    const thumb = item.image
      ? \`<img class="card-thumb" src="\${escHtml(item.image)}" alt="\${escHtml(item.title)}" loading="lazy" onerror="this.style.display='none';this.nextSibling.style.display='flex'"/><div class="card-thumb-placeholder" style="display:none">漫</div>\`
      : \`<div class="card-thumb-placeholder">漫</div>\`;
    const badge = item.hasChapters
      ? \`<div class="card-badge">Cap.\${escHtml(String(item.latestChapter||item.chapterCount))}</div>\` : "";
    const caps  = item.hasChapters
      ? \`<span class="card-chapters has">📖 \${item.chapterCount} cap.</span>\`
      : \`<span class="card-chapters">Sem capítulos</span>\`;
    return \`<div class="card" onclick='openModal(\${JSON.stringify(item.title)})'>
      \${badge}\${thumb}
      <div class="card-body">
        <div class="card-title">\${escHtml(item.title)}</div>
        <div class="card-meta">
          <span class="card-source">\${escHtml(item.source)}</span>
          \${caps}
        </div>
      </div>
    </div>\`;
  }).join("");
}

/* ── Render library ── */
function renderLibrary() {
  if(_mode !== "library") return;
  const grid  = document.getElementById("libraryGrid");
  const empty = document.getElementById("emptyState");
  const res   = document.getElementById("resultsGrid");
  if(!_libraryData.length) { renderEmpty(); return; }
  empty.style.display = "none";
  res.style.display   = "none";
  grid.style.display  = "";
  setCount(_libraryData.length);
  grid.innerHTML = _libraryData.map(item => {
    const progress = item.chapters
      ? \`Cap. <strong>\${item.progress||0}</strong> / \${item.chapters}\`
      : \`Cap. <strong>\${item.progress||0}</strong>\`;
    return \`<div class="lib-card">
      <img class="lib-thumb" src="\${escHtml(item.image||'')}" alt="\${escHtml(item.title)}" loading="lazy"/>
      <div class="lib-info">
        <div class="lib-title">\${escHtml(item.title)}</div>
        <div class="lib-progress">\${progress}</div>
        <button class="lib-search-btn" onclick='event.stopPropagation();openModal(\${JSON.stringify(item.title)})'>Pesquisar</button>
      </div>
    </div>\`;
  }).join("");
}

/* ── Provider modal ── */
function openModal(title) {
  channel.emit("searchProviders", title);
}
function renderModal() {
  const overlay = document.getElementById("modalOverlay");
  const titleEl = document.getElementById("modalTitle");
  const bodyEl  = document.getElementById("modalBody");
  if(!_modal) { overlay.style.display = "none"; return; }
  overlay.style.display = "";
  titleEl.textContent = _modal.title || "";
  if(_modal.loading) {
    bodyEl.innerHTML = \`<div style="display:flex;justify-content:center;padding:32px"><div class="spinner"></div></div>\`;
    return;
  }
  if(_modal.error) {
    bodyEl.innerHTML = \`<div style="padding:16px;color:var(--red-hot);font-size:13px">Erro: \${escHtml(_modal.error)}</div>\`;
    return;
  }
  const grouped = _modal.grouped || {};
  const keys = Object.keys(grouped);
  if(!keys.length) {
    bodyEl.innerHTML = \`<div class="empty-state" style="min-height:100px"><div class="empty-title">Sem resultados</div></div>\`;
    return;
  }
  bodyEl.innerHTML = keys.map(k => {
    const g = grouped[k];
    const rows = (g.items||[]).map(i =>
      \`<div class="provider-row">
        <span class="provider-row-title">\${escHtml(i.title)}</span>
        <span class="provider-row-caps">\${i.chapters > 0 ? i.chapters + " cap." : "—"}</span>
      </div>\`
    ).join("");
    return \`<div class="provider-group">
      <div class="provider-group-label">\${escHtml(g.label)}</div>
      \${rows}
    </div>\`;
  }).join("");
}

function escHtml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
</script>
</body>
</html>`);

  }); // end $ui.register
} // end init
