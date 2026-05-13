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
        panel.setContent(() => `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html{color-scheme:dark;overflow:hidden}:root{--line:rgba(255,255,255,.09);--text:#edf4ff;--muted:#98a9c7;--blue:#5ea2ff;--shadow:0 18px 50px rgba(0,0,0,.38)}*{box-sizing:border-box}body{margin:0;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:transparent;overflow:hidden}.overlay{position:relative;width:100%;height:100vh;padding:18px;overflow:hidden;background:radial-gradient(circle at 12% 12%,rgba(94,162,255,.20),transparent 24%),radial-gradient(circle at 86% 14%,rgba(155,124,255,.18),transparent 24%),rgba(2,6,18,.42);backdrop-filter:blur(18px) saturate(140%)}.window{position:relative;width:100%;height:calc(86vh - 6px);border-radius:28px;overflow:hidden;background:linear-gradient(180deg,rgba(14,20,36,.84),rgba(8,12,23,.78));border:1px solid rgba(255,255,255,.11);box-shadow:var(--shadow);backdrop-filter:blur(22px);animation:fadeUp .35s ease}.topbar,.meta,.filters{display:flex;gap:10px}.topbar{align-items:center;padding:18px 20px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:14px;min-width:220px}.brand-logo{width:34px;height:34px;object-fit:contain}.brand-title{font-size:17px;font-weight:800}.searchbar{flex:1;display:flex;gap:10px;align-items:center}.searchbar input{width:100%;height:50px;border-radius:16px;border:1px solid rgba(255,255,255,.09);background:rgba(6,10,19,.42);color:#fff;padding:0 16px 0 40px;outline:none;font-size:14px}.btn{height:50px;border-radius:16px;border:1px solid rgba(255,255,255,.09);padding:0 16px;color:#fff;cursor:pointer;font-weight:800;font-size:13px;background:rgba(255,255,255,.045)}.btn-primary{background:linear-gradient(135deg,#3b82f6,#2563eb)}.meta{justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,.05);color:var(--muted);font-size:13px}.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:9px 13px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);color:#dbe7ff}.filters{padding:12px 20px 0;flex-wrap:wrap}.filter-chip{border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04);color:#d7e5ff;height:38px;padding:0 14px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:800}.content{position:relative;padding:18px 20px 22px;height:calc(100% - 220px);overflow:auto}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:18px}.card{display:flex;gap:14px;padding:14px;min-height:190px;border-radius:24px;background:rgba(13,18,30,.72);border:1px solid rgba(255,255,255,.08)}.cover,.fallback{width:106px;height:150px;border-radius:18px;flex-shrink:0}.cover{object-fit:cover}.fallback{display:flex;align-items:center;justify-content:center;color:#8ea2c5;font-size:12px}.info{min-width:0;width:100%;display:flex;flex-direction:column;justify-content:space-between}.title{font-size:17px;font-weight:800;line-height:1.34;margin:0 0 10px 0;color:#f7fbff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.chip{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.05);color:#d8e4fb}.chip.ok{color:#c8ffe0;background:rgba(34,197,94,.11);border-color:rgba(34,197,94,.19)}.chip.no{color:#ffd0d8;background:rgba(239,68,68,.10);border-color:rgba(239,68,68,.18)}.chip.source{color:#d5e7ff;background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.18)}.sub{color:var(--muted);font-size:12px;line-height:1.45;word-break:break-word;opacity:.95}.empty{display:flex;align-items:center;justify-content:center;min-height:380px;border-radius:26px;border:1px dashed rgba(255,255,255,.10);background:radial-gradient(circle at top,rgba(94,162,255,.08),transparent 36%),rgba(255,255,255,.025);color:#9db1d3;text-align:center;padding:32px}.loading-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:18px}.skeleton{position:relative;min-height:190px;border-radius:24px;overflow:hidden;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02)),rgba(13,18,30,.6);border:1px solid rgba(255,255,255,.07)}.skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.08),transparent);animation:skeleton 1.4s infinite}@keyframes skeleton{100%{transform:translateX(100%)}}@keyframes fadeUp{from{opacity:0;transform:translateY(10px) scale(.988)}to{opacity:1;transform:translateY(0) scale(1)}}.status-wrap{display:inline-flex;align-items:center;gap:10px}.status-dot{width:9px;height:9px;border-radius:999px;background:var(--blue);box-shadow:0 0 18px rgba(94,162,255,.8);animation:pulse 1.3s ease-in-out infinite}@keyframes pulse{0%,100%{transform:scale(.88);opacity:.72}50%{transform:scale(1.2);opacity:1}}\n  </style>\n</head>\n<body>\n<div class=\"overlay\"><div class=\"window\"><div class=\"topbar\"><div class=\"brand\"><img class=\"brand-logo\" src=\"${BRAND_ICON}\" alt=\"PT Scans\"/><div class=\"brand-title\">PT Scans Search</div></div><div class=\"searchbar\"><input id=\"query\" placeholder=\"Pesquisar...\"/><button id=\"searchBtn\" class=\"btn btn-primary\">Pesquisar</button><button id=\"reloadBtn\" class=\"btn\">Reload</button><button id=\"clearBtn\" class=\"btn\">Limpar</button><button id=\"closeBtn\" class=\"btn\">Fechar</button></div></div><div class=\"meta\"><div class=\"status-wrap\"><div class=\"status-dot\"></div><div id=\"statusText\">Pronto</div></div><div class=\"pill\" id=\"resultMeta\">0 resultados</div></div><div class=\"filters\" id=\"sourceFilters\"></div><div class=\"content\"><div id=\"app\"></div></div></div></div>\n<script>\nconst BRAND_ICON=\"https://raw.githubusercontent.com/SKRAPT/PT-Scans/main/upscan.png\";const state={results:[],status:\"Pronto\",loading:false,query:\"\",sourceFilter:\"all\"};function esc(v){return String(v==null?\"\":v).replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\").replace(/\"/g,\"&quot;\").replace(/'/g,\"&#039;\")}function renderSkeletons(){return '<div class=\"loading-grid\">'+Array.from({length:6}).map(()=>'<div class=\"skeleton\"></div>').join('')+'</div>'}function getItemSource(item){if(item.rawSource)return item.rawSource;const rawId=String(item.id||\"\"),idx=rawId.indexOf(\":\");return idx!==-1?rawId.slice(0,idx):\"unknown\"}function buildSourceCounts(items){const c={all:items.length,mangaflix:0,mangalivre:0,hipercool:0,tiamanhwa:0,mangafire:0};items.forEach(i=>{const s=getItemSource(i);if(c[s]!=null)c[s]++});return c}function renderFilters(items){const wrap=document.getElementById(\"sourceFilters\");if(!wrap)return;const cnt=buildSourceCounts(items);const defs=[{key:\"all\",label:\"Todos\"},{key:\"mangaflix\",label:\"MangaFlix\"},{key:\"mangalivre\",label:\"MangaLivre\"},{key:\"hipercool\",label:\"HiperCool\"},{key:\"tiamanhwa\",label:\"TiaManhwa\"},{key:\"mangafire\",label:\"MangaFire\"}];wrap.innerHTML=defs.map(it=>'<button class=\"filter-chip '+(state.sourceFilter===it.key?\"active\":\"\")+'\" data-source=\"'+esc(it.key)+'\" type=\"button\">'+esc(it.label)+' ('+(cnt[it.key]||0)+')</button>').join('');wrap.querySelectorAll('.filter-chip').forEach(btn=>btn.addEventListener('click',()=>{state.sourceFilter=btn.dataset.source||'all';render()}))}function render(){const app=document.getElementById(\"app\");document.getElementById(\"statusText\").textContent=state.status||\"Pronto\";const input=document.getElementById(\"query\");if(document.activeElement!==input)input.value=state.query||\"\";const all=Array.isArray(state.results)?state.results:[];const filtered=state.sourceFilter===\"all\"?all:all.filter(i=>getItemSource(i)===state.sourceFilter);document.getElementById(\"resultMeta\").textContent=filtered.length+\" resultados\";renderFilters(all);if(state.loading&&all.length===0){app.innerHTML=renderSkeletons();return}if(filtered.length===0){app.innerHTML='<div class=\"empty\"><div><div style=\"font-size:18px;font-weight:800;color:#f4f8ff;margin-bottom:8px;\">PT Scans</div><div style=\"font-size:13px;line-height:1.6;color:#9db1d3;\">'+(all.length===0?'Pesquisa um título para começar.':'Não há resultados para este filtro.')+'</div></div></div>';return}app.innerHTML='<div class=\"grid\">'+filtered.map(item=>{const cover=item.image?'<img class=\"cover\" src=\"'+esc(item.image)+'\" alt=\"'+esc(item.title)+'\"/>':'<div class=\"fallback\">Sem capa</div>';return '<div class=\"card\">'+cover+'<div class=\"info\"><div><div class=\"title\">'+esc(item.title)+'</div><div class=\"stats\"><div class=\"chip source\">'+esc(item.source||getItemSource(item))+'</div><div class=\"chip '+(item.hasChapters?'ok':'no')+'\">Capítulos: '+(item.hasChapters?'Sim':'Não')+'</div><div class=\"chip\">Total: '+esc(item.chapterCount)+'</div><div class=\"chip\">Último: '+esc(item.latestChapter||'-')+'</div>'+(item.year?'<div class=\"chip\">Ano: '+esc(item.year)+'</div>':'')+'</div></div><div class=\"sub\">'+esc(item.id||\"\")+'</div></div></div>'}).join('')+'</div>'}\ndocument.getElementById(\"searchBtn\").addEventListener(\"click\",()=>window.webview.send(\"search\",document.getElementById(\"query\").value));document.getElementById(\"query\").addEventListener(\"keydown\",e=>{if(e.key===\"Enter\")window.webview.send(\"search\",document.getElementById(\"query\").value)});document.getElementById(\"clearBtn\").addEventListener(\"click\",()=>{document.getElementById(\"query\").value=\"\";state.sourceFilter=\"all\";window.webview.send(\"clear\")});document.getElementById(\"closeBtn\").addEventListener(\"click\",()=>window.webview.send(\"hide\"));document.getElementById(\"reloadBtn\").addEventListener(\"click\",()=>window.webview.send(\"reloadProvider\"));window.webview.on(\"results\",v=>{state.results=v||[];render()});window.webview.on(\"status\",v=>{state.status=v||\"Pronto\";render()});window.webview.on(\"loading\",v=>{state.loading=!!v;render()});window.webview.on(\"query\",v=>{state.query=v||\"\";render()});render();\n</script>\n</body>\n</html>\n    `);\n\n  });\n}\n```

Se quiseres, eu posso seguir com uma versão **melhorada de verdade** com histórico, favoritos e tabs animadas.
