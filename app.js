/* Mapa das calçadas de São Paulo.
 *
 * Duas resoluções, e a segunda é o assunto:
 *   cidade    96 distritos, pintados pela taxa das calçadas deles
 *   distrito  a calçada em si, uma a uma — 491.383 polígonos do GeoSampa
 *
 * Os filtros SUBTRAEM calçada do mapa: ligar "sem obstáculo" apaga as que têm.
 * Os cartões recalculam sobre o que sobrou, nunca sobre média de percentual.
 */
const $ = s => document.querySelector(s);
const num = n => Math.round(n).toLocaleString("pt-BR");
const pct = (n, c = 1) => n == null || Number.isNaN(n) ? "—" : n.toFixed(c).replace(".", ",") + "%";
const metros = n => n == null || Number.isNaN(n) ? "—" : n.toFixed(2).replace(".", ",") + " m";

const BBOX_PILOTO = [[-23.5717, -46.7030], [-23.5482, -46.6805]];
const ZOOM_CALCADA = 14;    // a partir daqui o mapa troca sozinho para a calçada
const ZOOM_PONTOS = 13;     // a partir daqui, árvore e poste um a um (só no piloto)
const MAX_EM_CACHE = 3;     // um distrito chega a 5 MB de JSON: não guardar os 96

/* Limiares do Decreto Municipal 59.671/2020 e da NBR 9050. Os mesmos do
 * preparar_dados.py — se mudarem, mudam nos dois lados. */
const FAIXA_LIVRE_MIN = 1.20;
const FAIXA_SERVICO = 0.70;
const DECLIVIDADE_MAX = 8.33;

/* Métricas que pintam o distrito na visão de cidade e ordenam a tabela.
 * `campo` já é uma taxa pronta (GeoSampa, por calçada); `num`/`den` são
 * contagens do Censo que o cartão soma. `pior` diz para que lado escurece. */
const METRICAS = {
  barreira:   {rot: "barreira", campo: "cal_barreira", pior: "alto", max: 90,
               dica: "calçada estreita ou íngreme"},
  estreita:   {rot: "estreita", campo: "cal_estreita", pior: "alto", max: 90,
               dica: "faixa livre menor que 1,20 m"},
  ingreme:    {rot: "íngreme", campo: "cal_ingreme", pior: "alto", max: 60,
               dica: "declividade acima de 8,33%"},
  obstaculo:  {rot: "com obstáculo", campo: "cal_obst", pior: "alto", max: 90,
               dica: "árvore ou poste na calçada"},
  pec:        {rot: "no Plano Emergencial", campo: "cal_pec", pior: "alto", max: 60,
               dica: "Decreto 58.845/2019"},
  sem_calcada: {rot: "sem calçada", num: "V05422", den: "V05400", pior: "alto", max: 60,
                dica: "Censo 2022, por face de quadra"},
  rampa:      {rot: "com rampa", num: "V05427", den: "V05421", pior: "baixo", max: 60,
               dica: "Censo 2022, por face de quadra"},
};

/* Os filtros. Cada um é um teste por calçada, e o que passa fica no mapa.
 * Ligados por E: quanto mais filtro, menos calçada sobra. */
const FILTROS = {
  larga: {rot: "faixa livre ≥ 1,20 m", ok: p => p.livre_min >= FAIXA_LIVRE_MIN},
  plana: {rot: "declividade ≤ 8,33%", ok: p => p.declive <= DECLIVIDADE_MAX},
  livre: {rot: "sem obstáculo", ok: p => p.obst === 0},
  pec:   {rot: "no Plano Emergencial", ok: p => p.pec === true},
};

const RAMPA = ["--s100", "--s200", "--s300", "--s400", "--s500", "--s600", "--s700"];
/* Em cache: `cor` é chamada por feição, e um distrito tem milhares de calçadas.
 * Ler a variável CSS a cada polígono força recálculo de estilo e engasga o mapa. */
