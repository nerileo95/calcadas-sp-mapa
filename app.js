/* Versão do conjunto app.js + dados/. O GitHub Pages serve com
 * `cache-control: max-age=600`, e os arquivos de `dados/` eram buscados SEM
 * parâmetro nenhum: mudar o dado e não mudar isto fazia o navegador continuar
 * lendo o JSON antigo — e um campo novo, como `dentro_norma`, chegava
 * `undefined` no cartão. Suba este número a cada publicação que mexa em
 * qualquer um dos dois. O `index.html` carrega `app.js?v=` com o mesmo valor.
 */
const V = "16";

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

const ZOOM_CALCADA = 14;    // a partir daqui o mapa troca sozinho para a calçada
const MAX_DISTRITOS = 6;    // quantos distritos de calçada desenhar ao mesmo tempo
const LIMITE_FEICOES = 45000;  // teto de polígonos na tela; o canvas engasga acima
const MAX_EM_CACHE = 8;     // um distrito chega a 5 MB de JSON: não guardar os 96

/* Limiares do Decreto Municipal 59.671/2020 e da NBR 9050. Os mesmos do
 * preparar_dados.py — se mudarem, mudam nos dois lados. */
const FAIXA_LIVRE_MIN = 1.20;
const FAIXA_SERVICO = 0.70;
const DECLIVIDADE_MAX = 8.33;

/* Métricas que pintam o distrito na visão de cidade e ordenam a tabela.
 * `campo` já é uma taxa pronta (GeoSampa, por calçada); `num`/`den` são
 * contagens do Censo que o cartão soma.
 *
 * A escala é sempre monotônica: valor menor à esquerda, maior à direita, cor
 * mais fraca à esquerda, mais forte à direita — em todos os indicadores. Custa
 * o "mais escuro = pior" universal, e `alto` passa a dizer, por métrica, se
 * muito é bom ou ruim. Em troca a escala nunca troca de lado ao mudar de
 * indicador, que era o que desorientava.
 *
 * `un` é a unidade e `base` é o denominador — sem ele um "32" na tabela não
 * diz 32 de quê. */
const METRICAS = {
  potencial:  {rot: "potencial de adoção", campo: "cal_potencial", max: 450, un: "",
               base: "crianças de 0 a 4 por km² que encontram calçada dentro da norma",
               alto: "melhor",
               ajuda: "Densidade de crianças de 0 a 4 anos multiplicada pela fração de "
                    + "calçadas que passam na norma. Responde onde um aplicativo de "
                    + "caminhada com carrinho teria gente para atender E calçada boa o "
                    + "bastante para entregar uma rota. Densidade e não contagem: por "
                    + "contagem o ranking vira o de população infantil e a calçada mal "
                    + "reordena. Só existe por distrito — a criança mora no setor "
                    + "censitário, não no trecho de calçada."},
  score:      {rot: "score de acessibilidade", campo: "cal_score", max: 35, un: "",
               base: "nota média das calçadas do distrito, de 0 a 100", alto: "melhor",
               ajuda: "Média das notas de passeio das calçadas do distrito. A nota soma "
                    + "sombra, iluminação, largura livre e terreno plano, e desconta "
                    + "reclamação. Vai de 0 a 100, mas a cidade real fica entre 0 e 55.",
               calcada: {valor: p => p.score, max: 55, alto: "melhor",
                         rot: "score de acessibilidade", pontas: ["0", "55 ou mais"]}},
  barreira:   {rot: "barreira", campo: "cal_barreira", max: 90, un: "%",
               base: "das calçadas do distrito", alto: "pior",
               ajuda: "Calçadas estreitas demais OU íngremes demais para passar: faixa "
                    + "livre abaixo de 1,20 m ou declividade média acima de 8,33%.",
               calcada: {valor: p => p.livre_min < FAIXA_LIVRE_MIN
                                        || p.declive > DECLIVIDADE_MAX ? 1 : 0,
                         max: 1, binaria: true, alto: "pior", rot: "barreira",
                         pontas: ["passa", "é barreira"]}},
  estreita:   {rot: "estreita", campo: "cal_estreita", max: 90, un: "%",
               base: "das calçadas do distrito", alto: "pior",
               ajuda: "Calçadas com faixa livre abaixo de 1,20 m, o mínimo do Decreto "
                    + "59.671/2020 e da NBR 9050, já descontando 0,70 m de faixa de "
                    + "serviço onde há árvore ou poste.",
               calcada: {valor: p => p.livre_min < FAIXA_LIVRE_MIN ? 1 : 0,
                         max: 1, binaria: true, alto: "pior", rot: "faixa livre",
                         pontas: ["1,20 m ou mais", "abaixo de 1,20 m"]}},
  comprimento:{rot: "comprimento", campo: "cal_comprimento", min: 45, max: 75, un: " m",
               base: "comprimento médio dos trechos de calçada do distrito", alto: "melhor",
               ajuda: "Comprimento médio dos trechos de calçada. É ESTIMATIVA: o cadastro "
                    + "traz a área e a largura média de cada trecho, mas não o comprimento — "
                    + "este é a área dividida pela largura média, a mesma conta que o score "
                    + "já usa para densidade de árvore por 100 m. Trecho curto costuma ser "
                    + "esquina e testada estreita; trecho longo, quadra inteira de um lado só.",
               calcada: {valor: p => p.comprimento, max: 120, alto: "melhor",
                         rot: "comprimento estimado", pontas: ["curto", "120 m ou mais"]}},
  // 45 m é o menor trecho médio entre os 96 distritos; 75 m no topo espalha 86
  // deles pelos sete degraus e satura os 10 rurais, em vez de achatar o resto
  declive:    {rot: "inclinação média", campo: "cal_declive", max: 7, un: "%",
               base: "inclinação média das calçadas do distrito", alto: "pior",
               ajuda: "Declividade média das calçadas do distrito. A NBR 9050 limita a "
                    + "8,33% (1:12): acima disso a calçada deixa de ser passeio e vira rampa.",
               calcada: {valor: p => p.declive, max: 15, alto: "pior",
                         rot: "declividade", pontas: ["0%", "15% ou mais"]}},
  obstaculo:  {rot: "com obstáculo", campo: "cal_obst", max: 90, un: "%",
               base: "das calçadas do distrito", alto: "pior",
               ajuda: "Calçadas com ao menos uma árvore ou poste plantado dentro delas. "
                    + "Cada obstáculo tira 0,70 m da largura útil.",
               calcada: {valor: p => p.obst > 0 ? 1 : 0,
                         max: 1, binaria: true, alto: "pior", rot: "obstáculo",
                         pontas: ["nenhum", "um ou mais"]}},
  pec:        {rot: "no Plano Emergencial", campo: "cal_pec", max: 60, un: "%",
               base: "das calçadas do distrito", alto: "pior",
               ajuda: "Calçadas dentro do Plano Emergencial de Calçadas (Decreto "
                    + "58.845/2019), onde a reforma cabe ao município e não ao proprietário.",
               calcada: {valor: p => p.pec ? 1 : 0,
                         max: 1, binaria: true, alto: "pior", rot: "Plano Emergencial",
                         pontas: ["fora", "no plano"]}},
  sem_calcada: {rot: "sem calçada", num: "V05422", den: "V05400", max: 60, un: "%",
                base: "das faces de quadra do distrito", alto: "pior",
                ajuda: "Faces de quadra onde o recenseador não encontrou calçada nenhuma. "
                     + "Censo 2022 — aqui a unidade é a face de quadra, não a calçada "
                     + "cadastrada pela Prefeitura."},
  sem_rampa:  {rot: "sem rampa", num: "V05428", den: "V05421", max: 100, un: "%",
               base: "das faces que têm calçada", alto: "pior",
               ajuda: "Faces que têm calçada mas não têm rebaixamento de guia para cadeira "
                    + "de rodas. Censo 2022, por face de quadra: não existe dado de rampa "
                    + "por calçada cadastrada, em fonte nenhuma."},
};


