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
}


// [LÓGICA JAVASCRIPT E ESTADOS (MANTER O SEU CÓDIGO DE FUNÇÕES AQUI)] 
/* ... (Funções como getProvider, runSearch, attachLibraryEvents etc.) */

<script>
    const BRAND_ICON = ${JSON.stringify(BRAND_ICON)};

    const state = {
      results:[], status:"Pronto", loading:false, query:"",
      sourceFilter:"all", mode:"search",
      libraryData:[], libraryUser:"",
      providerModal:null
    };

    function esc(v) {
      return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;";
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

/* ── MODAL RENDER (MANTIDO COMO ESTÁ PARA FUNCIONALIDADE) ── */
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
            '<div class="src-items">'+itemsHtml+'</div>';
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
        '</div >'+
      '</div>';

    document.getElementById("modalCloseX").addEventListener("click",closeModal);
    document.getElementById("modalFootClose").addEventListener("click",closeModal);
    document.getElementById("modalOverlay").addEventListener("click",e=>{if(e.target===e.currentTarget)closeModal();});
}


/* ── LIBRARY RENDER (MANTIDO COMO ESTÁ PARA FUNCIONALIDADE) ── */
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
            '<div class="progress-label"><span>Progresso</span><span'>"+pct+"%</span></div>'+
            '<div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%'"></div></div>'+
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


/* ── MAIN RENDER (Funções de renderização e evento) ── */
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


/* canal webview (EVENT HANDLERS) */
window.webview.on("results",      v=>{state.results=v||[];render();});
window.webview.on("status",       v=>{state.status=v||"Pronto";render();});
window.webview.on("loading",      v=>{state.loading=!!v;render();});
window.webview.on("query",        v=>{state.query=v||"";render();});
window.webview.on("mode",         v=>{state.mode=v;render();});
window.webview.on("libraryData",  v=>{state.libraryData=v||[];render();});
window.webview.on("providerModal", v=>{
  if(v!==null&&state.providerModal!==null){state.providerModal=v;renderModal();}
  else if(v===null){state.providerModal=null;renderModal();}
});

attachTopbarEvents();
render();
</script>