const cacheCor = new Map();
function cor(v) {
  if (!cacheCor.has(v)) {
    cacheCor.set(v, getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  }
  return cacheCor.get(v);
}

/* Espera a mão parar antes de recalcular: uma rolagem de roda dispara uma rajada
 * de moveend/zoomend, e cada um deles repinta o mapa inteiro. */
function adiar(fn, ms = 160) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let metrica = "barreira";
let soFavela = false;
const ligados = new Set();          // filtros ativos
let ordemAsc = false;               // a tabela começa pelo pior
let busca = "";                     // texto da barra de busca
let naVista = null;                 // distritos dentro do enquadramento atual
let mapa, camadaDistritos, camadaCalcadas = null,
    camadaArvores = null, camadaPostes = null;
let distritos, municipio, distritoAberto = null, piloto = {};
let trocandoNivel = false;          // trava do drill-down automático por zoom
let zoomDeAbertura = null;          // abaixo dele, o mapa volta para a cidade
const emCache = new Map();          // slug -> GeoJSON parseado, no máximo MAX_EM_CACHE

/* ---------------- escala de cor ---------------- */
function faixa(valor, m) {
  if (valor == null || Number.isNaN(valor)) return cor("--sem-dado");
  let t = Math.min(1, Math.max(0, valor / m.max));
  if (m.pior === "baixo") t = 1 - t;          // escuro = pior, sempre
  return cor(RAMPA[Math.min(RAMPA.length - 1, Math.floor(t * RAMPA.length))]);
}

function valorDe(props, m) {
  if (m.campo) return props[m.campo] == null ? null : props[m.campo];
  const den = props[m.den];
  return den > 0 ? 100 * props[m.num] / den : null;
}

/* ---------------- cartões ---------------- */
/* Censo: somar contagens, nunca a média dos percentuais. */
function somar(listaProps) {
  const t = {};
  for (const cod of ["V05400", "V05421", "V05406", "V05412", "V05422", "V05424",
                     "V05427", "V05409", "V05415", "V05418", "V05430", "V05433"]) {
    t[cod] = listaProps.reduce((a, p) => a + (p[cod] || 0), 0);
  }
  t.criancas = listaProps.reduce((a, p) => a + (p.criancas_0a4 || 0), 0);
  t.idosos = listaProps.reduce((a, p) => a + (p.idosos_60 || 0), 0);
  return t;
}

/* GeoSampa: as taxas do distrito são percentuais sobre `cal_n` calçadas, então
 * juntar distritos é média ponderada pelo número de calçadas — não média simples. */
function somarCalcadas(listaProps) {
  const n = listaProps.reduce((a, p) => a + (p.cal_n || 0), 0);
  if (!n) return null;
  const peso = campo => listaProps.reduce(
    (a, p) => a + (p[campo] || 0) * (p.cal_n || 0), 0) / n;
  return {n, barreira: peso("cal_barreira"), estreita: peso("cal_estreita"),
          ingreme: peso("cal_ingreme"), obst: peso("cal_obst"), pec: peso("cal_pec")};
}

function pintarCartoes(onde, base, props) {
  const c = somarCalcadas(props);
  if (!c) {
    $("#cartoes").innerHTML = `<div class="onde">${onde}</div>
      <div class="base">nenhuma calçada nesta vista</div>`;
    return;
  }
  const t = somar(props);
  const F = t.V05400, C = t.V05421;
  const taxa = (n, d) => d > 0 ? 100 * n / d : null;
  $("#cartoes").innerHTML = `
    <div class="onde">${onde}</div>
    <div class="base">${num(c.n)} calçadas medidas · ${base}</div>
    <dl>
      <dt><b>barreira</b></dt><dd><b>${pct(c.barreira)}</b></dd>
      <dt>estreita</dt><dd>${pct(c.estreita)}</dd>
      <dt>íngreme</dt><dd>${pct(c.ingreme)}</dd>
      <dt>com obstáculo</dt><dd>${pct(c.obst)}</dd>
      <dt>no Plano Emergencial</dt><dd>${pct(c.pec)}</dd>
      <div class="sep"></div>
      <dt>face sem calçada nenhuma<span style="color:var(--ink-3)"> ¹</span></dt><dd>${pct(taxa(t.V05422, F))}</dd>
      <dt>face com rampa<span style="color:var(--ink-3)"> ¹</span></dt><dd>${pct(taxa(t.V05427, C))}</dd>
      ${t.criancas ? `<div class="sep"></div>
      <div class="pessoas">${num(t.criancas)} crianças de 0 a 4 anos e ${num(t.idosos)} pessoas
      com 60+ moram aqui.<br><span style="opacity:.75">¹ Censo 2022, por face de quadra</span></div>` : ""}
    </dl>`;
}

/* No distrito o cartão passa a contar calçada, e conta só a que sobrou do filtro. */
function pintarCartoesCalcada(nome, mostradas, total) {
  const n = mostradas.length;
  if (!n) {
    $("#cartoes").innerHTML = `<div class="onde">${nome}</div>
      <div class="base">nenhuma das ${num(total)} calçadas passa nos filtros</div>`;
    return;
  }
  const parte = f => 100 * mostradas.filter(f).length / n;
  const livres = mostradas.map(p => p.livre_min).sort((a, b) => a - b);
  const filtrado = n < total;
  $("#cartoes").innerHTML = `
    <div class="onde">${nome}</div>
    <div class="base">${filtrado ? `${num(n)} de ${num(total)} calçadas passam nos filtros`
                                 : `${num(n)} calçadas, uma a uma`}</div>
    <dl>
      <dt><b>barreira</b></dt><dd><b>${pct(parte(p => p.livre_min < FAIXA_LIVRE_MIN || p.declive > DECLIVIDADE_MAX))}</b></dd>
      <dt>estreita</dt><dd>${pct(parte(p => p.livre_min < FAIXA_LIVRE_MIN))}</dd>
      <dt>íngreme</dt><dd>${pct(parte(p => p.declive > DECLIVIDADE_MAX))}</dd>
      <dt>com obstáculo</dt><dd>${pct(parte(p => p.obst > 0))}</dd>
      <div class="sep"></div>
      <dt>faixa livre mediana</dt><dd>${metros(livres[Math.floor(n / 2)])}</dd>
      <dt>no Plano Emergencial</dt><dd>${pct(parte(p => p.pec))}</dd>
      <div class="sep"></div>
      <div class="pessoas">A cor é a faixa livre: mais forte, menos espaço para andar.
      Cada polígono é um trecho de calçada cadastrado pela Prefeitura.</div>
    </dl>`;
}

/* Quem está no enquadramento. Vale mesmo com um distrito aberto: a camada de
 * distritos sai do mapa mas continua viva, e é ela que a tabela lateral lê. */
function medirVista() {
  const b = mapa.getBounds();
  const dentro = [];
  camadaDistritos.eachLayer(l => {
    if (b.intersects(l.getBounds())) dentro.push(l.feature.properties);
  });
  naVista = new Set(dentro.map(p => p.NM_DIST));
  return dentro;
}

/* Recalcula para o que está na tela. É a interação central do painel. */
function atualizarPorVista() {
  const visiveis = medirVista();
  desenharTabela();
  if (distritoAberto) return;
  const todos = visiveis.length === distritos.features.length;
  pintarCartoes(todos ? "Município de São Paulo" : `${visiveis.length} distritos na tela`,
                todos ? "os 96 distritos" : "mova o mapa para mudar o recorte", visiveis);
}

/* Qual distrito está sob o centro do mapa — é o que o drill-down por zoom abre.
 * ponytail: testa a caixa envolvente, não o polígono. Em divisa recortada pode
 * pegar o vizinho; desempata pela caixa menor, que é a mais específica. Se um
 * dia isso incomodar, o passo seguinte é ponto-em-polígono nas coordenadas. */
function distritoNoCentro() {
  const c = mapa.getCenter();
  let achado = null, menor = Infinity;
  camadaDistritos.eachLayer(l => {
    const b = l.getBounds();
    if (!b.contains(c)) return;
    const area = (b.getEast() - b.getWest()) * (b.getNorth() - b.getSouth());
    if (area < menor) { menor = area; achado = l.feature.properties; }
  });
  return achado;
}

/* O zoom troca de nível sozinho: passou de ZOOM_CALCADA, a calçada entra; voltou
 * para trás, a cidade volta. Sem reenquadrar — quem mandou no enquadramento foi
 * o usuário, e refazer fitBounds aqui roubaria o mapa da mão dele. */
/* A decisão em si, sem mapa: é a parte que erra feio se errar — abrir e fechar
 * em sequência num zoom só vira piscada infinita. Coberta no autoteste. */
function decidirNivel(z, alvoId, abertoId, zAbertura) {
  if (z >= ZOOM_CALCADA && alvoId && alvoId !== abertoId) return "entrar";
  // Sair pelo zoom de entrada, não por ZOOM_CALCADA: um distrito grande como o
  // Grajaú enquadra em 12, e a regra fixa o fecharia no instante em que abriu.
  if (abertoId && zAbertura != null && z < zAbertura) return "sair";
  return null;
}

async function porZoom() {
  if (trocandoNivel) return;
  const z = mapa.getZoom();
  const alvo = z >= ZOOM_CALCADA ? distritoNoCentro() : null;
  const acao = decidirNivel(z, alvo && alvo.id,
                            distritoAberto && distritoAberto.id, zoomDeAbertura);
  if (!acao) return;
  trocandoNivel = true;
  try {
    if (acao === "entrar") await abrirDistrito(alvo, false);
    else voltarACidade(false);
  } finally { trocandoNivel = false; }
}

/* ---------------- camadas ---------------- */
function estilo(props) {
  return {fillColor: faixa(valorDe(props, METRICAS[metrica]), METRICAS[metrica]),
          fillOpacity: .78, color: cor("--surface"), weight: .8};
}

function dica(e, html) {
  const d = $("#dica"), r = $("#mapa").getBoundingClientRect();
  d.innerHTML = html;
  d.style.opacity = 1;
  const x = e.originalEvent.clientX - r.left, y = e.originalEvent.clientY - r.top;
  d.style.left = Math.min(x + 14, r.width - d.offsetWidth - 8) + "px";
  d.style.top = Math.max(y - d.offsetHeight - 12, 6) + "px";
}
const escondeDica = () => { $("#dica").style.opacity = 0; };

function ligarDistrito(l, props) {
  // `metrica` é lida na hora do mouse, não presa no bind: trocar a pill muda a dica.
  l.on("mousemove", e => {
    const m = METRICAS[metrica];
    dica(e, `<b>${props.NM_DIST}</b><br>${m.rot}:
      <span class="v">${pct(valorDe(props, m))}</span><br>${num(props.cal_n)} calçadas`);
  });
  l.on("mouseout", escondeDica);
  l.on("click", () => abrirDistrito(props));
}

function desenharDistritos() {
  if (camadaDistritos) mapa.removeLayer(camadaDistritos);
  camadaDistritos = L.geoJSON(distritos, {
    renderer: L.canvas({padding: .3}),
    style: f => estilo(f.properties),
    onEachFeature: (f, l) => ligarDistrito(l, f.properties)
  }).addTo(mapa);
  atualizarPorVista();
}

/* ---------------- a calçada ---------------- */
function corDaCalcada(p) {
  if (p.livre_min == null) return cor("--sem-dado");
  const t = Math.min(1, Math.max(0, p.livre_min / 3.0));
  return cor(RAMPA[Math.min(6, Math.floor((1 - t) * 7))]);
}

const passaNosFiltros = p =>
  (!soFavela || p.em_favela) && [...ligados].every(k => FILTROS[k].ok(p));

/* Remontar a camada é o jeito de aplicar filtro: `L.geoJSON({filter})` só é
 * avaliado na construção. Alguns milhares de polígonos em canvas é barato. */
function montarCalcadas() {
  if (!distritoAberto) return;
  const gj = emCache.get(distritoAberto.id);
  if (camadaCalcadas) mapa.removeLayer(camadaCalcadas);
  camadaCalcadas = L.geoJSON(gj, {
    renderer: L.canvas({padding: .3}),
    filter: f => passaNosFiltros(f.properties),
    // O contorno é da MESMA cor do preenchimento, não do fundo: uma calçada tem
    // 2 m de largura e some no zoom do distrito inteiro se o traço a apagar.
    style: f => {
      const c = corDaCalcada(f.properties);
      return {fillColor: c, fillOpacity: .92, color: c, weight: 1.1, opacity: .9};
    },
    onEachFeature: (f, l) => {
      const p = f.properties;
      // a largura cadastrada é a faixa livre de volta com a faixa de serviço
      const larg = p.livre_min + (p.obst > 0 ? FAIXA_SERVICO : 0);
      l.on("mousemove", e => dica(e, `<b>${p.rua || "via sem nome"}</b><br>
        faixa livre <span class="v">${metros(p.livre_min)}</span><br>
        largura ${metros(larg)} · declive ${pct(p.declive)}<br>
        ${p.obst} obstáculo${p.obst === 1 ? "" : "s"}${p.pec ? " · Plano Emergencial" : ""}`));
      l.on("mouseout", escondeDica);
    }
  }).addTo(mapa);
  const mostradas = gj.features.map(f => f.properties).filter(passaNosFiltros);
  pintarCartoesCalcada(distritoAberto.NM_DIST, mostradas, gj.features.length);
}

async function abrirDistrito(props, enquadrar = true) {
  const id = props.id;
  if (!emCache.has(id)) {
    $("#carregando").textContent = `carregando as calçadas de ${props.NM_DIST}…`;
    $("#carregando").style.display = "grid";
    emCache.set(id, await fetch(`dados/calcadas/${id}.geojson`).then(r => r.json()));
    // Um distrito chega a alguns MB de JSON parseado. Guardar os 96 é o caminho
    // mais curto para a aba estourar de memória.
    while (emCache.size > MAX_EM_CACHE) emCache.delete(emCache.keys().next().value);
    $("#carregando").style.display = "none";
  }
  distritoAberto = props;
  montarCalcadas();
  if (camadaDistritos) mapa.removeLayer(camadaDistritos);
  if (enquadrar) mapa.fitBounds(camadaCalcadas.getBounds(), {padding: [24, 24], animate: false});
  zoomDeAbertura = enquadrar ? Math.min(ZOOM_CALCADA, mapa.getZoom()) : ZOOM_CALCADA;
  desenharLegenda();
  marcarLinha(props.NM_DIST);
  $("#voltar").hidden = false;
}

function voltarACidade(enquadrar = true) {
  distritoAberto = null;
  zoomDeAbertura = null;
  if (camadaCalcadas) { mapa.removeLayer(camadaCalcadas); camadaCalcadas = null; }
  desenharDistritos();
  if (enquadrar) mapa.fitBounds(camadaDistritos.getBounds(), {padding: [12, 12], animate: false});
  desenharLegenda();
  marcarLinha(null);
  $("#voltar").hidden = true;
}

/* Árvore e poste desenhados um a um só existem no recorte do piloto: são as
 * únicas camadas de ponto em disco. Fora dali os botões ficam desligados — e o
 * `title` diz por quê, senão o botão apagado parece defeito. */
async function alternarPontos() {
  const dentro = mapa.getZoom() >= ZOOM_PONTOS &&
                 mapa.getBounds().intersects(L.latLngBounds(BBOX_PILOTO));
  $("#lay-arvores").disabled = $("#lay-postes").disabled = !dentro;
  if (!dentro) {
    [camadaArvores, camadaPostes].forEach(c => c && mapa.removeLayer(c));
    camadaArvores = camadaPostes = null;
    return;
  }
  if (camadaArvores || piloto.montando) return;
  piloto.montando = true;
  try {
    if (!piloto.arvores) {
      [piloto.arvores, piloto.postes] = await Promise.all([
        fetch("dados/piloto_arvores.json").then(r => r.json()),
        fetch("dados/piloto_postes.json").then(r => r.json())]);
    }
    // UMA tela para os 19.783 pontos. `L.canvas()` chamado aqui dentro do map
    // criava um renderer por marcador — 19.783 canvas — e travava o navegador.
    // O gate de zoom 15 escondia o defeito: este caminho quase nunca rodava.
    const tela = L.canvas({padding: .3});
    const pt = (lista, c, r) => L.layerGroup(lista.map(([x, y]) =>
      L.circleMarker([y, x], {radius: r, color: c, weight: 0, fillOpacity: .75,
                              renderer: tela})));
    camadaArvores = pt(piloto.arvores, cor("--serie-1"), 1.8);
    camadaPostes = pt(piloto.postes, cor("--serie-2"), 1.4);
    if ($("#lay-arvores").getAttribute("aria-pressed") === "true") camadaArvores.addTo(mapa);
    if ($("#lay-postes").getAttribute("aria-pressed") === "true") camadaPostes.addTo(mapa);
  } finally { piloto.montando = false; }
}

/* ---------------- tabela de distritos ---------------- */
const semAcento = s => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/* Três coisas decidem o que a tabela mostra, nesta ordem: a busca é global — é a
 * saída para achar um distrito que não está na tela —, o enquadramento recorta o
 * resto, e o cabeçalho escolhe a direção. */
function desenharTabela() {
  const m = METRICAS[metrica];
  const termo = semAcento(busca.trim());
  const todos = distritos.features.map(f => f.properties).filter(p => valorDe(p, m) != null);
  const buscando = termo.length > 0;
  const fs = (buscando ? todos.filter(p => semAcento(p.NM_DIST).includes(termo))
                       : naVista ? todos.filter(p => naVista.has(p.NM_DIST)) : todos)
    .sort((a, b) => ordemAsc ? valorDe(a, m) - valorDe(b, m) : valorDe(b, m) - valorDe(a, m));

  const quantos = buscando ? `${fs.length} encontrado${fs.length === 1 ? "" : "s"}`
                           : `${fs.length} na tela`;
  $("#tabela").innerHTML = fs.length === 0 ? `<p class="tab-vazia">nenhum distrito ${
    buscando ? "com esse nome" : "nesta vista"}</p>` : `
    <table class="tab">
      <thead><tr>
        <th scope="col">distrito <span class="quantos">${quantos}</span></th>
        <th scope="col"><button id="ordenar" aria-label="ordenar por ${m.rot}, ${
          ordemAsc ? "crescente" : "decrescente"}">${m.rot} ${ordemAsc ? "▲" : "▼"}</button></th>
      </tr></thead>
      <tbody>${fs.map(p => {
        const v = valorDe(p, m);
        return `<tr data-d="${p.NM_DIST}" aria-current="false">
          <th scope="row"><button title="${p.NM_DIST}">${p.NM_DIST}</button></th>
          <td><span class="barra" style="width:${Math.min(100, 100 * v / m.max).toFixed(1)}%"></span>
              <span class="v">${pct(v)}</span></td></tr>`;
      }).join("")}</tbody>
    </table>`;
  const ord = $("#ordenar");
  if (ord) ord.onclick = () => { ordemAsc = !ordemAsc; desenharTabela(); };
  $("#tabela").querySelectorAll("tr[data-d] button").forEach(b => b.onclick = () => {
    const nome = b.closest("tr").dataset.d;
    abrirDistrito(distritos.features.find(f => f.properties.NM_DIST === nome).properties);
  });
  if (distritoAberto) marcarLinha(distritoAberto.NM_DIST);
}

function marcarLinha(nome) {
  $("#tabela").querySelectorAll("tr[data-d]").forEach(tr => {
    const aceso = tr.dataset.d === nome;
    tr.setAttribute("aria-current", aceso);
    // rolar só o painel: scrollIntoView levaria a página junto
    if (aceso) $("#tabela").scrollTop = tr.offsetTop - $("#tabela").clientHeight / 2;
  });
}

/* ---------------- controles e legenda ---------------- */
function desenharControles() {
  $("#controles").innerHTML = `
    <div class="grupo"><span>pintar o mapa por</span><div class="pills" id="pills-metrica">
      ${Object.entries(METRICAS).map(([k, m]) =>
        `<button data-m="${k}" aria-pressed="${k === metrica}">${m.rot}</button>`).join("")}
    </div></div>
    <div class="grupo"><span>mostrar só as calçadas que</span><div class="pills" id="pills-filtro">
      ${Object.entries(FILTROS).map(([k, f]) =>
        `<button data-f="${k}" aria-pressed="false">${f.rot}</button>`).join("")}
    </div></div>
    <div class="grupo"><span>camadas do piloto</span><div class="pills">
      <button id="lay-arvores" aria-pressed="true" disabled
        title="árvores desenhadas uma a uma só existem em Pinheiros e Vila Madalena; aproxime o mapa lá">árvores</button>
      <button id="lay-postes" aria-pressed="true" disabled
        title="postes desenhados um a um só existem em Pinheiros e Vila Madalena; aproxime o mapa lá">postes</button>
    </div></div>
    <div class="grupo"><span>recorte</span><div class="pills">
      <button id="btn-favela" aria-pressed="false">só favela e comunidade urbana</button>
      <button id="voltar" hidden>voltar à cidade</button>
    </div></div>`;

  $("#pills-metrica").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    metrica = b.dataset.m;
    $("#pills-metrica").querySelectorAll("button").forEach(x =>
      x.setAttribute("aria-pressed", x.dataset.m === metrica));
    repintar();
  };
  $("#pills-filtro").onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    const k = b.dataset.f;
    ligados.has(k) ? ligados.delete(k) : ligados.add(k);
    b.setAttribute("aria-pressed", ligados.has(k));
    montarCalcadas();
  };
  const alterna = (id, camada) => $(id).onclick = () => {
    const on = $(id).getAttribute("aria-pressed") !== "true";
    $(id).setAttribute("aria-pressed", on);
    const c = camada();
    if (c) on ? c.addTo(mapa) : mapa.removeLayer(c);
  };
  alterna("#lay-arvores", () => camadaArvores);
  alterna("#lay-postes", () => camadaPostes);
  $("#btn-favela").onclick = () => {
    soFavela = !soFavela;
    $("#btn-favela").setAttribute("aria-pressed", soFavela);
    montarCalcadas();
  };
  $("#voltar").onclick = () => voltarACidade();
  $("#busca").oninput = adiar(e => { busca = e.target.value; desenharTabela(); }, 120);
}