/* Os filtros. Cada um é um teste por calçada, e o que passa fica no mapa.
 * Ligados por E: quanto mais filtro, menos calçada sobra. */
/* Os indicadores em dois grupos, na ordem que a tela mostra. O primeiro é o que
 * a cidade tem de errado, medido calçada a calçada; o segundo são as duas notas
 * compostas, que combinam coisas e por isso pedem leitura à parte. */
const GRUPOS_METRICA = [
  {rot: "Analisar calçadas de São Paulo por",
   dica: "Escolhe o indicador que pinta os distritos, ordena a tabela e pinta cada "
       + "calçada quando você se aproxima",
   metricas: ["barreira", "estreita", "comprimento", "declive",
              "obstaculo", "pec", "sem_calcada", "sem_rampa"]},
  {rot: "Filtros customizados",
   dica: "As duas notas compostas: combinam vários fatores num número só, e por isso "
       + "pedem leitura à parte",
   metricas: ["score", "potencial"]},
];

const FILTROS = {
  larga: {rot: "faixa livre ≥ 1,20 m", ok: p => p.livre_min >= FAIXA_LIVRE_MIN,
          ajuda: "Mínimo do Decreto Municipal 59.671/2020 e da NBR 9050 para a faixa por "
               + "onde se anda, já descontando árvore e poste."},
  plana: {rot: "declividade ≤ 8,33%", ok: p => p.declive <= DECLIVIDADE_MAX,
          ajuda: "Limite da NBR 9050 (1:12). Acima disso a calçada exige esforço que uma "
               + "cadeira de rodas manual não sustenta."},
  livre: {rot: "sem obstáculo", ok: p => p.obst === 0,
          ajuda: "Nenhuma árvore ou poste plantado dentro da calçada. A norma pede faixa "
               + "livre desimpedida de ponta a ponta."},
  boa:   {rot: "score ≥ 30", ok: p => p.score >= 30,
          ajuda: "Só as calçadas com nota de passeio 30 ou mais. Como a mediana da cidade "
               + "é 15, este filtro guarda mais ou menos as 10% melhores."},
  pec:   {rot: "no Plano Emergencial", ok: p => p.pec === true,
          ajuda: "Só as calçadas cuja reforma é obrigação do município pelo Decreto "
               + "58.845/2019. Não é critério de norma: é recorte administrativo."},
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
let mapa, camadaDistritos, camadaCalcadas = null, camadaContorno = null,
    camadaRotulos = null;
let distritos, municipio;
let abertos = [];                   // distritos com a calçada desenhada agora
let trocandoNivel = false;          // trava do drill-down automático por zoom
let selecionado = null;             // distrito fixado pelo clique, se houver
let zoomDeAbertura = null;          // abaixo dele, o mapa volta para a cidade
const emCache = new Map();          // slug -> GeoJSON parseado, no máximo MAX_EM_CACHE

/* ---------------- escala de cor ---------------- */
/* `min` é opcional e vale 0 para quase todo indicador — taxa e nota começam no
 * zero. O comprimento não: o menor distrito tem 45 m de trecho médio, e uma
 * rampa que sai de zero gastava metade da cor num intervalo onde não existe
 * distrito nenhum. O mapa saía com três tons. */
function faixa(valor, m) {
  if (valor == null || Number.isNaN(valor)) return cor("--sem-dado");
  const lo = m.min || 0;
  const t = Math.min(1, Math.max(0, (valor - lo) / (m.max - lo)));
  return cor(RAMPA[Math.min(RAMPA.length - 1, Math.floor(t * RAMPA.length))]);
}

/* O número como ele é: taxa leva "%", o score não leva nada. */
const valorFmt = (v, m) => v == null || Number.isNaN(v) ? "—"
  : m.un === "%" ? pct(v) : v.toFixed(1).replace(".", ",");

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
                     "V05427", "V05428", "V05409", "V05415", "V05418", "V05430", "V05433"]) {
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
          ingreme: peso("cal_ingreme"), obst: peso("cal_obst"), pec: peso("cal_pec"),
          score: peso("cal_score"), declive: peso("cal_declive")};
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
      <dt><b>score de acessibilidade</b></dt><dd><b>${c.score.toFixed(1).replace(".", ",")}</b></dd>
      <dt>barreira</dt><dd>${pct(c.barreira)}</dd>
      <dt>estreita</dt><dd>${pct(c.estreita)}</dd>
      <dt>inclinação média</dt><dd>${pct(c.declive)}</dd>
      <dt>com obstáculo</dt><dd>${pct(c.obst)}</dd>
      <dt>no Plano Emergencial</dt><dd>${pct(c.pec)}</dd>
      <div class="sep"></div>
      <dt>face sem calçada nenhuma<span style="color:var(--ink-3)"> ¹</span></dt><dd>${pct(taxa(t.V05422, F))}</dd>
      <dt>face sem rampa<span style="color:var(--ink-3)"> ¹</span></dt><dd>${pct(taxa(t.V05428, C))}</dd>
      ${quemMora(props)}
      <div class="pessoas" style="opacity:.75">¹ Censo 2022, por face de quadra</div>
    </dl>`;
}

/* No distrito o cartão passa a contar calçada, e conta só a que sobrou do filtro. */
/* Quantas crianças de 0 a 4 anos moram nos distritos carregados, e quanto isso
 * pesa na cidade. É o sinal de demanda do aplicativo de caminhada com carrinho:
 * o dash existe para dizer onde ele seria mais bem recebido. */
function quemMora(props, nomes = null) {
  const criancas = props.reduce((a, p) => a + (p.criancas_0a4 || 0), 0);
  const idosos = props.reduce((a, p) => a + (p.idosos_60 || 0), 0);
  const doTotal = municipio.criancas_0a4 ? 100 * criancas / municipio.criancas_0a4 : null;
  if (!criancas) return "";
  // Quando o recorte é a tela, o "onde" desta linha continua sendo o distrito
  // inteiro: o Censo não desce abaixo do setor censitário, e o setor não está
  // guardado por calçada. Dizer "moram aqui" com três quarteirões na tela seria
  // atribuir à vista um número que é de outra área.
  const onde = !nomes ? "aqui"
    : nomes.length === 1 ? `em ${nomes[0]}`
    : `nos ${nomes.length} distritos desta vista`;
  return `<div class="sep"></div>
    <div class="pessoas"><b>${num(criancas)} crianças de 0 a 4 anos</b> moram ${onde} —
    ${pct(doTotal)} das da cidade. E ${num(idosos)} pessoas com 60 anos ou mais.</div>`;
}

function pintarCartoesCalcada(mostradas, vistas, nomes = []) {
  const n = mostradas.length;
  const onde = nomes.length === 1 ? nomes[0] : "o que está na tela";
  if (!n) {
    $("#cartoes").innerHTML = `<div class="onde">${onde}</div>
      <div class="base">${vistas ? `nenhuma das ${num(vistas)} calçadas desta vista passa nos filtros`
                                 : "nenhuma calçada nesta vista"}</div>`;
    return;
  }
  const parte = f => 100 * mostradas.filter(f).length / n;
  const livres = mostradas.map(p => p.livre_min).sort((a, b) => a - b);
  const filtrado = n < vistas;
  $("#cartoes").innerHTML = `
    <div class="onde">${onde}</div>
    <div class="base">${filtrado ? `${num(n)} de ${num(vistas)} calçadas nesta vista passam nos filtros`
                                 : `${num(n)} calçadas nesta vista`}${
      nomes.length > 1 ? `<br>${nomes.join(" · ")}` : ""}</div>
    <dl>
      <dt><b>score de acessibilidade</b></dt><dd><b>${
        (mostradas.reduce((a, p) => a + p.score, 0) / n).toFixed(1).replace(".", ",")}</b></dd>
      <dt>barreira</dt><dd>${pct(parte(p => p.livre_min < FAIXA_LIVRE_MIN || p.declive > DECLIVIDADE_MAX))}</dd>
      <dt>estreita</dt><dd>${pct(parte(p => p.livre_min < FAIXA_LIVRE_MIN))}</dd>
      <dt>inclinação média</dt><dd>${pct(mostradas.reduce((a, p) => a + p.declive, 0) / n)}</dd>
      <dt>com obstáculo</dt><dd>${pct(parte(p => p.obst > 0))}</dd>
      <div class="sep"></div>
      <dt>faixa livre mediana</dt><dd>${metros(livres[Math.floor(n / 2)])}</dd>
      <dt>no Plano Emergencial</dt><dd>${pct(parte(p => p.pec))}</dd>
      ${quemMora(abertos, nomes)}
      <div class="sep"></div>
      <div class="pessoas">A cor é ${escalaAtiva().rot}. As contas acima são só das
      calçadas que cabem nesta tela.</div>
    </dl>`;
}

/* Quem está no enquadramento. Vale mesmo com um distrito aberto: a camada de
 * distritos sai do mapa mas continua viva, e é ela que a tabela lateral lê. */
/* Um distrito está na tela quando o POLÍGONO cruza o enquadramento, não quando
 * a caixa envolvente cruza. Com a caixa, um zoom numa rua de Pinheiros trazia o
 * Butantã junto: a caixa do Butantã é enorme e cobre meio mapa. */
function aneis(l) {
  if (l._aneis) return l._aneis;
  const saida = [];
  const anda = x => {
    if (!Array.isArray(x)) return;
    if (x.length && x[0].lat !== undefined) saida.push(x);
    else x.forEach(anda);
  };
  anda(l.getLatLngs());
  return (l._aneis = saida);
}

const lado = (q, r, s) => (r[0] - q[0]) * (s[1] - q[1]) - (r[1] - q[1]) * (s[0] - q[0]);
const segsCruzam = (p1, p2, p3, p4) => {
  const d1 = lado(p3, p4, p1), d2 = lado(p3, p4, p2);
  const d3 = lado(p1, p2, p3), d4 = lado(p1, p2, p4);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
};

function pontoNoPoligano(lat, lng, rings) {
  let dentro = false;
  for (const anel of rings) {
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const yi = anel[i].lat, xi = anel[i].lng, yj = anel[j].lat, xj = anel[j].lng;
      if ((yi > lat) !== (yj > lat) &&
          lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) dentro = !dentro;
    }
  }
  return dentro;
}

function cruzaVista(l, b) {
  if (!b.intersects(l.getBounds())) return false;      // rejeição barata primeiro
  const O = b.getWest(), L = b.getEast(), S = b.getSouth(), N = b.getNorth();
  const cantos = [[O, S], [L, S], [L, N], [O, N]];
  const rings = aneis(l);
  for (const anel of rings) {
    for (let i = 0; i < anel.length; i++) {
      const p = anel[i];
      if (p.lng >= O && p.lng <= L && p.lat >= S && p.lat <= N) return true;
      const q = anel[(i + 1) % anel.length];
      const a = [p.lng, p.lat], c = [q.lng, q.lat];
      for (let k = 0; k < 4; k++) {
        if (segsCruzam(a, c, cantos[k], cantos[(k + 1) % 4])) return true;
      }
    }
  }
  // Nenhuma borda cruza: ou a tela está inteira dentro do distrito, ou fora.
  const m = b.getCenter();
  return pontoNoPoligano(m.lat, m.lng, rings);
}

function medirVista() {
  const b = mapa.getBounds();
  const dentro = [];
  camadaDistritos.eachLayer(l => {
    if (cruzaVista(l, b)) dentro.push(l.feature.properties);
  });
  naVista = new Set(dentro.map(p => p.NM_DIST));
  return dentro;
}

/* Todo controle que só age sobre a calçada fica cinza enquanto ela não está na
 * tela: botão que aceita o clique e não faz nada parece defeito. */
function atualizarControles() {
  const semCalcada = !abertos.length;
  const aviso = "Aproxime o mapa até a calçada aparecer. ";
  for (const b of document.querySelectorAll(
      "#pills-ponto button, #pills-filtro button, #btn-favela")) {
    b.disabled = semCalcada;
    // O texto de ajuda mora no elemento: escrevê-lo aqui a cada mudança de nível
    // apagava a explicação do indicador, que é o que o usuário quer ler.
    b.title = (semCalcada ? aviso : "") + (b.dataset.ajuda || "");
  }
}

/* Recalcula para o que está na tela. É a interação central do painel. */
function atualizarPorVista() {
  const visiveis = medirVista();
  atualizarControles();
  desenharTabela();
  if (abertos.length) { cartoesDaCalcada(); return; }
  const todos = visiveis.length === distritos.features.length;
  pintarCartoes(todos ? "Município de São Paulo" : `${visiveis.length} distritos na tela`,
                todos ? "os 96 distritos" : "mova o mapa para mudar o recorte", visiveis);
}

/* Quais distritos viram calçada desenhada: os que a tela alcança, do centro
 * para fora, até bater num dos dois tetos.
 * ponytail: os tetos são fixos (6 distritos, 45 mil polígonos) e cortam pelo
 * mais distante do centro. Se incomodar, o passo seguinte é recortar as
 * feições pelo enquadramento em vez de descartar o distrito inteiro. */
function distritosNaTela() {
  const b = mapa.getBounds(), c = mapa.getCenter();
  // Escolher um distrito é um pedido explícito: enquanto ele estiver na tela, os
  // dados são só dele, mesmo que o enquadramento alcance os vizinhos. Sai de
  // vista, sai a fixação, e o mapa volta a seguir o enquadramento.
  if (selecionado) {
    const l = camadaDistritos.getLayers().find(x => x.feature.properties.id === selecionado);
    if (l && cruzaVista(l, b)) return [l.feature.properties];
    selecionado = null;
  }
  const perto = [];
  camadaDistritos.eachLayer(l => {
    if (cruzaVista(l, b)) perto.push([l.getBounds().getCenter().distanceTo(c), l.feature.properties]);
  });
  perto.sort((x, y) => x[0] - y[0]);
  const escolhidos = [];
  let feicoes = 0;
  for (const [, p] of perto) {
    if (escolhidos.length >= MAX_DISTRITOS) break;
    if (escolhidos.length && feicoes + (p.cal_n || 0) > LIMITE_FEICOES) break;
    escolhidos.push(p);
    feicoes += p.cal_n || 0;
  }
  return escolhidos;
}

const chave = lista => lista.map(p => p.id).sort().join(",");

/* A decisão de nível, sem mapa: é a parte que erra feio se errar — entrar e
 * sair em sequência no mesmo zoom vira piscada infinita. Coberta no autoteste. */
function decidirNivel(z, alvos, abertos, zAbertura) {
  if (z >= ZOOM_CALCADA && alvos && alvos !== abertos) return "entrar";
  // Sair pelo zoom de entrada, não por ZOOM_CALCADA: um distrito grande como o
  // Grajaú enquadra em 12, e a regra fixa o fecharia no instante em que abriu.
  if (abertos && zAbertura != null && z < zAbertura) return "sair";
  return null;
}

async function porZoom() {
  if (trocandoNivel) return;
  const z = mapa.getZoom();
  const alvos = z >= ZOOM_CALCADA ? distritosNaTela() : [];
  const acao = decidirNivel(z, chave(alvos), chave(abertos), zoomDeAbertura);
  if (!acao) return;
  trocandoNivel = true;
  try {
    if (acao === "entrar") await entrarNoNivel(alvos);
    else sairDoNivel();
  } finally { trocandoNivel = false; }
}

/* ---------------- camadas ---------------- */
/* O véu é o mesmo coroplético, quase transparente: a cor do distrito continua
 * lá embaixo enquanto a calçada é desenhada por cima. */
function estiloVeu(f) {
  return {fillColor: faixa(valorDe(f.properties, METRICAS[metrica]), METRICAS[metrica]),
          fillOpacity: .14, color: cor("--ink-3"), weight: 1, opacity: .75};
}

/* O nome do distrito escrito no mapa. Só os que estão carregados: 96 rótulos
 * seriam ruído, e o que o usuário precisa é saber onde ele está agora. */
function desenharRotulos() {
  if (camadaRotulos) mapa.removeLayer(camadaRotulos);
  camadaRotulos = L.layerGroup(abertos.map(p => {
    const l = camadaDistritos.getLayers().find(x => x.feature.properties.id === p.id);
    if (!l) return null;
    // getBounds().getCenter(), não getCenter(): o segundo exige que a camada
    // esteja NO mapa, e ao trocar de distrito com a calçada já na tela ela não
    // está. O erro quebrava a promessa do moveend e a tabela parava de
    // acompanhar o enquadramento — parecendo desatualizada sem motivo.
    return L.marker(l.getBounds().getCenter(), {interactive: false, keyboard: false,
      icon: L.divIcon({className: "rotulo-distrito", html: p.NM_DIST,
                       iconSize: null, iconAnchor: [0, 0]})});
  }).filter(Boolean)).addTo(mapa);
}

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
      <span class="v">${valorFmt(valorDe(props, m), m)}</span><br>
      ${num(props.cal_n)} calçadas · ${num(props.criancas_0a4)} crianças de 0 a 4
      em ${(props.km2 || 0).toFixed(1).replace(".", ",")} km²`);
  });
  l.on("mouseout", escondeDica);
  // Clique no mapa não reenquadra: o usuário já está olhando para onde clicou,
  // e um fitBounds no distrito inteiro o teleporta. Só aproxima se ainda não
  // estiver perto o bastante, e mantendo o ponto clicado no centro.
  l.on("click", e => irParaDistrito(props, false, e.latlng));
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
/* A escala padrão do nível da calçada é a faixa livre. */
const ESCALA_PADRAO = {valor: p => p.livre_min, max: 3, alto: "melhor",
                       rot: "faixa livre", pontas: ["0 m", "3 m ou mais"]};
