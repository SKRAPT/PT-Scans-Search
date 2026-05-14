function init() {
  $ui.register((ctx) => {
    const BRAND_ICON = "https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png";
    const PROVIDER_MANIFEST_URL =
      "https://raw.githubusercontent.com/SKRAPT/PT-Scans/refs/heads/main/ptscans-provider.json";

    const tray = ctx.newTray({
      tooltipText: "PT Scans Search",
      iconUrl: BRAND_ICON,
      withContent: false
    });

    const panel = ctx.newWebview({
      slot: "fixed",
      width: "100%",
       maxWidth: "900px",
      height: "90vh",
      hidden: true,
      zIndex: 60,
      window: {
        draggable: true,
        defaultPosition: "bottom-right",
        frameless: true
      }
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
            title: stripProviderPrefix(item.title || ""),
            image: item.image || "", year: item.year || null,
            synonyms: safeArray(item.synonyms),
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
      } finally {
        loading.set(false);
      }
    }

    /* ── AniList fetch no host (sem CORS) ── */
    panel.channel.on("fetchAniList", async (username) => {
      if (!username || !username.trim()) { status.set("Insere um nome de utilizador"); return; }
      const user = username.trim();
      status.set("A carregar biblioteca de " + user + "...");
      loading.set(true);
      try {
        const userRes = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: 'query { User(name: "' + user.replace(/"/g, '\\"') + '") { id } }' })
        });
        const userData = await userRes.json();
        if (!userData.data || !userData.data.User) throw new Error("Utilizador não encontrado no AniList");
        const userId = userData.data.User.id;

        const listRes = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "query { MediaListCollection(userId: " + userId + ", type: MANGA, status: CURRENT) { lists { entries { progress media { id chapters title { romaji english } coverImage { large } } } } } }"
          })
        });
        const listData = await listRes.json();
        if (!listData.data || !listData.data.MediaListCollection) throw new Error("Erro ao carregar lista do AniList");
        const entries = (listData.data.MediaListCollection.lists[0] || {}).entries || [];
        libraryData.set(entries.map(e => ({
          id: e.media.id,
          title: e.media.title.english || e.media.title.romaji,
          image: e.media.coverImage.large,
          chapters: e.media.chapters,
          progress: e.progress
        })));
        status.set("Biblioteca carregada — " + entries.length + " mangas");
      } catch (e) {
        libraryData.set([]);
        status.set("Erro AniList: " + (e && e.message ? e.message : "falha"));
      } finally {
        loading.set(false);
      }
    });

    /* ── provider search para modal, no host (sem CORS) ── */
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
          grouped[src].items.push({
            title: stripProviderPrefix(item.title || ""),
            chapters: chapters.length,
            latestChapter: chapters.length ? (chapters[chapters.length - 1].chapter || null) : null
          });
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
    panel.channel.on("hide", () => { panel.hide(); });
    panel.channel.on("clear", () => { queryState.set(""); status.set("Pronto"); loading.set(false); results.set([]); tray.updateBadge({ number: 0 }); });
    panel.channel.on("reloadProvider", () => { providerPromise = null; status.set("Cache limpa"); });
    panel.channel.on("setMode", (m) => { mode.set(m); });
    panel.channel.on("closeModal", () => { providerModal.set(null); });

    /* ════════════════════════════════════════
       WEBVIEW HTML
    ════════════════════════════════════════ */
    panel.setContent(() => `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html { color-scheme: dark; overflow: hidden; }
    :root { --text:#edf4ff; --muted:#98a9c7; --blue:#5ea2ff; --purple:#9b7cff; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { color:var(--text); font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif; background:transparent; overflow:hidden; }

    .overlay {
      position:relative; width:100%; height:100vh; padding:18px; overflow:hidden;
      background: radial-gradient(circle at 12% 12%,rgba(94,162,255,.16),transparent 20%),
                  radial-gradient(circle at 86% 14%,rgba(155,124,255,.12),transparent 20%),
                  linear-gradient(180deg,rgba(3,7,15,.96),rgba(8,12,23,.88));
      backdrop-filter:blur(18px) saturate(140%);
    }
    .blob { position:absolute; width:280px; height:280px; left:-60px; top:-40px; border-radius:999px; filter:blur(40px); pointer-events:none; background:rgba(91,168,255,.18); animation:driftA 14s ease-in-out infinite; }
    .blob::before { content:""; position:absolute; width:210px; height:210px; left:980px; top:80px; border-radius:999px; filter:blur(40px); background:rgba(164,118,255,.14); animation:driftB 16s ease-in-out infinite; }
    .blob::after  { content:""; position:absolute; width:240px; height:240px; left:460px; top:520px; border-radius:999px; filter:blur(40px); background:rgba(86,234,181,.10); animation:driftC 18s ease-in-out infinite; }
    @keyframes driftA{0%,100%{transform:translate3d(0,0,0) scale(1);}50%{transform:translate3d(60px,35px,0) scale(1.08);}}
    @keyframes driftB{0%,100%{transform:translate3d(0,0,0) scale(1);}50%{transform:translate3d(-70px,25px,0) scale(1.12);}}
    @keyframes driftC{0%,100%{transform:translate3d(0,0,0) scale(1);}50%{transform:translate3d(35px,-55px,0) scale(1.06);}}

    .window {
      position:relative; width:100%; height:calc(86vh - 6px); border-radius:32px; overflow:hidden;
      background:radial-gradient(circle at top left,rgba(10,20,50,.35),transparent 32%),linear-gradient(180deg,rgba(18,24,42,.94),rgba(8,12,23,.85));
      border:1px solid rgba(94,162,255,.18); box-shadow:0 30px 90px rgba(0,0,0,.43),inset 0 1px 1px rgba(255,255,255,.03);
      backdrop-filter:blur(18px); animation:fadeUp .35s ease;
    }
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px) scale(.988);}to{opacity:1;transform:none;}}
    .shine { position:absolute; inset:0 auto auto -20%; width:45%; height:2px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent); opacity:.45; animation:shine 5.6s linear infinite; }
    @keyframes shine{from{transform:translateX(-15%);}to{transform:translateX(250%);}}

    .topbar { display:flex; align-items:center; gap:14px; padding:18px 20px; border-bottom:1px solid rgba(255,255,255,.08); background:rgba(7,11,24,.55); backdrop-filter:blur(20px); }
    .brand { display:flex; align-items:center; gap:14px; min-width:200px; }
    .brand-logo-wrap { position:relative; width:54px; height:54px; border-radius:18px; display:grid; place-items:center; background:linear-gradient(135deg,rgba(94,162,255,.26),rgba(155,124,255,.22)); border:1px solid rgba(255,255,255,.14); overflow:hidden; }
    .brand-logo-wrap::after { content:""; position:absolute; inset:-20%; background:conic-gradient(from 180deg,transparent,rgba(255,255,255,.18),transparent 35%); animation:spinConic 6s linear infinite; }
    @keyframes spinConic{to{transform:rotate(360deg);}}
    .brand-logo { position:relative; z-index:1; width:34px; height:34px; object-fit:contain; }
    .brand-title { font-size:17px; font-weight:800; color:#f8fbff; }

    .searchbar { flex:1; display:flex; gap:10px; min-width:0; align-items:center; background:rgba(255,255,255,.04); border-radius:18px; padding:10px; border:1px solid rgba(255,255,255,.08); backdrop-filter:blur(16px); }
    .search-shell { flex:1; position:relative; min-width:0; }
    .search-shell::before { content:"⌕"; position:absolute; left:14px; top:50%; transform:translateY(-50%); color:#9bb8eb; font-size:15px; pointer-events:none; }
    .searchbar input { width:100%; height:50px; border-radius:16px; border:1px solid rgba(255,255,255,.09); background:rgba(6,10,19,.42); color:white; padding:0 16px 0 40px; outline:none; font-size:14px; transition:all .3s cubic-bezier(0.34,1.56,0.64,1); }
    .searchbar input:focus { border-color:rgba(94,162,255,.6); box-shadow:0 0 0 4px rgba(94,162,255,.15),0 8px 24px rgba(94,162,255,.15); background:rgba(7,12,24,.65); transform:translateY(-2px); }
    .searchbar input::placeholder { color:rgba(155,177,227,.6); }

    .btn { height:50px; border-radius:16px; border:1px solid rgba(255,255,255,.09); padding:0 16px; color:white; cursor:pointer; font-weight:800; font-size:13px; background:rgba(255,255,255,.045); font-family:inherit; transition:transform .2s cubic-bezier(0.34,1.56,0.64,1),background .2s,border-color .2s,box-shadow .3s; }
    .btn:hover { transform:translateY(-2px) scale(1.02); background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.2); box-shadow:0 12px 30px rgba(255,255,255,.1); }
    .btn:active { transform:translateY(0) scale(0.98); }
    .btn-primary { background:linear-gradient(135deg,#3b82f6,#2563eb); border-color:rgba(108,164,255,.6); box-shadow:0 14px 28px rgba(37,99,235,.28); color:#fff; }
    .btn-primary:hover { background:linear-gradient(135deg,#5b9bff,#3b7fd4); box-shadow:0 18px 40px rgba(37,99,235,.42); transform:translateY(-3px) scale(1.03); }

    .meta { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 20px; border-bottom:1px solid rgba(255,255,255,.05); color:var(--muted); font-size:13px; background:rgba(255,255,255,.02); }
    .status-wrap { display:inline-flex; align-items:center; gap:10px; }
    .status-dot { width:9px; height:9px; border-radius:999px; background:var(--blue); box-shadow:0 0 18px rgba(94,162,255,.8); animation:pulseDot 1.3s ease-in-out infinite; flex-shrink:0; }
    @keyframes pulseDot{0%,100%{transform:scale(.88);opacity:.6;}50%{transform:scale(1.2);opacity:1;}}
    .pill { display:inline-flex; align-items:center; border-radius:999px; padding:9px 13px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1); color:#dbe7ff; }

    .filters { display:flex; gap:10px; padding:12px 20px 0; flex-wrap:wrap; }
    .filter-chip { border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.04); color:#d7e5ff; height:38px; padding:0 14px; border-radius:999px; cursor:pointer; font-size:12px; font-weight:800; font-family:inherit; transition:all .25s cubic-bezier(0.34,1.56,0.64,1); }
    .filter-chip:hover { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.15); transform:translateY(-2px); }
    .filter-chip.active { background:linear-gradient(135deg,rgba(59,130,246,.25),rgba(147,51,234,.2)); border-color:rgba(94,162,255,.5); color:#fff; box-shadow:0 12px 30px rgba(59,130,246,.22); transform:translateY(-3px); }

    .content { position:relative; padding:18px 20px 22px; height:calc(100% - 186px); overflow:auto; scroll-behavior:smooth; background:rgba(8,12,22,.5); border-radius:0 0 32px 32px; border-top:1px solid rgba(255,255,255,.06); }
    .content::-webkit-scrollbar{width:10px;} .content::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:999px;}

    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(350px,1fr)); gap:18px; }
    .card { position:relative; display:flex; gap:14px; padding:14px; min-height:190px; border-radius:24px; background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.025)),rgba(13,18,30,.72); border:1px solid rgba(255,255,255,.08); box-shadow:0 8px 24px rgba(0,0,0,.2),inset 0 1px 1px rgba(255,255,255,.05); transition:transform .3s cubic-bezier(0.34,1.56,0.64,1),border-color .3s,box-shadow .3s; overflow:hidden; animation:cardIn .35s ease both; }
    .card:nth-child(1){animation-delay:.02s}.card:nth-child(2){animation-delay:.04s}.card:nth-child(3){animation-delay:.06s}.card:nth-child(4){animation-delay:.08s}.card:nth-child(5){animation-delay:.10s}.card:nth-child(6){animation-delay:.12s}
    @keyframes cardIn{from{opacity:0;transform:translateY(12px) scale(.985);}to{opacity:1;transform:none;}}
    .card:hover { transform:translateY(-6px) scale(1.01); border-color:rgba(110,170,255,.3); box-shadow:0 20px 50px rgba(37,99,235,.25); }

    .cover,.fallback { width:106px; height:150px; border-radius:18px; flex-shrink:0; }
    .cover { object-fit:cover; background:rgba(7,10,18,.55); border:1px solid rgba(255,255,255,.07); }
    .fallback { border:1px solid rgba(255,255,255,.07); background:linear-gradient(180deg,rgba(20,27,43,.95),rgba(9,12,20,.95)); display:flex; align-items:center; justify-content:center; color:#8ea2c5; font-size:12px; text-align:center; padding:12px; }
    .info { min-width:0; width:100%; display:flex; flex-direction:column; justify-content:space-between; }
    .card-title { font-size:17px; font-weight:800; line-height:1.34; margin-bottom:10px; color:#f7fbff; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .stats { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
    .chip { display:inline-flex; align-items:center; border-radius:999px; padding:7px 11px; font-size:12px; font-weight:800; border:1px solid rgba(255,255,255,.06); background:rgba(255,255,255,.05); color:#d8e4fb; }
    .chip.ok  { color:#c8ffe0; background:linear-gradient(135deg,rgba(34,197,94,.15),rgba(34,197,94,.08)); border-color:rgba(34,197,94,.25); }
    .chip.no  { color:#ffd0d8; background:linear-gradient(135deg,rgba(239,68,68,.15),rgba(239,68,68,.08)); border-color:rgba(239,68,68,.25); }
    .chip.src { color:#d5e7ff; background:linear-gradient(135deg,rgba(59,130,246,.15),rgba(59,130,246,.08)); border-color:rgba(59,130,246,.25); }
    .sub { color:var(--muted); font-size:12px; line-height:1.45; word-break:break-word; opacity:.95; }

    .provider-btn { margin-top:10px; width:100%; cursor:pointer; font-family:inherit; font-weight:800; font-size:12px; padding:9px 12px; border-radius:12px; background:linear-gradient(135deg,rgba(94,162,255,.12),rgba(155,124,255,.08)); border:1px solid rgba(94,162,255,.28); color:#8ec6ff; transition:all .25s cubic-bezier(0.34,1.56,0.64,1); }
    .provider-btn:hover { background:linear-gradient(135deg,rgba(94,162,255,.24),rgba(155,124,255,.18)); border-color:rgba(94,162,255,.55); color:#c4e0ff; box-shadow:0 8px 20px rgba(94,162,255,.18); transform:translateY(-2px); }

    .empty { display:flex; align-items:center; justify-content:center; min-height:380px; border-radius:26px; border:2px dashed rgba(94,162,255,.2); background:radial-gradient(circle at top,rgba(94,162,255,.08),transparent 36%),linear-gradient(135deg,rgba(255,255,255,.02),rgba(255,255,255,.01)); color:#9db1d3; text-align:center; padding:32px; animation:fadeUp .4s ease; }
    .empty-box { max-width:460px; }
    .empty-logo { width:70px; height:70px; object-fit:contain; opacity:.94; margin-bottom:14px; animation:floaty 3s ease-in-out infinite; }
    @keyframes floaty{0%,100%{transform:translateY(0);}50%{transform:translateY(-5px);}}
    .loading-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(350px,1fr)); gap:18px; }
    .skeleton { position:relative; min-height:190px; border-radius:24px; overflow:hidden; background:rgba(13,18,30,.6); border:1px solid rgba(255,255,255,.07); }
    .skeleton::after { content:""; position:absolute; inset:0; transform:translateX(-100%); background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent); animation:skelSlide 1.4s infinite; }
    @keyframes skelSlide{100%{transform:translateX(100%);}}

    /* library */
    .lib-header { display:flex; gap:10px; margin-bottom:20px; align-items:center; }
    .lib-input { flex:1; height:50px; border-radius:16px; border:1px solid rgba(255,255,255,.09); background:rgba(6,10,19,.42); color:white; padding:0 16px; outline:none; font-size:14px; font-family:inherit; transition:border-color .3s,background .3s; }
    .lib-input:focus { border-color:rgba(94,162,255,.6); background:rgba(7,12,24,.65); box-shadow:0 0 0 4px rgba(94,162,255,.15); }
    .lib-input::placeholder { color:rgba(155,177,227,.6); }
    .progress-wrap { margin:8px 0 4px; }
    .progress-label { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:5px; }
    .progress-bar { height:5px; border-radius:999px; background:rgba(255,255,255,.08); overflow:hidden; }
    .progress-fill { height:100%; border-radius:999px; background:linear-gradient(90deg,#3b82f6,#9b7cff); transition:width .6s ease; }

    /* ══ MODAL ══ */
    .modal-overlay { position:fixed; inset:0; z-index:900; background:rgba(0,0,0,.65); backdrop-filter:blur(12px); display:flex; align-items:center; justify-content:center; animation:overlayIn .2s ease; }
    @keyframes overlayIn{from{opacity:0;}to{opacity:1;}}
    .modal-box { width:min(96vw,700px); max-height:84vh; border-radius:28px; overflow:hidden; background:linear-gradient(160deg,rgba(11,17,33,.99),rgba(5,8,18,.98)); border:1px solid rgba(94,162,255,.2); box-shadow:0 40px 100px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05); display:flex; flex-direction:column; animation:modalIn .3s cubic-bezier(0.34,1.56,0.64,1); }
    @keyframes modalIn{from{opacity:0;transform:scale(.86) translateY(24px);}to{opacity:1;transform:none;}}

    .modal-head { padding:24px 28px 18px; border-bottom:1px solid rgba(255,255,255,.07); background:rgba(255,255,255,.025); position:relative; flex-shrink:0; }
    .modal-eyebrow { font-size:10px; font-weight:900; letter-spacing:.15em; text-transform:uppercase; color:var(--blue); margin-bottom:6px; opacity:.75; }
    .modal-manga-title { font-size:21px; font-weight:900; color:#eef4ff; line-height:1.3; padding-right:44px; }

    .modal-close { position:absolute; top:20px; right:20px; width:36px; height:36px; border-radius:12px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.06); color:#9bb8eb; font-size:17px; cursor:pointer; display:grid; place-items:center; transition:all .2s; line-height:1; }
    .modal-close:hover { background:rgba(239,68,68,.18); border-color:rgba(239,68,68,.4); color:#fca5a5; }

    .modal-body { flex:1; overflow-y:auto; padding:18px 24px 20px; }
    .modal-body::-webkit-scrollbar{width:8px;} .modal-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:999px;}

    .modal-foot { padding:14px 24px; border-top:1px solid rgba(255,255,255,.06); background:rgba(255,255,255,.02); flex-shrink:0; }

    .modal-loading { display:flex; align-items:center; justify-content:center; gap:14px; padding:48px 20px; color:var(--muted); font-size:14px; }
    .spin { width:22px; height:22px; border:3px solid rgba(94,162,255,.2); border-top-color:#5ea2ff; border-radius:50%; animation:spinAnim 1s linear infinite; }
    @keyframes spinAnim{to{transform:rotate(360deg);}}
    .modal-empty { text-align:center; padding:48px 20px; color:var(--muted); font-size:14px; }

    /* source blocks */
    .src-block { margin-bottom:12px; border-radius:20px; overflow:hidden; border:1px solid rgba(255,255,255,.07); background:rgba(255,255,255,.025); animation:srcIn .3s ease both; }
    .src-block:nth-child(1){animation-delay:.03s}.src-block:nth-child(2){animation-delay:.07s}.src-block:nth-child(3){animation-delay:.11s}.src-block:nth-child(4){animation-delay:.15s}.src-block:nth-child(5){animation-delay:.19s}
    @keyframes srcIn{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}

    .src-header { display:flex; align-items:center; gap:12px; padding:14px 18px; background:rgba(255,255,255,.04); border-bottom:1px solid rgba(255,255,255,.05); }
    .src-dot { width:10px; height:10px; border-radius:999px; flex-shrink:0; }
    .src-name { font-size:14px; font-weight:900; color:#e8f2ff; flex:1; }
    .src-count { font-size:11px; font-weight:800; padding:4px 10px; border-radius:999px; background:rgba(94,162,255,.14); border:1px solid rgba(94,162,255,.22); color:#93c5fd; }

    .src-items { padding:4px 0; }
    .src-item { display:flex; align-items:center; gap:12px; padding:10px 18px; transition:background .2s; }
    .src-item:hover { background:rgba(255,255,255,.04); }
    .src-item-title { flex:1; font-size:13px; color:#c0d3ef; line-height:1.4; }
    .src-item-latest { font-size:11px; color:#576d8a; flex-shrink:0; white-space:nowrap; }
    .src-item-badge { flex-shrink:0; font-size:11px; font-weight:900; padding:4px 10px; border-radius:999px; background:rgba(52,211,153,.11); border:1px solid rgba(52,211,153,.22); color:#6ee7b7; white-space:nowrap; }
    .src-item-badge.zero { background:rgba(239,68,68,.1); border-color:rgba(239,68,68,.2); color:#fca5a5; }

    /* source dot colors */
    .c-mangaflix  { background:#3b82f6; }
    .c-mangalivre { background:#8b5cf6; }
    .c-hipercool  { background:#ec4899; }
    .c-tiamanhwa  { background:#f59e0b; }
    .c-mangafire  { background:#ef4444; }
    .c-unknown    { background:#6b7280; }

    @media(max-width:920px){.topbar{flex-direction:column;align-items:stretch;}.searchbar{width:100%;flex-wrap:wrap;}.btn{flex:1;}.content{height:calc(100% - 230px);}}
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
            <img class="brand-logo" src="${BRAND_ICON}" alt="PT Scans" />
          </div>
          <div><div class="brand-title">PT Scans Search</div></div>
        </div>
        <div class="searchbar">
          <div class="search-shell"><input id="query" placeholder="Pesquisar manga..." /></div>
          <button id="searchBtn" class="btn btn-primary">Pesquisar</button>
          <button id="reloadBtn" class="btn">↺ Reload</button>
          <button id="clearBtn"  class="btn">Limpar</button>
          <button id="closeBtn"  class="btn">✕ Fechar</button>
        </div>
        <button id="libraryBtn" class="btn">📚 Biblioteca</button>
      </div>

      <div class="meta">
        <div class="status-wrap">
          <div class="status-dot"></div>
          <div id="statusText">Pronto</div>
        </div>
        <div class="pill" id="resultMeta">0 resultados</div>
      </div>

      <div class="filters" id="sourceFilters"></div>
      <div class="content"><div id="app"></div></div>
    </div>
  </div>

  <div id="modalMount"></div>

  <script>
    const BRAND_ICON = ${JSON.stringify(BRAND_ICON)};

    const state = {
      results:[], status:"Pronto", loading:false, query:"",
      sourceFilter:"all", mode:"search",
      libraryData:[], libraryUser:"",
      providerModal:null
    };

    function esc(v) {
      return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
    }
    function safeArray(v){ return Array.isArray(v)?v:[]; }
    function getItemSource(item){
      if(item.rawSource) return item.rawSource;
      const raw=String(item.id||""); const idx=raw.indexOf(":");
      return idx!==-1?raw.slice(0,idx):"unknown";
    }
    function srcColorClass(src){
      const m={mangaflix:"c-mangaflix",mangalivre:"c-mangalivre",hipercool:"c-hipercool",tiamanhwa:"c-tiamanhwa",mangafire:"c-mangafire"};
      return m[src]||"c-unknown";
    }

    /* filters */
    function buildSourceCounts(items){
      const c={all:items.length,mangaflix:0,mangalivre:0,hipercool:0,tiamanhwa:0,mangafire:0};
      items.forEach(i=>{const s=getItemSource(i);if(c[s]!=null)c[s]++;});
      return c;
    }
    function renderFilters(items){
      const wrap=document.getElementById("sourceFilters"); if(!wrap) return;
      const c=buildSourceCounts(items);
      const defs=[{key:"all",label:"Todos"},{key:"mangaflix",label:"MangaFlix"},{key:"mangalivre",label:"MangaLivre"},{key:"hipercool",label:"HiperCool"},{key:"tiamanhwa",label:"TiaManhwa"},{key:"mangafire",label:"MangaFire"}];
      wrap.innerHTML=defs.map(d=>'<button class="filter-chip'+(state.sourceFilter===d.key?" active":"")+'" data-source="'+d.key+'">'+esc(d.label)+' ('+(c[d.key]||0)+')</button>').join("");
      wrap.querySelectorAll(".filter-chip").forEach(btn=>btn.addEventListener("click",()=>{state.sourceFilter=btn.dataset.source||"all";render();}));
    }

    /* ── MODAL ── */
    function renderModal(){
      const mount=document.getElementById("modalMount");
      const m=state.providerModal;
      if(!m){mount.innerHTML="";return;}

      let bodyHtml="";
      if(m.loading){
        bodyHtml='<div class="modal-loading"><div class="spin"></div><span>A pesquisar em todos os providers...</span></div>';
      } else if(m.error){
        bodyHtml='<div class="modal-empty">❌ '+esc(m.error)+'</div>';
      } else {
        const srcs=Object.keys(m.grouped||{});
        if(srcs.length===0){
          bodyHtml='<div class="modal-empty">Nenhum provider encontrou este título.</div>';
        } else {
          bodyHtml=srcs.map(src=>{
            const d=m.grouped[src];
            const colorClass=srcColorClass(src);
            const itemsHtml=d.items.map(item=>{
              const zero=item.chapters===0;
              const latest=item.latestChapter?"cap "+esc(String(item.latestChapter)):"";
              return '<div class="src-item">'+
                '<div class="src-item-title">'+esc(item.title)+'</div>'+
                (latest?'<div class="src-item-latest">Último: '+latest+'</div>':'')+
                '<div class="src-item-badge'+(zero?" zero":"")+'">'+item.chapters+' cap'+(item.chapters===1?"":"s")+'</div>'+
              '</div>';
            }).join("");
            return '<div class="src-block">'+
              '<div class="src-header">'+
                '<div class="src-dot '+colorClass+'"></div>'+
                '<div class="src-name">'+esc(d.label)+'</div>'+
                '<div class="src-count">'+d.items.length+(d.items.length===1?" resultado":" resultados")+'</div>'+
              '</div>'+
              '<div class="src-items">'+itemsHtml+'</div>'+
            '</div>';
          }).join("");
        }
      }

      mount.innerHTML=
        '<div class="modal-overlay" id="modalOverlay">'+
          '<div class="modal-box">'+
            '<div class="modal-head">'+
              '<button class="modal-close" id="modalCloseX">✕</button>'+
              '<div class="modal-eyebrow">Providers disponíveis</div>'+
              '<div class="modal-manga-title">'+esc(m.title)+'</div>'+
            '</div>'+
            '<div class="modal-body">'+bodyHtml+'</div>'+
            '<div class="modal-foot">'+
              '<button id="modalFootClose" class="btn btn-primary" style="width:100%;">Fechar</button>'+
            '</div>'+
          '</div>'+
        '</div>';

      document.getElementById("modalCloseX").addEventListener("click",closeModal);
      document.getElementById("modalFootClose").addEventListener("click",closeModal);
      document.getElementById("modalOverlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closeModal();});
    }

    function closeModal(){
      state.providerModal=null;
      renderModal();
      window.webview.send("closeModal");
    }
    function openProviderModal(title){
      state.providerModal={title,loading:true,grouped:{}};
      renderModal();
      window.webview.send("searchProviders",title);
    }

    /* ── LIBRARY ── */
    function renderLibrary(){
      let html='<div style="padding:20px;">';
      html+='<div class="lib-header">';
      html+='<input id="libUserInput" class="lib-input" placeholder="Nome de utilizador AniList" value="'+esc(state.libraryUser)+'" />';
      html+='<button id="loadLibBtn" class="btn btn-primary">Carregar</button>';
      html+='<button id="backBtn" class="btn">← Pesquisa</button>';
      html+='</div>';

      if(state.loading){
        html+='<div class="loading-grid">'+Array.from({length:6}).map(()=>'<div class="skeleton"></div>').join("")+'</div>';
      } else if(state.libraryData.length>0){
        html+='<div class="grid">';
        state.libraryData.forEach(item=>{
          const pct=(item.chapters&&item.chapters>0)?Math.min(100,Math.round((item.progress/item.chapters)*100)):0;
          const chText=item.chapters?String(item.chapters):"?";
          const coverHtml=item.image?'<img class="cover" src="'+esc(item.image)+'" alt="'+esc(item.title)+'" />':'<div class="fallback">Sem capa</div>';
          html+='<div class="card">'+coverHtml+
            '<div class="info"><div>'+
              '<div class="card-title">'+esc(item.title)+'</div>'+
              '<div class="stats">'+
                '<div class="chip src">AniList</div>'+
                '<div class="chip">'+esc(String(item.progress))+' / '+esc(chText)+' caps</div>'+
              '</div>'+
              '<div class="progress-wrap">'+
                '<div class="progress-label"><span>Progresso</span><span>'+pct+'%</span></div>'+
                '<div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%"></div></div>'+
              '</div>'+
            '</div>'+
            '<button class="provider-btn" data-title="'+esc(item.title)+'">🔍 Ver Providers</button>'+
            '</div></div>';
        });
        html+='</div>';
      } else {
        html+='<div class="empty"><div class="empty-box">'+
          '<img class="empty-logo" src="'+esc(BRAND_ICON)+'" alt="PT Scans" />'+
          '<div style="font-size:18px;font-weight:800;color:#f4f8ff;margin-bottom:8px;">Biblioteca AniList</div>'+
          '<div style="font-size:13px;line-height:1.6;color:#9db1d3;">Insere o teu utilizador AniList para carregar a lista de leitura.</div>'+
        '</div></div>';
      }
      html+='</div>';
      return html;
    }

    function attachLibraryEvents(){
      const loadBtn=document.getElementById("loadLibBtn");
      const backBtn=document.getElementById("backBtn");
      if(loadBtn){
        loadBtn.addEventListener("click",()=>{
          const inp=document.getElementById("libUserInput");
          const user=inp?inp.value.trim():"";
          if(!user){state.status="Insere um nome de utilizador";render();return;}
          state.libraryUser=user;
          window.webview.send("fetchAniList",user);
        });
      }
      if(backBtn) backBtn.addEventListener("click",()=>window.webview.send("setMode","search"));
      document.querySelectorAll(".provider-btn").forEach(btn=>
        btn.addEventListener("click",()=>openProviderModal(btn.dataset.title))
      );
    }

    /* ── MAIN RENDER ── */
    function renderSkeletons(){ return '<div class="loading-grid">'+Array.from({length:6}).map(()=>'<div class="skeleton"></div>').join("")+'</div>'; }

    function render(){
      const app=document.getElementById("app");
      const statusText=document.getElementById("statusText");
      const resultMeta=document.getElementById("resultMeta");
      const input=document.getElementById("query");

      statusText.textContent=state.status||"Pronto";
      if(document.activeElement!==input) input.value=state.query||"";

      if(state.mode==="library"){
        resultMeta.textContent=state.libraryData.length+" mangas";
        renderFilters([]);
        app.innerHTML=renderLibrary();
        attachLibraryEvents();
        return;
      }

      const all=safeArray(state.results);
      const filtered=state.sourceFilter==="all"?all:all.filter(i=>getItemSource(i)===state.sourceFilter);
      resultMeta.textContent=filtered.length+" resultados";
      renderFilters(all);

      if(state.loading&&all.length===0){app.innerHTML=renderSkeletons();return;}

      if(filtered.length===0){
        app.innerHTML='<div class="empty"><div class="empty-box">'+
          '<img class="empty-logo" src="'+esc(BRAND_ICON)+'" alt="PT Scans" />'+
          '<div style="font-size:18px;font-weight:800;color:#f4f8ff;margin-bottom:8px;">PT Scans</div>'+
          '<div style="font-size:13px;line-height:1.6;color:#9db1d3;">'+(all.length===0?"Pesquisa um título para começar.":"Sem resultados para este filtro.")+'</div>'+
        '</div></div>';
        return;
      }

      app.innerHTML='<div class="grid">'+filtered.map(item=>{
        const cover=item.image?'<img class="cover" src="'+esc(item.image)+'" alt="'+esc(item.title)+'" />':'<div class="fallback">Sem capa</div>';
        return '<div class="card">'+cover+
          '<div class="info"><div>'+
            '<div class="card-title">'+esc(item.title)+'</div>'+
            '<div class="stats">'+
              '<div class="chip src">'+esc(item.source||getItemSource(item))+'</div>'+
              '<div class="chip '+(item.hasChapters?"ok":"no")+'">'+(item.hasChapters?"✓ Com caps":"✗ Sem caps")+'</div>'+
              '<div class="chip">Total: '+esc(item.chapterCount)+'</div>'+
              '<div class="chip">Último: '+esc(item.latestChapter||"—")+'</div>'+
              (item.year?'<div class="chip">'+esc(item.year)+'</div>':'')+
            '</div>'+
          '</div>'+
          '<div class="sub">'+esc(item.id||"")+'</div>'+
          '</div></div>';
      }).join("")+'</div>';
    }

    /* topbar */
    function attachTopbarEvents(){
      document.getElementById("searchBtn").addEventListener("click",()=>window.webview.send("search",document.getElementById("query").value));
      document.getElementById("query").addEventListener("keydown",e=>{if(e.key==="Enter")window.webview.send("search",e.target.value);});
      document.getElementById("clearBtn").addEventListener("click",()=>{document.getElementById("query").value="";state.sourceFilter="all";window.webview.send("clear");});
      document.getElementById("closeBtn").addEventListener("click",()=>window.webview.send("hide"));
      document.getElementById("reloadBtn").addEventListener("click",()=>window.webview.send("reloadProvider"));
      document.getElementById("libraryBtn").addEventListener("click",()=>window.webview.send("setMode","library"));
    }

    /* canal webview */
    window.webview.on("results",       v=>{state.results=v||[];render();});
    window.webview.on("status",        v=>{state.status=v||"Pronto";render();});
    window.webview.on("loading",       v=>{state.loading=!!v;render();});
    window.webview.on("query",         v=>{state.query=v||"";render();});
    window.webview.on("mode",          v=>{state.mode=v;render();});
    window.webview.on("libraryData",   v=>{state.libraryData=v||[];render();});
    window.webview.on("providerModal", v=>{
      if(v!==null&&state.providerModal!==null){state.providerModal=v;renderModal();}
      else if(v===null){state.providerModal=null;renderModal();}
    });

    attachTopbarEvents();
    render();
  </script>
</body>
</html>
    `);
  });
}