function repintar() {
  if (camadaDistritos && !distritoAberto) camadaDistritos.setStyle(f => estilo(f.properties));
  desenharLegenda();
  desenharTabela();
}

function desenharLegenda() {
  const m = METRICAS[metrica];
  // A rampa é sempre clara→escura da esquerda para a direita. Invertê-la quando
  // "pior" é o valor baixo fazia a escala saltar de lado ao trocar a métrica;
  // quem troca de ponta são os números, e "escuro = pior" continua valendo.
  const [esq, dir] = m.pior === "baixo" ? [`${m.max}%`, "0%"] : ["0%", `${m.max}%`];
  if (distritoAberto) {
    $("#legenda").innerHTML = `
      <div class="titulo">faixa livre — mais forte, menos espaço</div>
      <div class="escala">${[...RAMPA].reverse().map(s => `<i style="background:${cor(s)}"></i>`).join("")}</div>
      <div class="escala-rot"><span>0 m</span><span>3 m ou mais</span></div>
      <div class="nd"><i></i>sem medida</div>`;
    return;
  }
  $("#legenda").innerHTML = `
    <div class="titulo">${m.rot}${m.dica ? ` — ${m.dica}` : ""}</div>
    <div class="escala">${RAMPA.map(s => `<i style="background:${cor(s)}"></i>`).join("")}</div>
    <div class="escala-rot"><span>${esq}</span><span>mais forte = pior</span><span>${dir}</span></div>
    <div class="nd"><i></i>sem calçada cadastrada</div>`;
}