/* A nota vai de 0 a 100 por construção, mas a cidade real ocupa a ponta de
 * baixo: mediana 15, p99 igual a 53, e o melhor distrito tem média 32. Por isso
 * o teto do desenho é 55 e não 100 — ver METRICAS.score.calcada. */

/* Quem pinta a calçada é sempre a métrica escolhida no mapa — a mesma que pinta
 * o distrito, na sua versão por calçada. O filtro só subtrai; ter os dois
 * disputando a cor era o que confundia.
 *
 * "Sem calçada" e "sem rampa" vêm do Censo, por face de quadra, e não têm
 * versão por calçada em fonte nenhuma: ali a cor cai para a faixa livre, e a
 * legenda diz que caiu. */
function escalaAtiva() {
  return METRICAS[metrica].calcada || ESCALA_PADRAO;
}

function corDaCalcada(p, e) {
  const v = e.valor(p);
  if (v == null || Number.isNaN(v)) return cor("--sem-dado");
  const t = Math.min(1, Math.max(0, v / e.max));
  return cor(RAMPA[Math.min(RAMPA.length - 1, Math.floor(t * RAMPA.length))]);
}

const passaNosFiltros = p =>
  (!soFavela || p.em_favela) && [...ligados].every(k => FILTROS[k].ok(p));

