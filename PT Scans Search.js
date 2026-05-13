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
        .replace(/^\s*\[(MangaFlix|MangaLivre|HiperCool|TiaManhwa|MangaFire)\]\s*/i, "")
        .replace(/^\s*(MangaFlix|MangaLivre|HiperCool|TiaManhwa|MangaFire)\s*[•\-:]\s*/i, "")
        .trim();
    }

    function safeArray(value) {
      return Array.isArray(value) ? value : [];
    }

    async function getProvider() {
      if (providerPromise) return providerPromise;
      providerPromise = (async () => {
        const res = await fetch(PROVIDER_MANIFEST_URL, {
          headers: { Accept: "application/json, text/plain, */*" }
        });
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
          try { chapters = safeArray(await provider.findChapters(item.id)); } catch (e) {}
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
            hasChapters: chapters.length > 0,
            chapterCount: chapters.length,
            latestChapter: chapters.length ? (chapters[chapters.length - 1].chapter || null) : null
          };
        })
      );
      const ok = detailed.filter(e => e.status === "fulfilled").map(e => e.value);
      if (items.length > limited.length) {
        const rest = items.slice(limited.length).map((item) => {
          const src = splitSourceId(item.id).source;
          return {
            id: item.id, source: sourceLabel(src), rawSource: src,
            title: stripProviderPrefix(item.title || ""), originalTitle: item.title || "",
            image: item.image || "", year: item.year || null, synonyms: safeArray(item.synonyms),
            hasChapters: false, chapterCount: 0, latestChapter: null
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
        status.set("A pesquisar...");
        let found = safeArray(await provider.search({ query }));
        found = found.slice(0, 40);
        status.set("A obter capítulos...");
        const enriched = await enrichWithChapters(provider, found);
        results.set(enriched);
        const withCaps = enriched.filter(item => item.hasChapters).length;
        tray.updateBadge({ number: enriched.length, intent: withCaps > 0 ? "info" : "warning" });
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

    tray.onClick(() => { panel.show(); });
    panel.channel.on("search", async (query) => { await runSearch(query || ""); });
    panel.channel.on("hide", () => { panel.hide(); });
    panel.channel.on("clear", () => {
      queryState.set(""); status.set("Pronto");
      loading.set(false); results.set([]);
      tray.updateBadge({ number: 0 });
    });
    panel.channel.on("reloadProvider", async () => {
      providerPromise = null;
      status.set("Cache limpa");
    });

    panel.setContent(() => `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-deep:    rgba(4, 6, 14, 0.92);
      --bg-mid:     rgba(8, 11, 22, 0.78);
      --bg-panel:   rgba(12, 16, 30, 0.70);
      --bg-card:    rgba(16, 22, 40, 0.64);
      --bg-input:   rgba(255,255,255, 0.05);

      --border-dim: rgba(255,255,255, 0.07);
      --border-glow:rgba(100,160,255, 0.22);

      --text-bright:#eef3ff;
      --text-mid:   #a8b8d8;
      --text-dim:   #606c88;

      --accent-a:   #4f8dff;
      --accent-b:   #a06cff;
      --accent-c:   #38e8b8;

      --blur-heavy: blur(36px) saturate(160%);
      --blur-mid:   blur(20px) saturate(140%);
      --blur-light: blur(10px) saturate(120%);

      --radius-xl:  28px;
      --radius-lg:  20px;
      --radius-md:  14px;
      --radius-sm:  10px;
      --radius-pill:999px;

      --shadow-deep: 0 32px 80px rgba(0,0,0,0.55), 0 8px 20px rgba(0,0,0,0.35);
      --shadow-card: 0 12px 32px rgba(0,0,0,0.30);
      --shadow-glow: 0 0 30px rgba(79,141,255,0.18);

      --font-display: 'Syne', sans-serif;
      --font-body:    'DM Sans', sans-serif;

      --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
    }

    html { color-scheme: dark; overflow: hidden; }

    body {
      font-family: var(--font-body);
      font-size: 13px;
      color: var(--text-bright);
      background: transparent;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* ─── AMBIENT BACKGROUND ─── */
    .ambient {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
    }

    .orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(80px);
      will-change: transform;
    }

    .orb-1 {
      width: 520px; height: 520px;
      left: -140px; top: -160px;
      background: radial-gradient(circle, rgba(60,110,255,0.28) 0%, transparent 70%);
      animation: orbDrift1 20s ease-in-out infinite;
    }

    .orb-2 {
      width: 420px; height: 420px;
      right: -100px; top: -80px;
      background: radial-gradient(circle, rgba(140,80,255,0.22) 0%, transparent 70%);
      animation: orbDrift2 17s ease-in-out infinite;
    }

    .orb-3 {
      width: 360px; height: 360px;
      left: 38%; bottom: -100px;
      background: radial-gradient(circle, rgba(30,200,140,0.14) 0%, transparent 70%);
      animation: orbDrift3 23s ease-in-out infinite;
    }

    .orb-4 {
      width: 280px; height: 280px;
      right: 20%; top: 40%;
      background: radial-gradient(circle, rgba(255,120,80,0.10) 0%, transparent 70%);
      animation: orbDrift4 19s ease-in-out infinite;
    }

    @keyframes orbDrift1 {
      0%,100% { transform: translate(0px, 0px) scale(1); }
      33%  { transform: translate(80px, 60px) scale(1.06); }
      66%  { transform: translate(-30px, 90px) scale(0.94); }
    }
    @keyframes orbDrift2 {
      0%,100% { transform: translate(0px, 0px) scale(1); }
      40%  { transform: translate(-90px, 40px) scale(1.08); }
      70%  { transform: translate(30px, -60px) scale(0.95); }
    }
    @keyframes orbDrift3 {
      0%,100% { transform: translate(0px, 0px) scale(1); }
      50%  { transform: translate(60px, -70px) scale(1.1); }
    }
    @keyframes orbDrift4 {
      0%,100% { transform: translate(0px, 0px); }
      50%  { transform: translate(-50px, 40px); }
    }

    /* ─── NOISE GRAIN OVERLAY ─── */
    .noise {
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0.028;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 200px 200px;
    }

    /* ─── WRAPPER ─── */
    .wrapper {
      position: relative;
      width: 100%;
      height: 100vh;
      padding: 16px;
      display: flex;
      align-items: stretch;
    }

    /* ─── WINDOW ─── */
    .window {
      position: relative;
      width: 100%;
      border-radius: var(--radius-xl);
      overflow: hidden;
      background: var(--bg-panel);
      border: 1px solid var(--border-dim);
      box-shadow: var(--shadow-deep);
      backdrop-filter: var(--blur-heavy);
      -webkit-backdrop-filter: var(--blur-heavy);
      display: flex;
      flex-direction: column;
      animation: windowIn 0.5s var(--ease-spring) both;
    }

    @keyframes windowIn {
      from { opacity: 0; transform: translateY(20px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0px) scale(1); }
    }

    /* top edge highlight */
    .window::before {
      content: "";
      position: absolute;
      top: 0; left: 10%; right: 10%;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent);
      pointer-events: none;
      z-index: 10;
    }

    /* ─── SHINE SWEEP ─── */
    .shine-sweep {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 5;
      overflow: hidden;
      border-radius: var(--radius-xl);
    }

    .shine-sweep::after {
      content: "";
      position: absolute;
      top: 0; left: -60%;
      width: 40%; height: 100%;
      background: linear-gradient(100deg,
        transparent 0%,
        rgba(255,255,255,0.045) 40%,
        rgba(255,255,255,0.09) 50%,
        rgba(255,255,255,0.045) 60%,
        transparent 100%
      );
      animation: shineSweep 8s ease-in-out infinite;
    }

    @keyframes shineSweep {
      0%   { transform: translateX(-10%); opacity: 0; }
      10%  { opacity: 1; }
      90%  { opacity: 1; }
      100% { transform: translateX(300%); opacity: 0; }
    }

    /* ─── TOPBAR ─── */
    .topbar {
      position: relative;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 20px;
      background: rgba(255,255,255,0.025);
      border-bottom: 1px solid var(--border-dim);
      backdrop-filter: blur(4px);
    }

    /* ─── BRAND ─── */
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }

    .logo-ring {
      position: relative;
      width: 50px; height: 50px;
      border-radius: 16px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, rgba(79,141,255,0.20), rgba(160,108,255,0.16));
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: var(--shadow-glow), inset 0 1px 0 rgba(255,255,255,0.12);
      overflow: hidden;
    }

    .logo-ring::before {
      content: "";
      position: absolute;
      inset: -50%;
      background: conic-gradient(
        from 0deg,
        transparent 0deg,
        rgba(79,141,255,0.30) 60deg,
        rgba(160,108,255,0.25) 120deg,
        transparent 180deg
      );
      animation: logoSpin 5s linear infinite;
    }

    @keyframes logoSpin {
      to { transform: rotate(360deg); }
    }

    .logo-ring::after {
      content: "";
      position: absolute;
      inset: 2px;
      border-radius: 14px;
      background: rgba(8,11,24,0.85);
    }

    .logo-img {
      position: relative;
      z-index: 1;
      width: 30px; height: 30px;
      object-fit: contain;
      filter: drop-shadow(0 2px 8px rgba(0,0,0,0.4));
    }

    .brand-name {
      font-family: var(--font-display);
      font-size: 16px;
      font-weight: 800;
      color: var(--text-bright);
      letter-spacing: 0.3px;
      background: linear-gradient(135deg, #e8f0ff, #a0b8ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .brand-sub {
      font-size: 11px;
      color: var(--text-dim);
      font-weight: 400;
      margin-top: 1px;
      letter-spacing: 0.2px;
    }

    /* ─── SEARCHBAR ─── */
    .searchbar {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .input-wrap {
      flex: 1;
      position: relative;
      min-width: 0;
    }

    .input-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-dim);
      font-size: 16px;
      pointer-events: none;
      transition: color 0.2s;
    }

    .input-wrap:focus-within .input-icon {
      color: var(--accent-a);
    }

    .search-input {
      width: 100%;
      height: 46px;
      background: var(--bg-input);
      border: 1px solid var(--border-dim);
      border-radius: var(--radius-md);
      color: var(--text-bright);
      font-family: var(--font-body);
      font-size: 14px;
      padding: 0 16px 0 42px;
      outline: none;
      transition: border-color 0.2s var(--ease-smooth),
                  box-shadow 0.2s var(--ease-smooth),
                  background 0.2s;
      backdrop-filter: blur(8px);
    }

    .search-input::placeholder { color: var(--text-dim); }

    .search-input:focus {
      border-color: var(--border-glow);
      background: rgba(79,141,255,0.06);
      box-shadow: 0 0 0 3px rgba(79,141,255,0.10),
                  inset 0 1px 0 rgba(255,255,255,0.05);
    }

    /* ─── BUTTONS ─── */
    .btn {
      height: 46px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-dim);
      padding: 0 16px;
      color: var(--text-mid);
      font-family: var(--font-display);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.4px;
      background: rgba(255,255,255,0.04);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.18s var(--ease-smooth);
      backdrop-filter: blur(8px);
      position: relative;
      overflow: hidden;
    }

    .btn::before {
      content: "";
      position: absolute;
      inset: 0;
      background: rgba(255,255,255,0);
      transition: background 0.18s;
    }

    .btn:hover {
      color: var(--text-bright);
      border-color: rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.08);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.20);
    }

    .btn:active {
      transform: translateY(0px) scale(0.98);
      box-shadow: none;
    }

    .btn-search {
      background: linear-gradient(135deg, #3b72ff, #1d4ed8);
      border-color: rgba(100,160,255,0.35);
      color: #fff;
      box-shadow: 0 8px 24px rgba(37,99,235,0.30),
                  inset 0 1px 0 rgba(255,255,255,0.15);
      padding: 0 22px;
    }

    .btn-search:hover {
      background: linear-gradient(135deg, #4d83ff, #2563eb);
      border-color: rgba(120,180,255,0.45);
      color: #fff;
      box-shadow: 0 12px 30px rgba(37,99,235,0.40),
                  inset 0 1px 0 rgba(255,255,255,0.20);
    }

    /* ─── STATUSBAR ─── */
    .statusbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      background: rgba(0,0,0,0.10);
    }

    .status-left {
      display: flex;
      align-items: center;
      gap: 9px;
    }

    .pulse-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--accent-a);
      box-shadow: 0 0 10px rgba(79,141,255,0.7);
      flex-shrink: 0;
      animation: pulseDot 2s ease-in-out infinite;
    }

    @keyframes pulseDot {
      0%,100% { transform: scale(0.85); opacity: 0.65; box-shadow: 0 0 6px rgba(79,141,255,0.5); }
      50%      { transform: scale(1.2);  opacity: 1;    box-shadow: 0 0 14px rgba(79,141,255,0.9); }
    }

    .status-text {
      font-size: 12px;
      color: var(--text-mid);
      font-weight: 400;
    }

    .count-pill {
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 700;
      color: var(--text-mid);
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: var(--radius-pill);
      padding: 5px 12px;
      letter-spacing: 0.3px;
    }

    /* ─── SOURCE FILTERS ─── */
    .filter-row {
      display: flex;
      gap: 8px;
      padding: 10px 20px 0;
      flex-wrap: wrap;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      padding-bottom: 10px;
    }

    .filter-chip {
      height: 34px;
      padding: 0 14px;
      border-radius: var(--radius-pill);
      border: 1px solid rgba(255,255,255,0.07);
      background: rgba(255,255,255,0.04);
      color: var(--text-dim);
      font-family: var(--font-display);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3px;
      cursor: pointer;
      transition: all 0.18s var(--ease-smooth);
      backdrop-filter: blur(8px);
    }

    .filter-chip:hover {
      background: rgba(255,255,255,0.08);
      color: var(--text-mid);
      border-color: rgba(255,255,255,0.12);
      transform: translateY(-1px);
    }

    .filter-chip.active {
      background: linear-gradient(135deg, rgba(59,114,255,0.22), rgba(140,80,255,0.18));
      border-color: rgba(100,160,255,0.30);
      color: var(--text-bright);
      box-shadow: 0 6px 18px rgba(59,114,255,0.15),
                  inset 0 1px 0 rgba(255,255,255,0.10);
    }

    /* ─── SCROLL CONTENT ─── */
    .scroll-area {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 18px 20px 24px;
      scroll-behavior: smooth;
    }

    .scroll-area::-webkit-scrollbar { width: 6px; }
    .scroll-area::-webkit-scrollbar-track { background: transparent; }
    .scroll-area::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.10);
      border-radius: 3px;
    }
    .scroll-area::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,0.18);
    }

    /* ─── RESULTS GRID ─── */
    .results-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 14px;
    }

    /* ─── CARD ─── */
    .card {
      position: relative;
      display: flex;
      gap: 14px;
      padding: 14px;
      min-height: 175px;
      border-radius: var(--radius-lg);
      background: var(--bg-card);
      border: 1px solid var(--border-dim);
      box-shadow: var(--shadow-card);
      backdrop-filter: var(--blur-light);
      -webkit-backdrop-filter: var(--blur-light);
      transition: transform 0.22s var(--ease-smooth),
                  border-color 0.22s,
                  box-shadow 0.22s,
                  background 0.22s;
      overflow: hidden;
      animation: cardIn 0.40s var(--ease-smooth) both;
      cursor: default;
    }

    /* staggered card delay */
    .card:nth-child(1)  { animation-delay: 0.03s; }
    .card:nth-child(2)  { animation-delay: 0.06s; }
    .card:nth-child(3)  { animation-delay: 0.09s; }
    .card:nth-child(4)  { animation-delay: 0.12s; }
    .card:nth-child(5)  { animation-delay: 0.15s; }
    .card:nth-child(6)  { animation-delay: 0.18s; }
    .card:nth-child(7)  { animation-delay: 0.20s; }
    .card:nth-child(8)  { animation-delay: 0.22s; }
    .card:nth-child(n+9){ animation-delay: 0.24s; }

    @keyframes cardIn {
      from { opacity: 0; transform: translateY(14px) scale(0.97); filter: blur(4px); }
      to   { opacity: 1; transform: translateY(0px)  scale(1);    filter: blur(0px); }
    }

    /* card shimmer on hover */
    .card::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg,
        transparent 0%,
        rgba(255,255,255,0.0) 30%,
        rgba(255,255,255,0.055) 50%,
        rgba(255,255,255,0.0) 70%,
        transparent 100%
      );
      transform: translateX(-120%);
      transition: transform 0.7s ease;
      pointer-events: none;
    }

    .card:hover {
      transform: translateY(-3px);
      border-color: rgba(100,160,255,0.20);
      box-shadow: 0 20px 44px rgba(0,0,0,0.35), 0 0 0 1px rgba(100,160,255,0.08);
      background: rgba(20,28,52,0.72);
    }

    .card:hover::after {
      transform: translateX(140%);
    }

    /* top glow accent */
    .card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(100,160,255,0.20), transparent);
      opacity: 0;
      transition: opacity 0.22s;
    }

    .card:hover::before { opacity: 1; }

    /* ─── COVER ─── */
    .cover-wrap {
      position: relative;
      flex-shrink: 0;
    }

    .cover {
      width: 100px;
      height: 142px;
      border-radius: var(--radius-md);
      object-fit: cover;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 8px 20px rgba(0,0,0,0.35);
      display: block;
      background: rgba(10,14,26,0.7);
    }

    .cover-fallback {
      width: 100px;
      height: 142px;
      border-radius: var(--radius-md);
      border: 1px solid rgba(255,255,255,0.07);
      background:
        radial-gradient(circle at 30% 20%, rgba(79,141,255,0.15), transparent 50%),
        rgba(12,16,28,0.80);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 6px;
      color: var(--text-dim);
      font-size: 10px;
      text-align: center;
    }

    /* ─── CARD INFO ─── */
    .card-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .card-title {
      font-family: var(--font-display);
      font-size: 15px;
      font-weight: 700;
      line-height: 1.36;
      color: var(--text-bright);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      height: 26px;
      padding: 0 10px;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-weight: 600;
      font-family: var(--font-display);
      border: 1px solid rgba(255,255,255,0.07);
      background: rgba(255,255,255,0.05);
      color: var(--text-mid);
      letter-spacing: 0.2px;
    }

    .tag-source {
      background: rgba(59,114,255,0.12);
      border-color: rgba(59,114,255,0.20);
      color: #92b8ff;
    }

    .tag-ok {
      background: rgba(34,197,94,0.10);
      border-color: rgba(34,197,94,0.18);
      color: #86efac;
    }

    .tag-no {
      background: rgba(239,68,68,0.10);
      border-color: rgba(239,68,68,0.18);
      color: #fca5a5;
    }

    .card-id {
      font-size: 10.5px;
      color: var(--text-dim);
      font-family: 'DM Mono', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.7;
    }

    /* ─── EMPTY STATE ─── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 360px;
      border-radius: var(--radius-xl);
      border: 1px dashed rgba(255,255,255,0.08);
      background:
        radial-gradient(circle at 50% 30%, rgba(79,141,255,0.06), transparent 50%),
        rgba(255,255,255,0.015);
      text-align: center;
      padding: 40px;
      animation: fadeIn 0.35s ease both;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.98); }
      to   { opacity: 1; transform: scale(1); }
    }

    .empty-logo {
      width: 64px; height: 64px;
      object-fit: contain;
      opacity: 0.85;
      margin-bottom: 18px;
      filter: drop-shadow(0 8px 20px rgba(0,0,0,0.3));
      animation: floatBob 4s ease-in-out infinite;
    }

    @keyframes floatBob {
      0%,100% { transform: translateY(0px); }
      50%      { transform: translateY(-6px); }
    }

    .empty-title {
      font-family: var(--font-display);
      font-size: 17px;
      font-weight: 800;
      color: var(--text-bright);
      margin-bottom: 8px;
    }

    .empty-sub {
      font-size: 13px;
      line-height: 1.6;
      color: var(--text-dim);
      max-width: 320px;
    }

    /* ─── LOADING SKELETONS ─── */
    .skeleton-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 14px;
    }

    .skeleton-card {
      position: relative;
      min-height: 175px;
      border-radius: var(--radius-lg);
      overflow: hidden;
      background: rgba(16,22,40,0.50);
      border: 1px solid rgba(255,255,255,0.05);
      animation: skelFadeIn 0.3s ease both;
    }

    .skeleton-card:nth-child(1) { animation-delay: 0.03s; }
    .skeleton-card:nth-child(2) { animation-delay: 0.06s; }
    .skeleton-card:nth-child(3) { animation-delay: 0.09s; }
    .skeleton-card:nth-child(4) { animation-delay: 0.12s; }
    .skeleton-card:nth-child(5) { animation-delay: 0.15s; }
    .skeleton-card:nth-child(6) { animation-delay: 0.18s; }

    @keyframes skelFadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .skeleton-card::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent 0%,
        rgba(255,255,255,0.06) 30%,
        rgba(255,255,255,0.10) 50%,
        rgba(255,255,255,0.06) 70%,
        transparent 100%
      );
      transform: translateX(-100%);
      animation: skelShimmer 1.6s ease-in-out infinite;
    }

    @keyframes skelShimmer {
      100% { transform: translateX(100%); }
    }

    /* ─── LOADING SPINNER inside status ─── */
    .spinner {
      width: 14px; height: 14px;
      border: 2px solid rgba(79,141,255,0.25);
      border-top-color: var(--accent-a);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* ─── RESPONSIVE ─── */
    @media (max-width: 860px) {
      .topbar { flex-direction: column; gap: 12px; }
      .searchbar { width: 100%; flex-wrap: wrap; }
      .btn { flex: 1; }
    }
  </style>
</head>
<body>

  <!-- Ambient orbs -->
  <div class="ambient">
    <div class="orb orb-1"></div>
    <div class="orb orb-2"></div>
    <div class="orb orb-3"></div>
    <div class="orb orb-4"></div>
  </div>

  <!-- Noise grain -->
  <div class="noise"></div>

  <div class="wrapper">
    <div class="window">
      <div class="shine-sweep"></div>

      <!-- TOPBAR -->
      <div class="topbar">
        <div class="brand">
          <div class="logo-ring">
            <img class="logo-img" src="${BRAND_ICON}" alt="PT Scans" />
          </div>
          <div>
            <div class="brand-name">PT Scans</div>
            <div class="brand-sub">Manga Search</div>
          </div>
        </div>

        <div class="searchbar">
          <div class="input-wrap">
            <span class="input-icon">⌕</span>
            <input id="query" class="search-input" placeholder="Pesquisar título..." autocomplete="off" />
          </div>
          <button id="searchBtn" class="btn btn-search">Pesquisar</button>
          <button id="reloadBtn" class="btn">↺ Reload</button>
          <button id="clearBtn" class="btn">Limpar</button>
          <button id="closeBtn" class="btn">✕</button>
        </div>
      </div>

      <!-- STATUSBAR -->
      <div class="statusbar">
        <div class="status-left">
          <div id="statusIndicator" class="pulse-dot"></div>
          <span id="statusText" class="status-text">Pronto</span>
        </div>
        <div id="countPill" class="count-pill">0 resultados</div>
      </div>

      <!-- FILTER ROW -->
      <div id="filterRow" class="filter-row"></div>

      <!-- SCROLL AREA -->
      <div class="scroll-area">
        <div id="app"></div>
      </div>

    </div>
  </div>

  <script>
    const BRAND_ICON_URL = ${JSON.stringify(BRAND_ICON)};

    const state = {
      results: [],
      status: "Pronto",
      loading: false,
      query: "",
      sourceFilter: "all"
    };

    function esc(v) {
      return String(v == null ? "")
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
    }

    function getItemSource(item) {
      if (item.rawSource) return item.rawSource;
      const raw = String(item.id || "");
      const i = raw.indexOf(":");
      return i !== -1 ? raw.slice(0, i) : "unknown";
    }

    function buildSourceCounts(items) {
      const counts = { all: items.length, mangaflix:0, mangalivre:0, hipercool:0, tiamanhwa:0, mangafire:0 };
      items.forEach(item => {
        const s = getItemSource(item);
        if (counts[s] != null) counts[s]++;
      });
      return counts;
    }

    function renderFilters(items) {
      const wrap = document.getElementById("filterRow");
      if (!wrap) return;
      const counts = buildSourceCounts(items);
      const defs = [
        { key:"all",        label:"Todos" },
        { key:"mangaflix",  label:"MangaFlix" },
        { key:"mangalivre", label:"MangaLivre" },
        { key:"hipercool",  label:"HiperCool" },
        { key:"tiamanhwa",  label:"TiaManhwa" },
        { key:"mangafire",  label:"MangaFire" }
      ];
      wrap.innerHTML = defs.map(d => {
        const active = state.sourceFilter === d.key ? "active" : "";
        return \`<button class="filter-chip \${active}" data-source="\${esc(d.key)}" type="button">\${esc(d.label)} (\${counts[d.key]||0})</button>\`;
      }).join("");
      wrap.querySelectorAll(".filter-chip").forEach(btn => {
        btn.addEventListener("click", () => {
          state.sourceFilter = btn.dataset.source || "all";
          render();
        });
      });
    }

    function renderSkeletons() {
      return '<div class="skeleton-grid">' +
        Array.from({length:6}).map(() => '<div class="skeleton-card"></div>').join("") +
      '</div>';
    }

    function renderCards(items) {
      return '<div class="results-grid">' +
        items.map(item => {
          const cover = item.image
            ? \`<img class="cover" src="\${esc(item.image)}" alt="\${esc(item.title)}" />\`
            : '<div class="cover-fallback"><span style="font-size:22px;opacity:0.5">📖</span><span>Sem capa</span></div>';

          const chapterTag = item.hasChapters
            ? \`<span class="tag tag-ok">✓ \${item.chapterCount} caps</span>\`
            : '<span class="tag tag-no">Sem caps</span>';

          const latestTag = item.latestChapter
            ? \`<span class="tag">Cap. \${esc(item.latestChapter)}</span>\`
            : '';

          const yearTag = item.year
            ? \`<span class="tag">\${esc(item.year)}</span>\`
            : '';

          return \`
            <div class="card">
              <div class="cover-wrap">\${cover}</div>
              <div class="card-info">
                <div>
                  <div class="card-title">\${esc(item.title)}</div>
                  <div class="tags">
                    <span class="tag tag-source">\${esc(item.source || getItemSource(item))}</span>
                    \${chapterTag}
                    \${latestTag}
                    \${yearTag}
                  </div>
                </div>
                <div class="card-id">\${esc(item.id || "")}</div>
              </div>
            </div>
          \`;
        }).join("") +
      '</div>';
    }

    function render() {
      const app         = document.getElementById("app");
      const statusText  = document.getElementById("statusText");
      const statusDot   = document.getElementById("statusIndicator");
      const countPill   = document.getElementById("countPill");
      const input       = document.getElementById("query");

      statusText.textContent = state.status || "Pronto";

      // swap dot ↔ spinner when loading
      if (state.loading) {
        statusDot.className = "spinner";
      } else {
        statusDot.className = "pulse-dot";
      }

      if (document.activeElement !== input) {
        input.value = state.query || "";
      }

      const allResults = Array.isArray(state.results) ? state.results : [];
      const filtered = state.sourceFilter === "all"
        ? allResults
        : allResults.filter(i => getItemSource(i) === state.sourceFilter);

      countPill.textContent = filtered.length + " resultado" + (filtered.length !== 1 ? "s" : "");
      renderFilters(allResults);

      if (state.loading && allResults.length === 0) {
        app.innerHTML = renderSkeletons();
        return;
      }

      if (filtered.length === 0) {
        app.innerHTML = \`
          <div class="empty-state">
            <img class="empty-logo" src="\${esc(BRAND_ICON_URL)}" alt="PT Scans" />
            <div class="empty-title">PT Scans</div>
            <div class="empty-sub">
              \${allResults.length === 0
                ? "Pesquisa um título para começar a explorar."
                : "Sem resultados para este filtro."}
            </div>
          </div>
        \`;
        return;
      }

      app.innerHTML = renderCards(filtered);
    }

    // ─── EVENT BINDINGS ───
    document.getElementById("searchBtn").addEventListener("click", () => {
      window.webview.send("search", document.getElementById("query").value);
    });

    document.getElementById("query").addEventListener("keydown", e => {
      if (e.key === "Enter") window.webview.send("search", document.getElementById("query").value);
    });

    document.getElementById("clearBtn").addEventListener("click", () => {
      document.getElementById("query").value = "";
      state.sourceFilter = "all";
      window.webview.send("clear");
    });

    document.getElementById("closeBtn").addEventListener("click", () => {
      window.webview.send("hide");
    });

    document.getElementById("reloadBtn").addEventListener("click", () => {
      window.webview.send("reloadProvider");
    });

    // ─── CHANNEL BINDINGS ───
    window.webview.on("results", v  => { state.results = v || [];  render(); });
    window.webview.on("status",  v  => { state.status  = v || "Pronto"; render(); });
    window.webview.on("loading", v  => { state.loading = !!v; render(); });
    window.webview.on("query",   v  => { state.query   = v || "";  render(); });

    render();
  </script>
</body>
</html>
    `);
  });
}