function pintarFaixa() {
  const c = municipio.calcadas;
  $("#vao").innerHTML = `
    <div class="lado destaque"><dt>é barreira</dt>
      <dd>${pct(c.barreira)}<small>a calçada é estreita demais ou íngreme demais para passar</small></dd></div>
    <div class="lado"><dt>estreita</dt>
      <dd>${pct(c.estreita)}<small>faixa livre abaixo de 1,20 m, já descontando árvore e poste</small></dd></div>
    <div class="lado"><dt>com obstáculo</dt>
      <dd>${pct(c.obst)}<small>árvore ou poste plantado dentro da calçada</small></dd></div>
    <div class="lado"><dt>passa em tudo</dt>
      <dd>${pct(c.passa_tudo)}<small>das ${num(c.calcadas)} calçadas cadastradas no município</small></dd></div>`;
}

/* ---------------- autoteste ---------------- */
/* `verificar.py` guarda o lado Python. Aqui o erro que mais custaria seria o
 * navegador fazer média de percentual em vez de ponderar pelo número de
 * calçadas: os cartões ficariam plausíveis e errados. Abra com #autoteste. */
function autoteste() {
  const props = distritos.features.map(f => f.properties);
  const t = somar(props), c = somarCalcadas(props), mc = municipio.calcadas;
  const simples = props.reduce((a, p) => a + p.cal_barreira, 0) / props.length;
  const linhas = [
    ["faces", t.V05400, municipio.faces],
    ["crianças 0 a 4", t.criancas, municipio.criancas_0a4],
    ["% com calçada", 100 * t.V05421 / t.V05400, municipio.taxas.calcada],
    ["calçadas", c.n, mc.calcadas],
    ["% barreira", c.barreira, mc.barreira],
    ["% estreita", c.estreita, mc.estreita],
    ["% com obstáculo", c.obst, mc.obst],
  ];
  // A troca de nível por zoom, nos casos que fariam o mapa piscar
  const nivel = [
    ["cidade, zoom longe", decidirNivel(10, null, null, null), null],
    ["cidade, zoom perto", decidirNivel(15, "se", null, null), "entrar"],
    ["fica no distrito aberto", decidirNivel(15, "se", "se", ZOOM_CALCADA), null],
    ["troca de distrito ao lado", decidirNivel(15, "bras", "se", ZOOM_CALCADA), "entrar"],
    ["volta à cidade ao afastar", decidirNivel(13, null, "se", ZOOM_CALCADA), "sair"],
    ["distrito grande não fecha sozinho", decidirNivel(12, null, "grajau", 12), null],
    ["aberto no clique, zoom 13, não fecha", decidirNivel(13, null, "pinheiros", 13), null],
  ];
  // A busca precisa achar "Sé" digitando "se" e "Tremembé" digitando "tremembe"
  nivel.push(["busca ignora acento", semAcento("Sé").includes(semAcento("se")), true],
             ["busca ignora acento no meio", semAcento("Tremembé").includes("tremembe"), true],
             ["busca não casa o que não é", semAcento("Moema").includes("grajau"), false]);
  const falhasNivel = nivel.filter(([, obtido, esperado]) => obtido !== esperado);
  const falhas = linhas.filter(([, obtido, esperado]) => Math.abs(obtido - esperado) > 0.06);
  const barra = document.createElement("div");
  barra.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:9px 14px;" +
    "font:500 12px/1.4 'IBM Plex Mono',monospace;color:#fff;background:" +
    ((falhas.length || falhasNivel.length) ? "#8f2a17" : "#14532d");
  barra.textContent = (falhas.length || falhasNivel.length)
    ? "autoteste: " + [...falhas.map(([r, a, b]) => `${r} ${a.toFixed(2)} ≠ ${b}`),
                       ...falhasNivel.map(([r, a, b]) => `${r}: ${a} ≠ ${b}`)].join(" · ")
    : `autoteste: ok · ${linhas.length} números batem com municipio.json · ` +
      `${nivel.length} casos de troca de nível e busca · ` +
      `média simples daria ${simples.toFixed(2)}% de barreira, ponderada dá ${c.barreira.toFixed(2)}%`;
  document.body.appendChild(barra);
}