/* Remontar a camada é o jeito de aplicar filtro: `L.geoJSON({filter})` só é
 * avaliado na construção. Alguns milhares de polígonos em canvas é barato. */
function montarCalcadas() {
  if (!abertos.length) return;
  const e = escalaAtiva();
  const gj = {type: "FeatureCollection",
              features: abertos.flatMap(p => emCache.get(p.id).features)};
  // A nota da rua é a média dos trechos com o mesmo nome, calculada aqui com o
  // que já está carregado: guardá-la por feição seria repetir 491 mil vezes um
  // número que o navegador refaz em milissegundos.
  scoreDaRua = new Map();
  for (const f of gj.features) {
    const r = f.properties.rua;
    if (!r) continue;
    const a = scoreDaRua.get(r) || [0, 0];
    scoreDaRua.set(r, [a[0] + f.properties.score, a[1] + 1]);
  }
  for (const [r, [soma, n]] of scoreDaRua) scoreDaRua.set(r, Math.round(soma / n));
  if (camadaCalcadas) mapa.removeLayer(camadaCalcadas);
  camadaCalcadas = L.geoJSON(gj, {
    renderer: L.canvas({padding: .3}),
    filter: f => passaNosFiltros(f.properties),
    // O contorno é da MESMA cor do preenchimento, não do fundo: uma calçada tem
    // 2 m de largura e some no zoom do distrito inteiro se o traço a apagar.
    style: f => {
      const c = corDaCalcada(f.properties, e);
      return {fillColor: c, fillOpacity: .92, color: c, weight: 1.1, opacity: .9};
    },
    onEachFeature: (f, l) => {
      const p = f.properties;
      // a largura cadastrada é a faixa livre de volta com a faixa de serviço
      const larg = p.livre_min + (p.obst > 0 ? FAIXA_SERVICO : 0);
      l.on("mousemove", e => dica(e, `<b>${p.rua || "via sem nome"}</b><br>
        score <span class="v">${p.score}</span> neste trecho${
          scoreDaRua.has(p.rua) ? `, <span class="v">${scoreDaRua.get(p.rua)}</span> na rua` : ""}<br>
        faixa livre ${metros(p.livre_min)} · declive ${pct(p.declive)}<br>
        largura ${metros(larg)} · ${p.obst} obstáculo${p.obst === 1 ? "" : "s"}${
          p.pec ? " · Plano Emergencial" : ""}`));
      l.on("mouseout", escondeDica);
    }
  }).addTo(mapa);
  cartoesDaCalcada();
}

