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
    const mode = ctx.state("search");

    panel.channel.sync("results", results);
    panel.channel.sync("status", status);
    panel.channel.sync("loading", loading);
    panel.channel.sync("query", queryState);
    panel.channel.sync("mode", mode);

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

        if (!res.ok) {
          throw new Error("Falha ao carregar provider: HTTP " + res.status);
        }

        const manifest = await res.json();
        const payload = String(manifest && manifest.payload ? manifest.payload : "").trim();

        if (!payload) {
          throw new Error("Provider sem payload.");
        }

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
          try {
            chapters = safeArray(await provider.findChapters(item.id));
          } catch (e) {}

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

    tray.onClick(() => {
      panel.show();
    });

    panel.channel.on("search", async (query) => {
      await runSearch(query || "");
    });

    panel.channel.on("hide", () => {
      panel.hide();
    });

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

    panel.channel.on("setMode", (newMode) => {
      mode.set(newMode);
    });

    panel.setContent(() => `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html { color-scheme: dark; overflow: hidden; }
    :root {
      --line: rgba(255,255,255,.09);
      --text: #edf4ff;
      --muted: #98a9c7;
      --blue: #5ea2ff;
      --purple: #9b7cff;
      --shadow: 0 18px 50px rgba(0,0,0,.38);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      background: transparent;
      overflow: hidden;
    }

    .overlay {
      position: relative;
      width: 100%;
      height: 100vh;
      padding: 18px;
      overflow: hidden;
      background:
        radial-gradient(circle at 12% 12%, rgba(94,162,255,.16), transparent 20%),
        radial-gradient(circle at 86% 14%, rgba(155,124,255,.12), transparent 20%),
        linear-gradient(180deg, rgba(3, 7, 15, .96), rgba(8, 12, 23, .88));
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
    }

    .overlay::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(circle at 50% 10%, rgba(255,255,255,.06), transparent 20%),
                  radial-gradient(circle at 50% 90%, rgba(0,0,0,.25), transparent 30%);
    }

    .blob,
    .blob::before,
    .blob::after {
      position: absolute;
      border-radius: 999px;
      filter: blur(40px);
      pointer-events: none;
    }

    .blob {
      width: 280px;
      height: 280px;
      left: -60px;
      top: -40px;
      background: rgba(91, 168, 255, .18);
      animation: driftA 14s ease-in-out infinite;
    }

    .blob::before {
      content: "";
      width: 210px;
      height: 210px;
      left: 980px;
      top: 80px;
      background: rgba(164, 118, 255, .14);
      animation: driftB 16s ease-in-out infinite;
    }

    .blob::after {
      content: "";
      width: 240px;
      height: 240px;
      left: 460px;
      top: 520px;
      background: rgba(86, 234, 181, .10);
      animation: driftC 18s ease-in-out infinite;
    }

    @keyframes driftA {
      0%,100% { transform: translate3d(0,0,0) scale(1); }
      50% { transform: translate3d(60px,35px,0) scale(1.08); }
    }
    @keyframes driftB {
      0%,100% { transform: translate3d(0,0,0) scale(1); }
      50% { transform: translate3d(-70px,25px,0) scale(1.12); }
    }
    @keyframes driftC {
      0%,100% { transform: translate3d(0,0,0) scale(1); }
      50% { transform: translate3d(35px,-55px,0) scale(1.06); }
    }

    .window {
      position: relative;
      width: 100%;
      height: calc(86vh - 6px);
      border-radius: 32px;
      overflow: hidden;
      background: radial-gradient(circle at top left, rgba(10, 20, 50, .35), transparent 32%), linear-gradient(180deg, rgba(18, 24, 42, .94), rgba(8, 12, 23, .85));
      border: 1px solid rgba(94,162,255,.18);
      box-shadow: 0 30px 90px rgba(0,0,0,.43), inset 0 1px 1px rgba(255,255,255,.03);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      animation: fadeUp .35s ease;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(12px) scale(.988); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .shine {
      position: absolute;
      inset: 0 auto auto -20%;
      width: 45%;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.65), transparent);
      opacity: .45;
      animation: shine 5.6s linear infinite;
    }

    @keyframes shine {
      from { transform: translateX(-15%); }
      to { transform: translateX(250%); }
    }

    .topbar {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 20px;
      border-bottom: 1px solid rgba(255,255,255,.08);
      background: rgba(7, 11, 24, .55);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: inset 0 -1px 0 rgba(255,255,255,.05);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 220px;
    }

    .brand-logo-wrap {
      position: relative;
      width: 54px;
      height: 54px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, rgba(94,162,255,.26), rgba(155,124,255,.22));
      border: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 14px 34px rgba(74, 120, 255, .25);
      overflow: hidden;
    }

    .brand-logo-wrap::after {
      content: "";
      position: absolute;
      inset: -20%;
      background: conic-gradient(from 180deg, transparent, rgba(255,255,255,.18), transparent 35%);
      animation: spinConic 6s linear infinite;
    }

    @keyframes spinConic {
      from { transform: rotate(0); }
      to { transform: rotate(360deg); }
    }

    .brand-logo {
      position: relative;
      z-index: 1;
      width: 34px;
      height: 34px;
      object-fit: contain;
      filter: drop-shadow(0 3px 10px rgba(0,0,0,.35));
    }

    .brand-title {
      font-size: 17px;
      font-weight: 800;
      color: #f8fbff;
      letter-spacing: .2px;
      text-shadow: 0 2px 14px rgba(94,162,255,.18);
    }

    .searchbar {
      flex: 1;
      display: flex;
      gap: 10px;
      min-width: 0;
      align-items: center;
      background: rgba(255,255,255,.04);
      border-radius: 18px;
      padding: 10px;
      border: 1px solid rgba(255,255,255,.08);
      box-shadow: inset 0 1px 2px rgba(255,255,255,.08);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }

    .search-shell {
      flex: 1;
      position: relative;
      min-width: 0;
    }

    .search-shell::before {
      content: "⌕";
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: #9bb8eb;
      font-size: 15px;
      opacity: .9;
      pointer-events: none;
    }

    .searchbar input {
      width: 100%;
      height: 50px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,.09);
      background: rgba(6, 10, 19, .42);
      color: white;
      padding: 0 16px 0 40px;
      outline: none;
      font-size: 14px;
      transition: all .3s cubic-bezier(0.34, 1.56, 0.64, 1);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }

    .searchbar input:focus {
      border-color: rgba(94,162,255,.6);
      box-shadow: 0 0 0 4px rgba(94,162,255,.15), inset 0 1px 2px rgba(0,0,0,.2), 0 8px 24px rgba(94,162,255,.15);
      background: rgba(7, 12, 24, .65);
      transform: translateY(-2px);
    }

    .searchbar input::placeholder {
      color: rgba(155,177,227,.6);
    }

    .btn {
      height: 50px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,.09);
      padding: 0 16px;
      color: white;
      cursor: pointer;
      font-weight: 800;
      font-size: 13px;
      background: rgba(255,255,255,.045);
      transition: transform .2s cubic-bezier(0.34, 1.56, 0.64, 1), background .2s ease, border-color .2s ease, box-shadow .3s ease, color .2s ease;
      position: relative;
      overflow: hidden;
    }

    .btn:hover {
      transform: translateY(-2px) scale(1.02);
      background: rgba(255,255,255,.09);
      border-color: rgba(255,255,255,.2);
      box-shadow: 0 12px 30px rgba(255,255,255,.1);
    }

    .btn:active {
      transform: translateY(0) scale(0.98);
    }

    .btn-primary {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      border-color: rgba(108, 164, 255, .6);
      box-shadow: 0 14px 28px rgba(37,99,235,.28);
      color: #fff;
    }

    .btn-primary:hover {
      background: linear-gradient(135deg, #5b9bff, #3b7fd4);
      border-color: rgba(108, 164, 255, .9);
      box-shadow: 0 18px 40px rgba(37,99,235,.42), inset 0 1px 2px rgba(255,255,255,.1);
      transform: translateY(-3px) scale(1.03);
    }

    .meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 20px;
      border-bottom: 1px solid rgba(255,255,255,.05);
      color: var(--muted);
      font-size: 13px;
      background: rgba(255,255,255,.02);
    }

    .status-wrap {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--blue);
      box-shadow: 0 0 18px rgba(94,162,255,.8), inset 0 0 8px rgba(255,255,255,.4);
      animation: pulse 1.3s ease-in-out infinite;
      flex-shrink: 0;
    }

    @keyframes pulse {
      0% { transform: scale(.88); opacity: .6; }
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(.88); opacity: .6; }
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 9px 13px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.1);
      color: #dbe7ff;
      box-shadow: 0 8px 20px rgba(0,0,0,.12);
    }

    .filters {
      display: flex;
      gap: 10px;
      padding: 12px 20px 0;
      flex-wrap: wrap;
    }

    .filter-chip {
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.04);
      color: #d7e5ff;
      height: 38px;
      padding: 0 14px;
      border-radius: 999px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
      transition: all .25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .filter-chip:hover {
      background: rgba(255,255,255,.08);
      border-color: rgba(255,255,255,.15);
      transform: translateY(-2px);
    }

    .filter-chip.active {
      background: linear-gradient(135deg, rgba(59,130,246,.25), rgba(147,51,234,.2));
      border-color: rgba(94,162,255,.5);
      color: #ffffff;
      box-shadow: 0 12px 30px rgba(59,130,246,.22);
      transform: translateY(-3px);
    }

    .content {
      position: relative;
      padding: 18px 20px 22px;
      height: calc(100% - 186px);
      overflow: auto;
      scroll-behavior: smooth;
      background: rgba(8, 12, 22, .5);
      border-radius: 0 0 32px 32px;
      border-top: 1px solid rgba(255,255,255,.06);
    }

    .content::-webkit-scrollbar { width: 10px; }
    .content::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.10);
      border-radius: 999px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 18px;
    }

    .card {
      position: relative;
      display: flex;
      gap: 14px;
      padding: 14px;
      min-height: 190px;
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.025)), rgba(13,18,30,.72);
      border: 1px solid rgba(255,255,255,.08);
      box-shadow: 0 8px 24px rgba(0,0,0,.2), inset 0 1px 1px rgba(255,255,255,.05);
      transition: transform .3s cubic-bezier(0.34, 1.56, 0.64, 1), border-color .3s ease, box-shadow .3s ease;
      overflow: hidden;
      animation: cardIn .35s ease both;
    }

    @keyframes cardIn {
      from { opacity: 0; transform: translateY(12px) scale(.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .card:hover {
      transform: translateY(-6px) scale(1.01);
      border-color: rgba(110, 170, 255, .3);
      box-shadow: 0 20px 50px rgba(37,99,235,.25), inset 0 1px 1px rgba(255,255,255,.08);
    }

    .cover, .fallback {
      width: 106px;
      height: 150px;
      border-radius: 18px;
      flex-shrink: 0;
    }

    .cover {
      object-fit: cover;
      background: rgba(7,10,18,.55);
      border: 1px solid rgba(255,255,255,.07);
      box-shadow: 0 8px 20px rgba(0,0,0,.22);
    }

    .fallback {
      border: 1px solid rgba(255,255,255,.07);
      background: linear-gradient(180deg, rgba(20,27,43,.95), rgba(9,12,20,.95));
      display: flex;
      align-items: center;
      justify-content: center;
      color: #8ea2c5;
      font-size: 12px;
      text-align: center;
      padding: 12px;
    }

    .info {
      min-width: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .title {
      font-size: 17px;
      font-weight: 800;
      line-height: 1.34;
      margin: 0 0 10px 0;
      color: #f7fbff;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 800;
      border: 1px solid rgba(255,255,255,.06);
      background: rgba(255,255,255,.05);
      color: #d8e4fb;
    }

    .chip.ok {
      color: #c8ffe0;
      background: linear-gradient(135deg, rgba(34,197,94,.15), rgba(34,197,94,.08));
      border-color: rgba(34,197,94,.25);
    }

    .chip.no {
      color: #ffd0d8;
      background: linear-gradient(135deg, rgba(239,68,68,.15), rgba(239,68,68,.08));
      border-color: rgba(239,68,68,.25);
    }

    .chip.source {
      color: #d5e7ff;
      background: linear-gradient(135deg, rgba(59,130,246,.15), rgba(59,130,246,.08));
      border-color: rgba(59,130,246,.25);
    }

    .sub {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      word-break: break-word;
      opacity: .95;
    }

    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 380px;
      border-radius: 26px;
      border: 2px dashed rgba(94,162,255,.2);
      background: radial-gradient(circle at top, rgba(94,162,255,.08), transparent 36%), linear-gradient(135deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      color: #9db1d3;
      text-align: center;
      padding: 32px;
      animation: fadeUp .4s ease;
    }

    .empty-box { max-width: 460px; }

    .empty-logo {
      width: 70px;
      height: 70px;
      object-fit: contain;
      opacity: .94;
      margin-bottom: 14px;
      filter: drop-shadow(0 10px 18px rgba(0,0,0,.22));
      animation: floaty 3s ease-in-out infinite;
    }

    @keyframes floaty {
      0%,100% { transform: translateY(0px); }
      50% { transform: translateY(-5px); }
    }

    .loading-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 18px;
    }

    .skeleton {
      position: relative;
      min-height: 190px;
      border-radius: 24px;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02)), rgba(13,18,30,.6);
      border: 1px solid rgba(255,255,255,.07);
    }

    .skeleton::after {
      content: "";
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.08), transparent);
      animation: skeletonSlide 1.4s infinite;
    }

    @keyframes skeletonSlide {
      100% { transform: translateX(100%); }
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.5);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 999;
    }

    .modal-content {
      position: fixed;
      top: 50%;
      left: 50%;
      width: min(92vw, 620px);
      transform: translate(-50%, -50%);
      z-index: 1000;
    }

    .anilist-input {
      width: 100%;
      height: 50px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,.09);
      background: rgba(6, 10, 19, .42);
      color: white;
      padding: 0 16px;
      outline: none;
      font-size: 14px;
      font-family: inherit;
      transition: border-color .3s ease, background .3s ease;
    }

    .anilist-input:focus {
      border-color: rgba(94,162,255,.6);
      background: rgba(7, 12, 24, .65);
      box-shadow: 0 0 0 4px rgba(94,162,255,.15);
    }

    .anilist-input::placeholder {
      color: rgba(155,177,227,.6);
    }

    .provider-btn {
      margin-top: 8px;
      width: 100%;
      background: linear-gradient(135deg, rgba(94,162,255,.15), rgba(94,162,255,.08));
      border: 1px solid rgba(94,162,255,.3);
      color: #5ea2ff;
      padding: 8px;
      border-radius: 12px;
      cursor: pointer;
      font-weight: 800;
      font-size: 12px;
      transition: all .3s ease;
    }

    .provider-btn:hover {
      background: linear-gradient(135deg, rgba(94,162,255,.25), rgba(94,162,255,.15));
      box-shadow: 0 8px 16px rgba(94,162,255,.2);
      transform: translateY(-1px);
    }

    @media (max-width: 920px) {
      .topbar { flex-direction: column; align-items: stretch; }
      .searchbar { width: 100%; flex-wrap: wrap; }
      .btn { flex: 1; }
      .content { height: calc(100% - 230px); }
    }
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
          <div class="brand-copy">
            <div class="brand-title">PT Scans Search</div>
          </div>
        </div>

        <div class="searchbar">
          <div class="search-shell">
            <input id="query" placeholder="Pesquisar..." />
          </div>
          <button id="searchBtn" class="btn btn-primary">Pesquisar</button>
          <button id="reloadBtn" class="btn">Reload</button>
          <button id="clearBtn" class="btn">Limpar</button>
          <button id="closeBtn" class="btn">Fechar</button>
        </div>
        <button id="libraryBtn" class="btn">Biblioteca</button>
      </div>

      <div class="meta">
        <div class="status-wrap">
          <div class="status-dot"></div>
          <div id="statusText">Pronto</div>
        </div>
        <div class="pill" id="resultMeta">0 resultados</div>
      </div>

      <div class="filters" id="sourceFilters"></div>

      <div class="content">
        <div id="app"></div>
      </div>
    </div>
  </div>

  <script>
    const BRAND_ICON = ${JSON.stringify(BRAND_ICON)};

    const state = {
      results: [],
      status: "Pronto",
      loading: false,
      query: "",
      sourceFilter: "all",
      mode: "search",
      libraryResults: [],
      libraryLoading: false,
      anilistUser: ""
    };

    /* ── utilidades ── */
    function esc(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function splitSourceId(value) {
      const raw = String(value || "").trim();
      const idx = raw.indexOf(":");
      if (idx === -1) return { source: "", id: raw };
      return { source: raw.slice(0, idx), id: raw.slice(idx + 1) };
    }

    function sourceLabel(source) {
      const map = { mangaflix: "MangaFlix", mangalivre: "MangaLivre", hipercool: "HiperCool", tiamanhwa: "TiaManhwa", mangafire: "MangaFire" };
      return map[source] || source || "Desconhecido";
    }

    function stripProviderPrefix(title) {
      return String(title || "")
        .replace(/^\\s*\\[(MangaFlix|MangaLivre|HiperCool|TiaManhwa|MangaFire)\\]\\s*/i, "")
        .replace(/^\\s*(MangaFlix|MangaLivre|HiperCool|TiaManhwa|MangaFire)\\s*[•\\-:]\\s*/i, "")
        .trim();
    }

    function safeArray(v) { return Array.isArray(v) ? v : []; }

    function getItemSource(item) {
      if (item.rawSource) return item.rawSource;
      const raw = String(item.id || "");
      const idx = raw.indexOf(":");
      return idx !== -1 ? raw.slice(0, idx) : "unknown";
    }

    /* ── provider ── */
    let providerCache = null;

    async function getProvider() {
      if (providerCache) return providerCache;
      const res = await fetch("https://raw.githubusercontent.com/SKRAPT/PT-Scans/refs/heads/main/ptscans-provider.json", {
        headers: { Accept: "application/json, text/plain, */*" }
      });
      if (!res.ok) throw new Error("Falha ao carregar provider: HTTP " + res.status);
      const manifest = await res.json();
      const payload = String(manifest && manifest.payload ? manifest.payload : "").trim();
      if (!payload) throw new Error("Provider sem payload.");
      const ProviderClass = new Function(payload + "\\nreturn Provider;")();
      providerCache = new ProviderClass();
      providerCache.getDisableNsfwConfig = () => false;
      return providerCache;
    }

    /* ── AniList ── */
    async function fetchAniListLibrary(username) {
      const safe = username.replace(/"/g, '\\\\"');
      const userRes = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: 'query { User(name: "' + safe + '") { id } }' })
      });
      const userData = await userRes.json();
      if (!userData.data || !userData.data.User) throw new Error("Utilizador não encontrado");
      const userId = userData.data.User.id;

      const listRes = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "query { MediaListCollection(userId: " + userId + ", type: MANGA, status: CURRENT) { lists { entries { media { title { romaji english } coverImage { large } id chapters status } progress } } } }"
        })
      });
      const listData = await listRes.json();
      if (!listData.data || !listData.data.MediaListCollection) throw new Error("Erro ao carregar lista");
      const entries = (listData.data.MediaListCollection.lists[0] || {}).entries || [];
      return entries.map(e => ({
        id: e.media.id,
        title: e.media.title.english || e.media.title.romaji,
        image: e.media.coverImage.large,
        chapters: e.media.chapters,
        progress: e.progress,
        source: "AniList"
      }));
    }

    /* ── render helpers ── */
    function renderSkeletons() {
      return '<div class="loading-grid">' + Array.from({ length: 6 }).map(() => '<div class="skeleton"></div>').join("") + '</div>';
    }

    function buildSourceCounts(items) {
      const counts = { all: items.length, mangaflix: 0, mangalivre: 0, hipercool: 0, tiamanhwa: 0, mangafire: 0 };
      items.forEach(item => { const s = getItemSource(item); if (counts[s] != null) counts[s]++; });
      return counts;
    }

    function renderFilters(items) {
      const wrap = document.getElementById("sourceFilters");
      if (!wrap) return;
      const counts = buildSourceCounts(items);
      const defs = [
        { key: "all", label: "Todos" },
        { key: "mangaflix", label: "MangaFlix" },
        { key: "mangalivre", label: "MangaLivre" },
        { key: "hipercool", label: "HiperCool" },
        { key: "tiamanhwa", label: "TiaManhwa" },
        { key: "mangafire", label: "MangaFire" }
      ];
      wrap.innerHTML = defs.map(d =>
        '<button class="filter-chip' + (state.sourceFilter === d.key ? " active" : "") + '" data-source="' + d.key + '">' +
          esc(d.label) + ' (' + (counts[d.key] || 0) + ')' +
        '</button>'
      ).join("");

      /* delegar eventos nos chips */
      wrap.querySelectorAll(".filter-chip").forEach(btn => {
        btn.addEventListener("click", () => {
          state.sourceFilter = btn.dataset.source || "all";
          render();
        });
      });
    }

    /* ── modal de providers ── */
    async function openProviderModal(mangaTitle) {
      state.status = "A pesquisar em providers...";
      render();
      try {
        const provider = await getProvider();
        const found = safeArray(await provider.search({ query: mangaTitle }));

        const grouped = {};
        for (const item of found) {
          const src = splitSourceId(item.id).source;
          if (!grouped[src]) grouped[src] = { title: sourceLabel(src), items: [] };
          let chapters = [];
          try { chapters = safeArray(await provider.findChapters(item.id)); } catch (e) {}
          grouped[src].items.push({ title: stripProviderPrefix(item.title), chapters: chapters.length });
        }

        const sources = Object.keys(grouped);
        let html = '<div class="modal-backdrop" id="modalBackdrop"></div>';
        html += '<div class="modal-content"><div style="background:linear-gradient(135deg,rgba(14,20,36,.98),rgba(8,12,23,.95));border:1px solid rgba(255,255,255,.12);border-radius:24px;max-height:80vh;overflow-y:auto;padding:28px;backdrop-filter:blur(30px);-webkit-backdrop-filter:blur(30px);box-shadow:0 25px 60px rgba(0,0,0,.45);">';
        html += '<div style="font-size:22px;font-weight:900;background:linear-gradient(135deg,#5ea2ff,#9b7cff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:8px;">Providers disponíveis</div>';
        html += '<div style="font-size:14px;color:#98a9c7;margin-bottom:24px;">' + esc(mangaTitle) + '</div>';

        sources.forEach((src, i) => {
          const d = grouped[src];
          html += '<div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,.05);border-radius:14px;border:1px solid rgba(94,162,255,.2);">';
          html += '<div style="font-size:14px;font-weight:900;color:#d5e7ff;margin-bottom:10px;">' + esc(d.title) + '</div>';
          d.items.forEach(item => {
            html += '<div style="font-size:12px;color:#98a9c7;padding:6px 0;display:flex;justify-content:space-between;">';
            html += '<span>' + esc(item.title) + '</span>';
            html += '<span style="color:#5ea2ff;font-weight:900;background:rgba(94,162,255,.15);padding:3px 8px;border-radius:8px;">' + item.chapters + ' caps</span>';
            html += '</div>';
          });
          html += '</div>';
        });

        html += '<button id="closeModalBtn" class="btn btn-primary" style="width:100%;margin-top:20px;">Fechar</button>';
        html += '</div></div>';

        const app = document.getElementById("app");
        app.innerHTML = html;

        /* eventos do modal — sem onclick inline */
        document.getElementById("closeModalBtn").addEventListener("click", render);
        document.getElementById("modalBackdrop").addEventListener("click", render);

      } catch (e) {
        state.status = "Erro: " + (e && e.message ? e.message : "Falha ao pesquisar");
        render();
      }
    }

    /* ── render principal ── */
    function render() {
      const app = document.getElementById("app");
      const statusText = document.getElementById("statusText");
      const resultMeta = document.getElementById("resultMeta");
      const input = document.getElementById("query");

      statusText.textContent = state.status || "Pronto";
      if (document.activeElement !== input) input.value = state.query || "";

      if (state.mode === "library") {
        resultMeta.textContent = state.libraryResults.length + " mangas";
        renderFilters([]);
        app.innerHTML = renderLibrary();
        attachLibraryEvents();
        return;
      }

      const allResults = safeArray(state.results);
      const filtered = state.sourceFilter === "all"
        ? allResults
        : allResults.filter(item => getItemSource(item) === state.sourceFilter);

      resultMeta.textContent = filtered.length + " resultados";
      renderFilters(allResults);

      if (state.loading && allResults.length === 0) {
        app.innerHTML = renderSkeletons();
        return;
      }

      if (filtered.length === 0) {
        app.innerHTML =
          '<div class="empty"><div class="empty-box">' +
          '<img class="empty-logo" src="' + esc(BRAND_ICON) + '" alt="PT Scans" />' +
          '<div style="font-size:18px;font-weight:800;color:#f4f8ff;margin-bottom:8px;">PT Scans</div>' +
          '<div style="font-size:13px;line-height:1.6;color:#9db1d3;">' +
            (allResults.length === 0 ? "Pesquisa um título para começar." : "Não há resultados para este filtro.") +
          '</div></div></div>';
        return;
      }

      app.innerHTML = '<div class="grid">' + filtered.map(item => {
        const cover = item.image
          ? '<img class="cover" src="' + esc(item.image) + '" alt="' + esc(item.title) + '" />'
          : '<div class="fallback">Sem capa</div>';
        return (
          '<div class="card">' + cover +
          '<div class="info"><div>' +
            '<div class="title">' + esc(item.title) + '</div>' +
            '<div class="stats">' +
              '<div class="chip source">' + esc(item.source || getItemSource(item)) + '</div>' +
              '<div class="chip ' + (item.hasChapters ? 'ok' : 'no') + '">Capítulos: ' + (item.hasChapters ? 'Sim' : 'Não') + '</div>' +
              '<div class="chip">Total: ' + esc(item.chapterCount) + '</div>' +
              '<div class="chip">Último: ' + esc(item.latestChapter || "-") + '</div>' +
              (item.year ? '<div class="chip">Ano: ' + esc(item.year) + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div class="sub">' + esc(item.id || "") + '</div>' +
          '</div></div>'
        );
      }).join("") + '</div>';
    }

    /* ── renderLibrary ── */
    function renderLibrary() {
      let html = '<div style="padding:20px;">';
      html += '<div style="display:flex;gap:10px;margin-bottom:20px;align-items:center;">';
      html += '<input id="anilistUser" class="anilist-input" placeholder="Nome de utilizador AniList" value="' + esc(state.anilistUser) + '" />';
      html += '<button id="loadLibraryBtn" class="btn btn-primary">Carregar</button>';
      html += '<button id="backToSearchBtn" class="btn">Voltar</button>';
      html += '</div>';

      if (state.libraryLoading) {
        html += renderSkeletons();
      } else if (state.libraryResults.length > 0) {
        html += '<div class="grid">';
        state.libraryResults.forEach(item => {
          const coverHtml = item.image
            ? '<img class="cover" src="' + esc(item.image) + '" alt="' + esc(item.title) + '" />'
            : '<div class="fallback">Sem capa</div>';
          const chapterText = item.chapters ? String(item.chapters) : "?";
          html += '<div class="card">' + coverHtml +
            '<div class="info">' +
              '<div class="title">' + esc(item.title) + '</div>' +
              '<div class="stats">' +
                '<div class="chip">Progresso: ' + esc(String(item.progress)) + '/' + esc(chapterText) + '</div>' +
                '<div class="chip source">AniList</div>' +
              '</div>' +
              '<button class="provider-btn" data-title="' + esc(item.title) + '">Ver Providers</button>' +
            '</div></div>';
        });
        html += '</div>';
      } else {
        html += '<div class="empty"><div class="empty-box">' +
          '<img class="empty-logo" src="' + esc(BRAND_ICON) + '" alt="PT Scans" />' +
          '<div style="font-size:18px;font-weight:800;color:#f4f8ff;margin-bottom:8px;">Biblioteca AniList</div>' +
          '<div style="font-size:13px;line-height:1.6;color:#9db1d3;">Insere o teu nome de utilizador e carrega a biblioteca.</div>' +
          '</div></div>';
      }

      html += '</div>';
      return html;
    }

    /* ── eventos da biblioteca (chamado após render) ── */
    function attachLibraryEvents() {
      const loadBtn = document.getElementById("loadLibraryBtn");
      const backBtn = document.getElementById("backToSearchBtn");

      if (loadBtn) {
        loadBtn.addEventListener("click", async () => {
          const userInput = document.getElementById("anilistUser");
          const user = userInput ? userInput.value.trim() : "";
          if (!user) { state.status = "Por favor, insere um nome de utilizador"; render(); return; }
          state.anilistUser = user;
          state.libraryLoading = true;
          state.status = "A carregar biblioteca de " + user + "...";
          render();
          try {
            state.libraryResults = await fetchAniListLibrary(user);
            state.status = "Biblioteca carregada: " + state.libraryResults.length + " mangas";
          } catch (e) {
            state.libraryResults = [];
            state.status = "Erro: " + (e && e.message ? e.message : "Falha ao carregar");
          } finally {
            state.libraryLoading = false;
            render();
          }
        });
      }

      if (backBtn) {
        backBtn.addEventListener("click", () => {
          window.webview.send("setMode", "search");
        });
      }

      document.querySelectorAll(".provider-btn").forEach(btn => {
        btn.addEventListener("click", () => openProviderModal(btn.dataset.title));
      });
    }

    /* ── ligar botões da topbar (executado uma vez após DOM pronto) ── */
    function attachTopbarEvents() {
      document.getElementById("searchBtn").addEventListener("click", () => {
        const q = document.getElementById("query").value;
        window.webview.send("search", q);
      });

      document.getElementById("query").addEventListener("keydown", e => {
        if (e.key === "Enter") {
          window.webview.send("search", e.target.value);
        }
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
        providerCache = null;
        window.webview.send("reloadProvider");
      });

      document.getElementById("libraryBtn").addEventListener("click", () => {
        window.webview.send("setMode", "library");
      });
    }

    /* ── canal webview → state ── */
    window.webview.on("results", value => { state.results = value || []; render(); });
    window.webview.on("status",  value => { state.status  = value || "Pronto"; render(); });
    window.webview.on("loading", value => { state.loading = !!value; render(); });
    window.webview.on("query",   value => { state.query   = value || ""; render(); });
    window.webview.on("mode",    value => { state.mode    = value; render(); });

    /* ── arranque ── */
    attachTopbarEvents();
    render();
  </script>
</body>
</html>
    `);
  });
}