<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    /* ========================================================
       CYBERPUNK / NEON JAPANESE STYLE OVERRIDE (NOVO)
       ======================================================== */
    :root { 
        --text:#e0fffe; /* Azul neon claro */
        --muted:#98a9c7; 
        --neon-blue: #5ea2ff; /* Ciano elétrico principal */
        --neon-magenta: #d63bfa; /* Magenta vibrante */
        --dark-bg: #040816; /* Quase preto, mas com tonalidade azul */
    }

    /* RESET GERAL E FONTES DIGITAIS */
    * { box-sizing:border-box; margin:0; padding:0; }
    body { 
        color:var(--text); 
        font-family: 'Space Mono', monospace, sans-serif; /* Estilo de console */
        background: var(--dark-bg);
        overflow:hidden;
    }

    /* OVERLAY DE FUNDO GLOW/NEON (AUMENTANDO O EFEITO) */
    .overlay {
      position:relative; width:100%; height:100vh; padding:18px; overflow:hidden;
      background: radial-gradient(circle at 5% 10%, rgba(34,197,94,.2),transparent 20%),
                  radial-gradient(circle at 95% 80%, rgba(164,118,255,.15),transparent 20%),
                  linear-gradient(180deg,rgba(0,0,0,1),rgba(10,20,50,.96));
      backdrop-filter:blur(18px) saturate(140%);
    }
    /* Efeitos de Blob melhorados */
    .blob { position:absolute; width:300px; height:300px; left:-70px; top:-50px; border-radius:999px; filter:blur(60px); pointer-events:none; background:radial-gradient(circle,rgba(94,162,255,.1),transparent 30%); animation:driftA 18s ease-in-out infinite; }
    .blob::before { content:""; position:absolute; width:250px; height:250px; left:980px; top:80px; border-radius:999px; filter:blur(60px); background:radial-gradient(circle,rgba(164,118,255,.1),transparent 30%); animation:driftB 20s ease-in-out infinite; }
    @keyframes driftA{0%,100%{transform:translate3d(0,0,0) scale(1);}50%{transform:translate3d(60px,35px,0) scale(1.08);}}
    @keyframes driftB{0%,100%{transform:translate3d(0,0,0) scale(1);}50%{transform:translate3d(-70px,25px,0) scale(1.12);}}


    /* ------------------ MAIN WINDOW & TOPBAR (Efeito Console/HUD) ------------------ */
    .window {
      border:1px solid rgba(94,162,255,.3); /* Borda neon suave */
      box-shadow:0 30px 90px rgba(0,0,0,.7),inset 0 1px 1px rgba(255,255,255,.03);
      background:radial-gradient(circle at top left,rgba(4,16,38,.95),transparent 32%),linear-gradient(180deg,rgba(15,22,45,.98),rgba(8,12,23,.85));
      backdrop-filter:blur(20px); /* Blur mais intenso */
    }
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px) scale(.988);}to{opacity:1;transform:none;}}


    .topbar { 
        display:flex; align-items:center; gap:14px; padding:18px 20px; border-bottom:1px solid rgba(94,162,255,.3); background:rgba(7,11,24,.7); backdrop-filter:blur(20px); 
    }
    .brand { display:flex; align-items:center; gap:14px; min-width:200px; }
    /* Glow no logo */
    .brand-logo-wrap { position:relative; width:54px; height:54px; border-radius:18px; display:grid; place-items:center; background:linear-gradient(135deg,rgba(94,162,255,.26),rgba(155,124,255,.22)); border:1px solid rgba(255,255,255,.14); overflow:hidden; box-shadow:0 0 15px rgba(94,162,255,.1); }
    .brand-logo-wrap::after { content:""; position:absolute; inset:-20%; background:conic-gradient(from 180deg,transparent,rgba(255,255,255,.18),transparent 35%); animation:spinConic 6s linear infinite; }
    @keyframes spinConic{to{transform:rotate(360deg);}}
    .brand-logo { position:relative; z-index:1; width:34px; height:34px; object-fit:contain; }
    /* Texto com glow de texto */
    .brand-title { font-size:17px; font-weight:800; color:#eef4ff; text-shadow:0 0 5px rgba(94,162,255,.3); }


    /* Search Bar - O coração Cyberpunk */
    .searchbar { 
        flex:1; display:flex; gap:10px; min-width:0; align-items:center; background:rgba(10, 18, 30,.75); border:1px solid rgba(94,162,255,.3); box-shadow:0 0 20px rgba(94,162,255,.1) inset;
        border-radius:18px; padding:10px; backdrop-filter:blur(16px);
    }
    .search-shell { flex:1; position:relative; min-width:0; }
    .search-shell::before { content:"⌕"; position:absolute; left:14px; top:50%; transform:translateY(-50%); color:#9bb8eb; font-size:15px; pointer-events:none; text-shadow:0 0 5px rgba(94,162,255,.3); }
    .searchbar input { width:100%; height:50px; border-radius:16px; border:1px solid rgba(94,162,255,.5); background:rgba(0, 0, 0, .3); color:white; padding:0 16px 0 40px; outline:none; font-size:14px; transition:all .3s cubic-bezier(0.34,1.56,0.64,1); }
    /* GLOW ON FOCUS */
    .searchbar input:focus { 
        border-color:rgba(94,162,255,.8); 
        box-shadow:0 0 0 4px rgba(94,162,255,.3), inset 0 0 15px rgba(94,162,255,.2); /* Glow forte e foco */
        background:rgba(7,12,24,.85); 
    }
    .searchbar input::placeholder { color:rgba(155,177,227,.5); }


    /* Botões de Ação (Botão e Chips) */
    .btn { 
        height:50px; border-radius:16px; padding:0 16px; color:white; cursor:pointer; font-weight:800; font-size:13px; background:rgba(255,255,255,.045); border:1px solid rgba(94,162,255,.1); transition:transform .2s cubic-bezier(0.34,1.56,0.64,1),background .2s,border-color .2s,box-shadow .3s; 
    }
    /* Hover com efeito de glow neon */
    .btn:hover { 
        transform:translateY(-2px) scale(1.02); background:rgba(255,255,255,.09); border-color:rgba(94,162,255,.3); box-shadow:0 12px 30px rgba(94,162,255,.18); 
    }

    /* Botão primário principal (Mais Glow) */
    .btn-primary { background:linear-gradient(135deg,#3b82f6,#2563eb); border-color:rgba(94,162,255,.6); box-shadow:0 14px 28px rgba(37,99,235,.3); color:#fff; }
    .btn-primary:hover { background:linear-gradient(135deg,#5b9bff,#3b7fd4); box-shadow:0 18px 40px rgba(37,99,235,.42), inset 0 0 10px rgba(94,162,255,.4); transform:translateY(-3px) scale(1.03); }


    /* ESTADO E FILTROS (Meta e Chips) */
    .meta { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 20px; border-bottom:1px solid rgba(255,255,255,.08); color:var(--muted); font-size:13px; background:rgba(255,255,255,.02); }
    .status-wrap { display:inline-flex; align-items:center; gap:10px; }
    /* Pulso de energia */
    .status-dot { width:9px; height:9px; border-radius:999px; background:var(--neon-blue); box-shadow:0 0 18px rgba(94,162,255,.8); animation:pulseDot 1.3s ease-in-out infinite; flex-shrink:0; }
    @keyframes pulseDot{0%,100%{transform:scale(.88);opacity:.6;}50%{transform:scale(1.2);opacity:1;}}

    /* FILTROS DE SOURCE (Source Filters) */
    .filters { display:flex; gap:10px; padding:12px 20px 0; flex-wrap:wrap; }
    .filter-chip { 
        border:1px solid rgba(94,162,255,.3); /* Borda azul neon suave */
        background:rgba(0, 0, 0, .4); 
        color:#c0d8ff; 
        height:38px; padding:0 14px; border-radius:999px; cursor:pointer; font-size:12px; font-weight:800; 
        transition:all .25s cubic-bezier(0.34,1.56,0.64,1);
    }
    .filter-chip:hover { background:rgba(94,162,255,.1); border-color:rgba(94,162,255,.6); transform:translateY(-2px) scale(1.03); }
    /* Estado ativo neon duplo */
    .filter-chip.active { 
        background:linear-gradient(135deg,rgba(59,130,246,.4),rgba(147,51,234,.3)); 
        border-color:rgba(94,162,255,.8); 
        box-shadow:0 12px 30px rgba(59,130,246,.25); 
    }


    /* CONTEÚDO E CARDS */
    .content { position:relative; padding:18px 20px 22px; height:calc(100% - 186px); overflow:auto; scroll-behavior:smooth; background:rgba(8,12,22,.5); border-radius:0 0 32px 32px; border-top:1px solid rgba(255,255,255,.06); }
    .content::-webkit-scrollbar{width:10px;} .content::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:999px;}

    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(350px,1fr)); gap:18px; }
    /* CARDS COM GLOW DRAMÁTICO */
    .card { 
        position:relative; display:flex; gap:14px; padding:14px; min-height:190px; border-radius:24px; background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(13,18,30,.8)); border:1px solid rgba(94,162,255,.1); box-shadow:0 8px 30px rgba(0,0,0,.3), inset 0 0 5px rgba(94,162,255,.1); transition:transform .3s cubic-bezier(0.34,1.56,0.64,1),border-color .3s,box-shadow .3s; overflow:hidden; animation:cardIn .35s ease both; 
    }
    /* Efeito de hover com glow intenso */
    .card:hover { 
        transform:translateY(-8px) scale(1.02); border-color:rgba(94,162,255,.6); box-shadow:0 25px 60px rgba(37,99,235,.3),inset 0 0 15px rgba(94,162,255,.4); 
    }

    /* Imagem e Texto */
    .cover,.fallback { width:106px; height:150px; border-radius:18px; flex-shrink:0; }
    .cover { object-fit:cover; background:rgba(7,10,18,.55); border:1px solid rgba(255,255,255,.07); }
    /* Estilo fallback digital */
    .fallback { 
        border:1px solid rgba(255,255,255,.07); background:linear-gradient(180deg,rgba(20,27,43,.95),rgba(9,12,20,.95)); display:flex; align-items:center; justify-content:center; color:#8ea2c5; font-size:12px; text-align:center; padding:12px; box-shadow:inset 0 0 8px rgba(0,0,0,.2);
    }
    .info { min-width:0; width:100%; display:flex; flex-direction:column; justify-content:space-between; }
    /* Título com Glow de texto */
    .card-title { font-size:17px; font-weight:800; line-height:1.34; margin-bottom:10px; color:#d6faff; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-shadow:0 0 5px rgba(94,162,255,.3); }
    .stats { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }

    /* Chips com Cores Neon */
    .chip { display:inline-flex; align-items:center; border-radius:999px; padding:7px 11px; font-size:12px; font-weight:800; border:1px solid rgba(255,255,255,.06); background:rgba(255,255,255,.05); color:#d8e4fb; }
    .chip.ok  { color:#c8ffe0; background:linear-gradient(135deg,rgba(34,197,94,.15),rgba(34,197,94,.08)); border-color:rgba(34,197,94,.25); }
    .chip.no  { color:#ffd0d8; background:linear-gradient(135deg,rgba(239,68,68,.15),rgba(239,68,68,.08)); border-color:rgba(239,68,68,.25); }
    .chip.src { color:#d5e7ff; background:linear-gradient(135deg,rgba(59,130,246,.15),rgba(59,130,246,.08)); border-color:rgba(59,130,246,.25); }
    .sub { color:var(--muted); font-size:12px; line-height:1.45; word-break:break-word; opacity:.95; }


    /* Botões de Providers (Links) */
    .provider-btn { 
        margin-top:10px; width:100%; cursor:pointer; font-family:inherit; font-weight:800; font-size:12px; padding:9px 12px; border-radius:12px; background:linear-gradient(135deg,rgba(94,162,255,.12),rgba(155,124,255,.08)); border:1px solid rgba(94,162,255,.28); color:#c4e0ff; transition:all .25s cubic-bezier(0.34,1.56,0.64,1); 
    }
    /* Hover com glow neon */
    .provider-btn:hover { 
        background:linear-gradient(135deg,rgba(94,162,255,.24),rgba(155,124,255,.18)); border-color:rgba(94,162,255,.55); color:#c4e0ff; box-shadow:0 8px 20px rgba(94,162,255,.18); transform:translateY(-2px); 
    }

    /* Empty State - Glow de Alerta */
    .empty { display:flex; align-items:center; justify-content:center; min-height:380px; border-radius:26px; border:2px dashed rgba(94,162,255,.3); background:radial-gradient(circle at top,rgba(94,162,255,.1),transparent 36%),linear-gradient(135deg,rgba(255,255,255,.01),rgba(255,255,255,.005)); color:#9db1d3; text-align:center; padding:32px; animation:fadeUp .4s ease; }
    .empty-box { max-width:460px; }


</style>
</head>
<body class="overlay">
  <!-- O restante do HTML permanece inalterado -->
  <div class="overlay">
    <div class="blob"></div>
    <div class="window">
      <div class="shine"></div>

      <div class="topbar">
        <div class="brand">
          <div class="brand-logo-wrap">
            <img class="brand-logo" src="${BRAND_ICON}" alt="PT Scans" />
          </div >
          <div><div class="brand-title">PT Scans Search</div></div>
        </div>
        <div class="searchbar">
          <div class="search-shell"><input id="query" placeholder="Pesquisar manga..." /></div>
          <button id="searchBtn" class="btn btn-primary">Pesquisar</button>
          <button id="reloadBtn" class="btn">↺ Reload</button>
          <button id="clearBtn"  class="btn">Limpar</button>
          <button id="closeBtn"  class="btn">✕ Fechar</button>
        </div >
        <button id="libraryBtn" class="btn">📚 Biblioteca</button>
      </div >


      <div class="meta">
        <div class="status-wrap">
          <div class="status-dot"></div>
          <div id="statusText">Pronto</div>
        </div>
        <div class="pill" id="resultMeta">0 resultados</div >
      </div >


      <div class="filters" id="sourceFilters"></div >
      <div class="content"><div id="app"></div></div>
    </div>
  </div >

  <!-- Modal mount permanece igual -->
  <div id="modalMount"></div>

`;