/* O cartão do nível da calçada era escrito uma vez, na entrada, e nunca revisto.
 * Bastava uma sequência de interações em que a última escrita pegasse `abertos`
 * ainda vazio para ele ficar parado — foi assim que "quem mora aqui" sumia sem
 * que a função que o monta tivesse defeito. Agora ele é reescrito junto com o
 * resto do painel, a cada movimento do mapa. */
/* Caixa envolvente da feição, calculada uma vez e guardada nela. É o que torna
 * barato recortar 19 mil calçadas pelo enquadramento a cada movimento. */
function caixaDe(f) {
  if (f._cx) return f._cx;
  let o = 180, l = -180, s = 90, n = -90;
  const anda = c => {
    if (typeof c[0] === "number") {
      if (c[0] < o) o = c[0];
      if (c[0] > l) l = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    } else for (const x of c) anda(x);
  };
  anda(f.geometry.coordinates);
  return (f._cx = [o, s, l, n]);
}

/* O cartão conta o que está NA TELA, não o distrito inteiro. Num zoom de três
 * quarteirões do Tatuapé ele dizia "9.831 calçadas" e dava a mediana dos dois
 * distritos completos: números verdadeiros sobre outra coisa que não o que o
 * usuário está olhando. */
function cartoesDaCalcada() {
  if (!abertos.length) return;
  const b = mapa.getBounds();
  const O = b.getWest(), L = b.getEast(), S = b.getSouth(), N = b.getNorth();
  const naTela = [];
  let vistas = 0;
  for (const d of abertos) {
    const gj = emCache.get(d.id);
    if (!gj) continue;
    for (const f of gj.features) {
      const c = caixaDe(f);
      if (c[2] < O || c[0] > L || c[3] < S || c[1] > N) continue;
      vistas++;
      if (passaNosFiltros(f.properties)) naTela.push(f.properties);
    }
  }
  pintarCartoesCalcada(naTela, vistas, abertos.map(p => p.NM_DIST));
}