/* ---------------- partida ---------------- */
(async function () {
  // zoom à direita: à esquerda ele fica por baixo do painel de cartões
  mapa = L.map("mapa", {preferCanvas: true, zoomControl: false, minZoom: 9, maxZoom: 19});
  L.control.zoom({position: "topright"}).addTo(mapa);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(mapa);
  mapa.setView([-23.65, -46.63], 10);

  [municipio, distritos] = await Promise.all([
    fetch("dados/municipio.json").then(r => r.json()),
    fetch("dados/distritos.geojson").then(r => r.json())]);

  pintarFaixa();
  desenharControles();
  desenharDistritos();
  desenharLegenda();
  desenharTabela();
  mapa.fitBounds(camadaDistritos.getBounds(), {padding: [12, 12], animate: false});
  $("#carregando").style.display = "none";

  mapa.on("moveend zoomend", adiar(() => { porZoom(); atualizarPorVista(); alternarPontos(); }));

  // Link direto para uma vista: #m=rampa&d=grajau&f=larga,livre
  const par = new URLSearchParams(location.hash.slice(1));
  if (METRICAS[par.get("m")]) {
    metrica = par.get("m");
    $("#pills-metrica").querySelectorAll("button").forEach(x =>
      x.setAttribute("aria-pressed", x.dataset.m === metrica));
    repintar();
  }
  (par.get("f") || "").split(",").filter(k => FILTROS[k]).forEach(k => {
    ligados.add(k);
    $(`#pills-filtro button[data-f="${k}"]`).setAttribute("aria-pressed", "true");
  });
  const alvo = par.get("d") &&
    distritos.features.find(f => f.properties.id === par.get("d"));
  if (alvo) await abrirDistrito(alvo.properties);

  if (par.has("autoteste")) autoteste();
})();