async function entrarNoNivel(alvos) {
  const faltando = alvos.filter(p => !emCache.has(p.id));
  if (faltando.length) {
    $("#carregando").textContent = faltando.length === 1
      ? `carregando as calçadas de ${faltando[0].NM_DIST}…`
      : `carregando as calçadas de ${faltando.length} distritos…`;
    $("#carregando").style.display = "grid";
    const vindos = await Promise.all(faltando.map(p =>
      fetch(`dados/calcadas/${p.id}.geojson?v=${V}`).then(r => r.json())));
    faltando.forEach((p, i) => emCache.set(p.id, vindos[i]));
    // Um distrito chega a alguns MB de JSON parseado. Guardar os 96 é o caminho
    // mais curto para a aba estourar — mas nunca despejar quem está na tela.
    for (const id of [...emCache.keys()]) {
      if (emCache.size <= MAX_EM_CACHE) break;
      if (!alvos.some(p => p.id === id)) emCache.delete(id);
    }
    $("#carregando").style.display = "none";
  }
  abertos = alvos;
  // Três âncoras para não perder a referência quando o coroplético some: um véu
  // do distrito na mesma cor da métrica, a divisa desenhada e o nome escrito.
  if (!camadaContorno) {
    camadaContorno = L.geoJSON(distritos, {
      interactive: false, renderer: L.canvas({padding: .3}), style: estiloVeu});
  }
  if (!mapa.hasLayer(camadaContorno)) camadaContorno.addTo(mapa);
  camadaContorno.bringToBack();
  desenharRotulos();
  montarCalcadas();
  if (camadaDistritos && mapa.hasLayer(camadaDistritos)) mapa.removeLayer(camadaDistritos);
  if (zoomDeAbertura == null) zoomDeAbertura = ZOOM_CALCADA;
  desenharLegenda();
  marcarLinha(abertos.map(p => p.NM_DIST));
  atualizarControles();
  montarPontos();
  document.querySelector(".envelope-mapa").classList.add("perto");
  $("#voltar").hidden = false;
}

function sairDoNivel() {
  abertos = [];
  selecionado = null;
  zoomDeAbertura = null;
  if (camadaCalcadas) { mapa.removeLayer(camadaCalcadas); camadaCalcadas = null; }
  if (camadaContorno) mapa.removeLayer(camadaContorno);
  if (camadaRotulos) { mapa.removeLayer(camadaRotulos); camadaRotulos = null; }
  desenharDistritos();
  desenharLegenda();
  marcarLinha([]);
  atualizarControles();
  montarPontos();
  document.querySelector(".envelope-mapa").classList.remove("perto");
  $("#voltar").hidden = true;
}

function voltarACidade() {
  sairDoNivel();
  mapa.fitBounds(camadaDistritos.getBounds(), {padding: [12, 12], animate: false});
}

/* Clicar num distrito enquadra nele e força o nível da calçada: um distrito
 * grande enquadra em zoom 12, abaixo de ZOOM_CALCADA, e sem forçar o clique não
 * mostraria calçada nenhuma. Os vizinhos que couberem na tela vêm junto. */
async function irParaDistrito(props, enquadrar = true, ponto = null) {
  selecionado = props.id;
  const l = camadaDistritos.getLayers().find(x => x.feature.properties.id === props.id);
  if (enquadrar && l) {
    mapa.fitBounds(l.getBounds(), {padding: [24, 24], animate: false});
  } else if (mapa.getZoom() < ZOOM_CALCADA) {
    mapa.setView(ponto || mapa.getCenter(), ZOOM_CALCADA, {animate: false});
  }
  trocandoNivel = true;
  try {
    zoomDeAbertura = Math.min(ZOOM_CALCADA, mapa.getZoom());
    await entrarNoNivel(distritosNaTela());
  } finally { trocandoNivel = false; }
}

/* ---------------- filtro avançado: os pontos ---------------- */
/* Árvore, poste e reclamação da cidade inteira, um arquivo por distrito. As
 * cores são deliberadamente fora da rampa azul da calçada: sobrepostas a ela,
 * uma cor da mesma família viraria mais um tom da escala. */
const PONTOS = {
  arvores:    {rot: "árvores", cor: "--pt-arvore", r: 1.7,
               ajuda: "As 652.976 árvores do cadastro municipal. Dentro da calçada elas são "
                    + "obstáculo; ao longo dela, sombra — e o score conta as duas coisas."},
  postes:     {rot: "postes", cor: "--pt-poste", r: 1.4,
               ajuda: "Os 662.945 pontos de iluminação pública. Ocupam a faixa de serviço e "
                    + "somam luz ao score."},
  incidentes: {rot: "incidentes reportados", cor: "--pt-incidente", r: 3.2,
               ajuda: "7.006 chamados com endereço: capinação de guia e sarjeta, risco de "
                    + "queda de árvore e árvore em urgência. Descontam do score a até 20 m."},
};
const pontosLigados = new Set();
const pontosEmCache = new Map();
let camadasPonto = {};
let scoreDaRua = new Map();
let montandoPontos = false;

async function carregarPontos(id) {
  if (!pontosEmCache.has(id)) {
    pontosEmCache.set(id, await fetch(`dados/pontos/${id}.json?v=${V}`)
      .then(r => r.ok ? r.json() : {}).catch(() => ({})));
    for (const k of [...pontosEmCache.keys()]) {
      if (pontosEmCache.size <= MAX_EM_CACHE) break;
      if (!abertos.some(p => p.id === k)) pontosEmCache.delete(k);
    }
  }
  return pontosEmCache.get(id);
}

/* Só desenha o que está no enquadramento: seis distritos dão 80 mil pontos, e
 * um marcador por ponto fora da tela é trabalho jogado fora. */
async function montarPontos() {
  if (montandoPontos) return;
  montandoPontos = true;
  try {
    Object.values(camadasPonto).forEach(c => mapa.removeLayer(c));
    camadasPonto = {};
    const ativos = [...pontosLigados].filter(k => PONTOS[k]);
    if (!abertos.length || !ativos.length) return;
    const dados = await Promise.all(abertos.map(p => carregarPontos(p.id)));
    const vista = mapa.getBounds();
    const tela = L.canvas({padding: .2});
    // O ponto é contexto, a calçada é o conteúdo. Num zoom de seis distritos,
    // 15 mil árvores em tamanho cheio viram uma malha sólida e escondem o mapa:
    // o raio e a opacidade acompanham a aproximação.
    const z = mapa.getZoom();
    const escala = z >= 17 ? 1.8 : z >= 16 ? 1.4 : z >= 15 ? 1 : .65;
    const opacidade = z >= 16 ? .85 : z >= 15 ? .7 : .5;
    for (const k of ativos) {
      const marcas = [];
      for (const d of dados) {
        for (const p of d[k] || []) {
          const [x, y] = p;
          if (!vista.contains([y, x])) continue;
          const m = L.circleMarker([y, x], {
            radius: PONTOS[k].r * (k === "incidentes" ? 1 : escala),
            color: cor(PONTOS[k].cor), weight: 0,
            interactive: k === "incidentes",
            fillOpacity: k === "incidentes" ? .95 : opacidade, renderer: tela});
          // Só o incidente conta uma história; árvore e poste são só posição.
          if (k === "incidentes") {
            const [, , oque, quando, situacao] = p;
            m.on("mousemove", e => dica(e, `<b>${oque || "reclamação"}</b><br>
              ${quando ? `aberta em <span class="v">${quando}</span>` : "sem data"}${
                situacao ? ` · ${situacao}` : ""}<br>
              chamado do GeoSampa, a até 20 m desta calçada`));
            m.on("mouseout", escondeDica);
          }
          marcas.push(m);
        }
      }
      camadasPonto[k] = L.layerGroup(marcas).addTo(mapa);
    }
  } finally { montandoPontos = false; }
}

/* ---------------- tabela de distritos ---------------- */
const semAcento = s => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/* Três coisas decidem o que a tabela mostra, nesta ordem: a busca é global — é a
 * saída para achar um distrito que não está na tela —, o enquadramento recorta o
 * resto, e o cabeçalho escolhe a direção. */
function desenharTabela() {
  const m = METRICAS[metrica];
  // Mede o enquadramento aqui, sempre. Guardar a medição de antes fazia a tabela
  // listar distritos que já tinham saído da tela quando ela era redesenhada por
  // outro motivo — troca de métrica, de ordem — sem um moveend no meio.
  medirVista();
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
    <p class="tab-base">${m.rot}: ${m.base}</p>
    <table class="tab">
      <thead><tr>
        <th scope="col">distrito <span class="quantos">${quantos}</span></th>
        <th scope="col"><button id="ordenar" aria-label="ordenar por ${m.rot}, ${
          ordemAsc ? "crescente" : "decrescente"}">${m.un || "nota"} ${ordemAsc ? "▲" : "▼"}</button></th>
      </tr></thead>
      <tbody>${fs.map(p => {
        const v = valorDe(p, m);
        return `<tr data-d="${p.NM_DIST}" aria-current="false">
          <th scope="row"><button title="${p.NM_DIST} · ${num(p.criancas_0a4)} crianças de 0 a 4 em ${
            (p.km2 || 0).toFixed(1).replace(".", ",")} km²">${p.NM_DIST}</button></th>
          <td><span class="barra" style="width:${Math.min(100, 100 * v / m.max).toFixed(1)}%"></span>
              <span class="v">${valorFmt(v, m)}</span></td></tr>`;
      }).join("")}</tbody>
    </table>`;
  const ord = $("#ordenar");
  if (ord) ord.onclick = () => { ordemAsc = !ordemAsc; desenharTabela(); };
  $("#tabela").querySelectorAll("tr[data-d] button").forEach(b => b.onclick = () => {
    const nome = b.closest("tr").dataset.d;
    irParaDistrito(distritos.features.find(f => f.properties.NM_DIST === nome).properties);
  });
  if (abertos.length) marcarLinha(abertos.map(p => p.NM_DIST));
}

function marcarLinha(nomes) {
  const conj = new Set(Array.isArray(nomes) ? nomes : nomes ? [nomes] : []);
  $("#tabela").querySelectorAll("tr[data-d]").forEach(tr =>
    tr.setAttribute("aria-current", conj.has(tr.dataset.d)));
  // rolar só o painel: scrollIntoView levaria a página junto
  const primeiro = $('#tabela tr[aria-current="true"]');
  if (primeiro) $("#tabela").scrollTop = primeiro.offsetTop - $("#tabela").clientHeight / 2;
}

/* ---------------- controles e legenda ---------------- */
function desenharControles() {
  $("#controles").innerHTML = `
    <div id="pills-metrica" class="grupos-metrica">
      ${GRUPOS_METRICA.map(g =>
        `<div class="sub"><span class="rot-grupo" title="${g.dica}">${g.rot}</span>` +
        `<div class="pills">` +
        g.metricas.filter(k => METRICAS[k]).map(k =>
          `<button data-m="${k}" aria-pressed="${k === metrica}" title="${METRICAS[k].ajuda}"
            >${METRICAS[k].rot}</button>`).join("") +
        `</div></div>`).join("")}
    </div>
    <div class="grupo"><span title="Cada filtro é um critério da NBR 9050 e do Decreto 59.671/2020. Ligados por E, e só subtraem: a calçada que não passa some do mapa. Quem escolhe a cor é o indicador ali de cima">mostrar só as calçadas que</span><div class="pills" id="pills-filtro">
      ${Object.entries(FILTROS).map(([k, f]) =>
        `<button data-f="${k}" aria-pressed="false" disabled data-ajuda="${f.ajuda}"
          >${f.rot}</button>`).join("")}
    </div></div>
    <div class="grupo"><span title="Camadas de ponto da cidade inteira, desenhadas por cima da calçada">filtro avançado</span><div class="pills" id="pills-ponto">
      ${Object.entries(PONTOS).map(([k, o]) =>
        `<button id="pt-${k}" data-p="${k}" aria-pressed="false" disabled
           data-ajuda="${o.ajuda}">${o.rot}</button>`).join("")}
    </div></div>
    <div class="grupo"><span>recorte</span><div class="pills">
      <button id="btn-favela" aria-pressed="false" disabled
        data-ajuda="Mostra só as calçadas em setor censitário classificado como favela ou comunidade urbana pelo IBGE.">só favela e comunidade urbana</button>
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
  $("#pills-ponto").onclick = e => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    const k = b.dataset.p;
    pontosLigados.has(k) ? pontosLigados.delete(k) : pontosLigados.add(k);
    b.setAttribute("aria-pressed", pontosLigados.has(k));
    montarPontos();
  };
  $("#btn-favela").onclick = () => {
    soFavela = !soFavela;
    $("#btn-favela").setAttribute("aria-pressed", soFavela);
    montarCalcadas();
  };
  $("#voltar").onclick = () => voltarACidade();
  $("#busca").oninput = adiar(e => { busca = e.target.value; desenharTabela(); }, 120);
}

function repintar() {
  if (camadaDistritos && !abertos.length) camadaDistritos.setStyle(f => estilo(f.properties));
  if (camadaContorno) camadaContorno.setStyle(estiloVeu);
  if (abertos.length) montarCalcadas();   // "score" também pinta a calçada
  desenharLegenda();
  desenharTabela();
}

function desenharLegenda() {
  const m = METRICAS[metrica];
  // Nada troca de lado: o menor sempre à esquerda, o maior sempre à direita, a
  // cor sempre crescendo junto. Quem muda é a frase — em "com rampa" e no score
  // muito é bom, nos demais muito é ruim.
  if (abertos.length) {
    const e = escalaAtiva();
    const [a, b] = e.pontas;
    // Métrica de sim/não não merece sete degraus: mostra as duas pontas da rampa.
    const passos = e.binaria ? [RAMPA[0], RAMPA[RAMPA.length - 1]] : RAMPA;
    const emprestada = !METRICAS[metrica].calcada;
    $("#legenda").innerHTML = `
      <div class="titulo">${e.rot} da calçada${e.binaria ? "" :
        ` — mais forte, ${e.alto === "melhor" ? "melhor" : "pior"}`}</div>
      <div class="escala">${passos.map(s => `<i style="background:${cor(s)}"></i>`).join("")}</div>
      <div class="escala-rot"><span>${a}</span><span>${b}</span></div>
      <div class="nd"><i></i>${emprestada
        ? `"${METRICAS[metrica].rot}" só existe por face de quadra` : "sem medida"}</div>`;
    return;
  }
  $("#legenda").innerHTML = `
    <div class="titulo">${m.rot}${m.dica ? ` — ${m.dica}` : ""}</div>
    <div class="escala">${RAMPA.map(s => `<i style="background:${cor(s)}"></i>`).join("")}</div>
    <div class="escala-rot"><span>${m.min || 0}${m.un}</span><span>mais forte, ${
      m.alto === "melhor" ? "melhor" : "pior"}</span><span>${m.max}${m.un}</span></div>
    <div class="nd"><i></i>sem calçada cadastrada</div>`;
}

function pintarFaixa() {
  const c = municipio.calcadas;
  /* Os dois primeiros cartões são complementares e somam 100%: ou a calçada
   * passa na largura E na inclinação, ou tem ao menos uma barreira. O terceiro
   * é o único que NÃO é medido por calçada — o cadastro do GeoSampa não
   * registra rebaixamento de guia, e o número vem do Censo por face de quadra.
   * O rótulo diz isso, senão o cartão mediria uma coisa e afirmaria outra. */
  $("#vao").innerHTML = `
    <div class="lado destaque"><dt>dentro das normas</dt>
      <dd>${pct(c.dentro_norma)}<small>faixa livre de 1,20 m ou mais E declividade até 8,33%</small></dd></div>
    <div class="lado"><dt>com ao menos uma barreira</dt>
      <dd>${pct(c.barreira)}<small>estreita demais ou íngreme demais para passar</small></dd></div>
    <div class="lado"><dt>sem rampa</dt>
      <dd>${pct(municipio.taxas.sem_rampa)}<small>das faces de quadra com calçada, no Censo 2022 —
      o cadastro de calçada não registra rebaixamento de guia</small></dd></div>
    <div class="lado"><dt>abaixo de 1,20 m livres</dt>
      <dd>${pct(c.estreita)}<small>das ${num(c.calcadas)} calçadas cadastradas no município</small></dd></div>`;
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
    ["cidade, zoom longe", decidirNivel(10, "", "", null), null],
    ["cidade, zoom perto", decidirNivel(15, "se", "", null), "entrar"],
    ["fica no distrito aberto", decidirNivel(15, "se", "se", ZOOM_CALCADA), null],
    ["troca de distrito ao lado", decidirNivel(15, "bras", "se", ZOOM_CALCADA), "entrar"],
    ["dois distritos na tela", decidirNivel(15, "bras,se", "se", ZOOM_CALCADA), "entrar"],
    ["o mesmo par não remonta", decidirNivel(15, "bras,se", "bras,se", ZOOM_CALCADA), null],
    ["volta à cidade ao afastar", decidirNivel(13, "", "se", ZOOM_CALCADA), "sair"],
    ["distrito grande não fecha sozinho", decidirNivel(12, "", "grajau", 12), null],
    ["aberto no clique, zoom 13, não fecha", decidirNivel(13, "", "pinheiros", 13), null],
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
  mapa = L.map("mapa", {preferCanvas: true, zoomControl: false, minZoom: 9, maxZoom: 19,
                        maxBoundsViscosity: 1});
  L.control.zoom({position: "topright"}).addTo(mapa);
  mapa.attributionControl.setPosition("bottomleft");   // a legenda fica na direita
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(mapa);
  mapa.setView([-23.65, -46.63], 10);

  [municipio, distritos] = await Promise.all([
    fetch(`dados/municipio.json?v=${V}`).then(r => r.json()),
    fetch(`dados/distritos.geojson?v=${V}`).then(r => r.json())]);

  pintarFaixa();
  desenharControles();
  desenharDistritos();
  desenharLegenda();
  desenharTabela();
  mapa.fitBounds(camadaDistritos.getBounds(), {padding: [12, 12], animate: false});
  // O mapa fica preso no município, mas com folga: o painel de cartões cobre o
  // canto superior esquerdo, e sem margem os distritos daquela borda ficam
  // impossíveis de ver. Uma cidade de folga em volta resolve sem soltar o mapa.
  const limite = camadaDistritos.getBounds().pad(0.45);
  mapa.setMaxBounds(limite);
  mapa.setMinZoom(mapa.getBoundsZoom(limite));
  $("#carregando").style.display = "none";

  mapa.on("moveend zoomend", adiar(async () => {
    // O painel tem que acompanhar o mapa mesmo se a troca de nível falhar: sem
    // o finally, um erro lá dentro congelava a tabela na vista anterior.
    try { await porZoom(); } catch (e) { console.error("troca de nível:", e); }
    finally { atualizarPorVista(); montarPontos(); }
  }));

  // Link direto para uma vista: #m=score&d=grajau&f=larga&p=arvores,incidentes
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
  (par.get("p") || "").split(",").filter(k => PONTOS[k]).forEach(k => {
    pontosLigados.add(k);
    $(`#pt-${k}`).setAttribute("aria-pressed", "true");
  });
  const alvo = par.get("d") &&
    distritos.features.find(f => f.properties.id === par.get("d"));
  if (alvo) await irParaDistrito(alvo.properties);

  if (par.has("autoteste")) autoteste();
})();
