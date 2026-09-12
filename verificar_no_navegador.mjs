/* Confere o dashboard dirigindo a página de verdade, pelo DevTools Protocol.
 *
 *   python3 -m http.server 8765 &
 *   google-chrome --headless=new --disable-gpu --remote-debugging-port=9222 about:blank &
 *   node verificar_no_navegador.mjs http://localhost:8765/
 *
 * Irmão do `verificar.py`: aquele prende os números, este prende o comportamento.
 * Sem dependência — o Node 22 já traz WebSocket. Sempre sob teto de memória:
 * foi um vazamento do Chrome que derrubou a máquina no começo deste projeto.
 *
 * Cada ajuste de interface pedido virou uma seção aqui. Quando um teste falha
 * depois de uma mudança de comportamento pedida, o que envelheceu é o teste —
 * já aconteceu três vezes, e vale reler a asserção antes de mexer no código.
 *
 * ARMADILHA 2: não use barra invertida dentro das expressões enviadas ao
 * navegador. Uma normalização com `replace(/\s+/g, " ")` chegou lá como
 * `/s+/g` — a barra some no caminho — e passou a trocar a LETRA "s" por espaço:
 * "calçadas ·" virava "calçada  ·". O teste acusava o dashboard por horas.
 * Compare com `indexOf` e texto ASCII.
 *
 * ARMADILHA 1: mate o Chrome anterior ANTES de subir o novo. Se sobrar um preso à
 * porta 9222, o novo não consegue abri-la, este script se conecta ao velho e
 * testa a PÁGINA ANTIGA — dá falha em código que já está correto. Custou uma
 * caçada inteira. */
const PORTA = Number(process.env.PORTA_CDP || 9222);
const URL = process.argv[2] || "http://localhost:8765/";

const acharAlvo = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA}/json/list`).then(r => r.json());
      const p = r.find(t => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("Chrome não respondeu na porta de depuração");
};

const ws = new WebSocket(await acharAlvo());
await new Promise(r => ws.onopen = r);
let id = 0;
const pendentes = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (pendentes.has(m.id)) { pendentes.get(m.id)(m); pendentes.delete(m.id); }
};
const cdp = (method, params = {}) => new Promise(res => {
  const n = ++id;
  pendentes.set(n, res);
  ws.send(JSON.stringify({id: n, method, params}));
});

const js = async expr => {
  const r = await cdp("Runtime.evaluate", {
    expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true});
  if (r.result?.exceptionDetails || r.result?.result?.subtype === "error") {
    throw new Error(JSON.stringify(r.result.exceptionDetails ?? r.result.result));
  }
  return r.result.result.value;
};
const espera = ms => js(`await new Promise(r => setTimeout(r, ${ms})); return 1;`);

await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Page.navigate", {url: URL});
await espera(4000);   // mapa, distritos.geojson e primeira pintura

/* Sentinela: se sobrar um Chrome preso na porta, este script se conecta a ele e
 * mede a página ANTIGA — dá falha em código que já está certo. Melhor abortar
 * alto do que reportar mentira. */
const versao = await js(`return {
  temPotencial: !!METRICAS.potencial,
  temKm2NaDica: /km²/.test(ligarDistrito.toString()),
  temCartaoVivo: typeof cartoesDaCalcada === "function"};`);
if (!versao.temPotencial || !versao.temKm2NaDica || !versao.temCartaoVivo) {
  console.error("PÁGINA ANTIGA carregada — abortando:", JSON.stringify(versao));
  console.error("provavelmente há outro Chrome preso na porta " + PORTA);
  process.exit(2);
}

const METRICA_ROT = {barreira: "barreira", score: "score", declive: "declividade",
                     estreita: "faixa livre", obstaculo: "obstáculo"};
const falhas = [];
const confere = (rotulo, ok, detalhe) => {
  console.log(`  ${ok ? "ok   " : "FALHA"} ${rotulo}${detalhe ? "  → " + detalhe : ""}`);
  if (!ok) falhas.push(rotulo);
};

/* 1. drill-down por zoom -------------------------------------------------- */
console.log("\n1. o zoom troca para a calçada sozinho");
let r = await js(`
  mapa.setView([-23.5650, -46.6900], 15);
  await new Promise(r => setTimeout(r, 4000));
  return {nomes: abertos.map(p => p.NM_DIST), calcadas: !!camadaCalcadas,
          n: camadaCalcadas ? camadaCalcadas.getLayers().length : 0};`);
confere("entra no nível da calçada ao passar do zoom 14", r.nomes.length >= 1,
        `${r.nomes.join(", ")} · ${r.n} calçadas`);
confere("desenha as calçadas", r.calcadas && r.n > 100, `${r.n} polígonos`);

r = await js(`
  mapa.setView([-23.5650, -46.6900], 12);
  await new Promise(r => setTimeout(r, 2500));
  return {n: abertos.length, calcadas: !!camadaCalcadas};`);
confere("volta à cidade ao afastar", r.n === 0 && !r.calcadas, `abertos=${r.n}`);

console.log("\n1b. vários distritos de uma vez");
r = await js(`
  mapa.setView([-23.5450, -46.6400], 14);
  await new Promise(r => setTimeout(r, 6000));
  return {nomes: abertos.map(p => p.NM_DIST),
          n: camadaCalcadas ? camadaCalcadas.getLayers().length : 0,
          cartao: (document.querySelector("#cartoes .onde")||{}).textContent,
          base: (document.querySelector("#cartoes .base")||{}).textContent,
          nesta: ((document.querySelector("#cartoes .base")||{}).textContent||"").indexOf("nesta vista") >= 0};`);
confere("carrega mais de um distrito quando cabem na tela", r.nomes.length > 1,
        `${r.nomes.length}: ${r.nomes.join(", ")} · ${r.n} calçadas`);
confere("o cartão conta o que está na tela, não o distrito inteiro", r.nesta,
        `"${r.cartao}" · "${(r.base || "").split("\n")[0]}"`);

console.log("\n1c. o mapa fica preso em São Paulo");
r = await js(`
  mapa.setView([40.7, -74.0], 10);
  await new Promise(r => setTimeout(r, 1500));
  const c = mapa.getCenter();
  return {lat: c.lat, lng: c.lng, zoomMin: mapa.getMinZoom()};`);
confere("arrastar para Nova York não sai de São Paulo",
        r.lat < -23 && r.lat > -25 && r.lng < -46 && r.lng > -47.5,
        `centro ficou em ${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`);

console.log("\n1d. a métrica pinta a calçada, o filtro só subtrai");
r = await js(`
  mapa.setView([-23.5650, -46.6900], 15);
  await new Promise(r => setTimeout(r, 5000));
  const titulo = () => document.querySelector("#legenda .titulo").textContent;
  const cores = () => camadaCalcadas.getLayers().slice(0, 400).map(l => l.options.fillColor);
  const distintas = () => new Set(cores()).size;
  const vistos = {};
  for (const k of ["score", "barreira", "estreita", "comprimento", "declive", "obstaculo", "sem_rampa"]) {
    document.querySelector('#pills-metrica button[data-m="' + k + '"]').click();
    await new Promise(r => setTimeout(r, 1800));
    vistos[k] = {titulo: titulo(), tons: distintas(), amostra: cores()[0]};
  }
  return vistos;`);
for (const [k, v] of Object.entries(r)) {
  console.log(`       ${k.padEnd(11)} legenda "${v.titulo}" · ${v.tons} tons`);
}
confere("cada métrica pinta a calçada de um jeito",
        new Set(Object.values(r).map(v => v.amostra)).size > 1,
        Object.values(r).map(v => v.amostra).join(" "));
confere("métrica de sim/não usa duas cores", r.barreira.tons === 2 && r.obstaculo.tons === 2,
        `barreira ${r.barreira.tons} tons, obstáculo ${r.obstaculo.tons}`);
confere("métrica contínua usa a rampa inteira", r.declive.tons > 2 && r.score.tons > 2,
        `declividade ${r.declive.tons} tons, score ${r.score.tons}`);
confere("métrica só do Censo avisa que emprestou a cor",
        /face de quadra/.test(await js(`return document.querySelector("#legenda .nd").textContent;`)),
        r.sem_rampa.titulo);

r = await js(`
  document.querySelector('#pills-metrica button[data-m="declive"]').click();
  await new Promise(r => setTimeout(r, 1800));
  const antesTitulo = document.querySelector("#legenda .titulo").textContent;
  const antes = camadaCalcadas.getLayers().length;
  document.querySelector('#pills-filtro button[data-f="larga"]').click();
  await new Promise(r => setTimeout(r, 2000));
  const depois = camadaCalcadas.getLayers().length;
  const depoisTitulo = document.querySelector("#legenda .titulo").textContent;
  document.querySelector('#pills-filtro button[data-f="larga"]').click();
  await new Promise(r => setTimeout(r, 1500));
  document.querySelector('#pills-metrica button[data-m="barreira"]').click();
  await new Promise(r => setTimeout(r, 1500));
  return {antes, depois, antesTitulo, depoisTitulo};`);
confere("o filtro subtrai calçada", r.depois < r.antes, `${r.antes} → ${r.depois}`);
confere("e não mexe mais na cor", r.antesTitulo === r.depoisTitulo, `"${r.depoisTitulo}"`);

/* 5. tabela recortada pelo enquadramento ---------------------------------- */
console.log("\n5. a tabela acompanha o enquadramento");
const conta = async () => js(`
  await new Promise(r => setTimeout(r, 600));
  return {linhas: document.querySelectorAll("#tabela tr[data-d]").length,
          rotulo: (document.querySelector("#tabela .quantos") || {}).textContent || ""};`);
r = await js(`mapa.setView([-23.55, -46.63], 9); await new Promise(r => setTimeout(r, 1200)); return 1;`);
const largo = await conta();
r = await js(`mapa.setView([-23.55, -46.63], 13); await new Promise(r => setTimeout(r, 1200)); return 1;`);
const perto = await conta();
confere("zoom aberto lista mais distritos que zoom fechado",
        largo.linhas > perto.linhas, `${largo.linhas} (${largo.rotulo}) → ${perto.linhas} (${perto.rotulo})`);

/* 2. ordenação nos dois sentidos ------------------------------------------ */
console.log("\n2. a tabela ordena nos dois sentidos");
r = await js(`
  mapa.setView([-23.55, -46.63], 9); await new Promise(r => setTimeout(r, 1000));
  const ler = () => [...document.querySelectorAll("#tabela tbody .v")].map(e => e.textContent);
  const antes = ler();
  document.querySelector("#ordenar").click();
  await new Promise(r => setTimeout(r, 400));
  const depois = ler();
  return {antes: [antes[0], antes.at(-1)], depois: [depois[0], depois.at(-1)],
          seta: document.querySelector("#ordenar").textContent.trim().slice(-1)};`);
confere("clicar no cabeçalho inverte a ordem",
        r.antes[0] === r.depois.at(-1) && r.antes.at(-1) === r.depois[0],
        `${r.antes.join(" … ")}  ⇄  ${r.depois.join(" … ")}`);
confere("a seta acompanha", r.seta === "▲", `seta ${r.seta}`);
await js(`document.querySelector("#ordenar").click(); await new Promise(r=>setTimeout(r,300)); return 1;`);

/* 7. busca ---------------------------------------------------------------- */
console.log("\n7. barra de busca");
r = await js(`
  const b = document.querySelector("#busca");
  b.value = "se"; b.dispatchEvent(new Event("input", {bubbles: true}));
  await new Promise(r => setTimeout(r, 500));
  const nomes = [...document.querySelectorAll("#tabela tr[data-d]")].map(t => t.dataset.d);
  return {n: nomes.length, tem: nomes.includes("Sé"), amostra: nomes.slice(0, 4)};`);
confere("busca sem acento acha 'Sé' digitando 'se'", r.tem, `${r.n} resultados: ${r.amostra.join(", ")}`);
r = await js(`
  const b = document.querySelector("#busca");
  b.value = "grajau"; b.dispatchEvent(new Event("input", {bubbles: true}));
  await new Promise(r => setTimeout(r, 500));
  const nomes = [...document.querySelectorAll("#tabela tr[data-d]")].map(t => t.dataset.d);
  return {n: nomes.length, nomes};`);
confere("busca é global, acha fora da tela", r.n === 1 && r.nomes[0] === "Grajaú", r.nomes.join(", "));
await js(`const b=document.querySelector("#busca"); b.value=""; b.dispatchEvent(new Event("input",{bubbles:true})); await new Promise(r=>setTimeout(r,400)); return 1;`);

/* 8. a escala não troca de lado ------------------------------------------- */
console.log("\n8. a escala de cor não inverte de lado (nem a cor, nem os números)");
const legenda = async chave => js(`
  document.querySelector('#pills-metrica button[data-m="${chave}"]').click();
  await new Promise(r => setTimeout(r, 700));
  const rot = [...document.querySelectorAll("#legenda .escala-rot span")].map(e => e.textContent);
  const cores = [...document.querySelectorAll("#legenda .escala i")].map(e => e.style.background);
  return {rot, primeira: cores[0], ultima: cores.at(-1)};`);
const lb = await legenda("barreira"), lr = await legenda("sem_rampa");
confere("a rampa de cor fica no mesmo sentido",
        lb.primeira === lr.primeira && lb.ultima === lr.ultima,
        `barreira ${lb.primeira}→${lb.ultima} · sem rampa ${lr.primeira}→${lr.ultima}`);
confere("o menor fica à esquerda nas duas",
        lb.rot[0].startsWith("0") && lr.rot[0].startsWith("0"),
        `barreira [${lb.rot.join(" ")}] · sem rampa [${lr.rot.join(" ")}]`);
await js(`document.querySelector('#pills-metrica button[data-m="barreira"]').click(); await new Promise(r=>setTimeout(r,500)); return 1;`);

/* 4. nenhuma marca de cor que o mapa não use ------------------------------ */
console.log("\n4. cartões sem legenda de cor fantasma");
r = await js(`return {cartoes: document.querySelectorAll("#cartoes .marca-serie").length,
                      faixa: document.querySelectorAll("#vao .marca-serie").length};`);
confere("sem quadradinho azul/laranja nos cartões", r.cartoes === 0 && r.faixa === 0,
        `cartões ${r.cartoes}, faixa ${r.faixa}`);

/* 3. filtro avançado: pontos da cidade inteira ---------------------------- */
console.log("\n3. filtro avançado (árvore, poste, incidente)");
r = await js(`
  mapa.setView([-23.5500, -46.6200], 15);   // Brás/Mooca, longe do piloto antigo
  await new Promise(r => setTimeout(r, 6000));
  return {desligado: document.querySelector("#pt-arvores").disabled,
          onde: abertos.map(p => p.NM_DIST)};`);
confere("habilita fora do recorte antigo de Pinheiros", !r.desligado, r.onde.join(", "));

r = await js(`
  for (const k of ["arvores", "postes", "incidentes"]) {
    document.querySelector("#pt-" + k).click();
    await new Promise(r => setTimeout(r, 1500));
  }
  await new Promise(r => setTimeout(r, 2000));
  const conta = k => camadasPonto[k] ? camadasPonto[k].getLayers().length : 0;
  const corDe = k => camadasPonto[k] && camadasPonto[k].getLayers().length
    ? camadasPonto[k].getLayers()[0].options.color : null;
  const rampa = [...document.querySelectorAll("#legenda .escala i")].map(e => e.style.background);
  return {arvores: conta("arvores"), postes: conta("postes"), inc: conta("incidentes"),
          cores: {arvores: corDe("arvores"), postes: corDe("postes"), incidentes: corDe("incidentes")},
          rampa};`);
confere("árvores desenhadas", r.arvores > 0, `${r.arvores} pontos`);
confere("postes desenhados", r.postes > 0, `${r.postes} pontos`);
const cores = Object.values(r.cores).filter(Boolean);
confere("as três camadas têm cores distintas entre si",
        new Set(cores).size === cores.length, JSON.stringify(r.cores));
confere("nenhuma delas é um tom da rampa da calçada",
        cores.every(c => !r.rampa.includes(c)), `rampa: ${r.rampa[0]} … ${r.rampa.at(-1)}`);

r = await js(`
  document.querySelector("#pt-arvores").click();
  await new Promise(r => setTimeout(r, 2000));
  return {n: camadasPonto.arvores ? camadasPonto.arvores.getLayers().length : 0};`);
confere("desligar apaga a camada", r.n === 0, `${r.n} pontos`);
await js(`
  for (const k of ["postes", "incidentes"]) {
    const b = document.querySelector("#pt-" + k);
    if (b.getAttribute("aria-pressed") === "true") b.click();
  }
  await new Promise(r => setTimeout(r, 1200)); return 1;`);

/* score de acessibilidade ------------------------------------------------- */
console.log("\nscore de acessibilidade");
r = await js(`
  document.querySelector('#pills-metrica button[data-m="score"]').click();
  await new Promise(r => setTimeout(r, 2500));
  const props = camadaCalcadas.getLayers().map(l => l.feature.properties);
  const ruas = new Set(props.map(p => p.rua).filter(Boolean));
  return {titulo: document.querySelector("#legenda .titulo").textContent,
          min: Math.min(...props.map(p => p.score)),
          max: Math.max(...props.map(p => p.score)),
          ruas: ruas.size, ruasComNota: scoreDaRua.size};`);
confere("a legenda passa a ser o score", /score/.test(r.titulo), r.titulo);
confere("score varia entre as calçadas", r.max > r.min && r.min >= 0 && r.max <= 100,
        `de ${r.min} a ${r.max}`);
confere("cada rua tem uma nota", r.ruasComNota > 0 && r.ruasComNota === r.ruas,
        `${r.ruasComNota} ruas`);
await js(`document.querySelector('#pills-metrica button[data-m="barreira"]').click();
          await new Promise(r=>setTimeout(r,1500)); return 1;`);

console.log("\nG. leva 4: score no cartão, filtro por score, tooltips, tabela casada");
r = await js(`
  mapa.setView([-23.5615, -46.6890], 16);
  await new Promise(r => setTimeout(r, 6000));
  const dl = document.querySelector("#cartoes dl").textContent;
  const naTabela = [...document.querySelectorAll("#tabela tr[data-d]")].map(t => t.dataset.d);
  const naVistaAgora = medirVista().map(p => p.NM_DIST);
  return {temScore: /score de acessibilidade/.test(dl),
          temInclinacao: /inclinação média/.test(dl),
          naTela: document.querySelector("#tabela .quantos").textContent,
          naTabela, naVistaAgora, busca, abertos: abertos.map(p => p.NM_DIST)};`);
confere("o cartão traz o score", r.temScore, r.naTela);
confere("o cartão traz a inclinação média", r.temInclinacao);
confere("a tabela lista exatamente quem está no enquadramento",
        r.naTabela.length === r.naVistaAgora.length &&
        r.naVistaAgora.every(n => r.naTabela.includes(n)),
        `tabela [${r.naTabela.join(", ")}] · enquadramento [${r.naVistaAgora.join(", ")}] · busca "${r.busca}"`);
confere("e todo distrito com calçada aparece na tabela",
        r.abertos.every(n => r.naTabela.includes(n)),
        `${r.naTela} · calçadas de ${r.abertos.join(", ")}`);

r = await js(`
  const antes = camadaCalcadas.getLayers().length;
  document.querySelector('#pills-filtro button[data-f="boa"]').click();
  await new Promise(r => setTimeout(r, 2500));
  const props = camadaCalcadas.getLayers().map(l => l.feature.properties);
  return {antes, depois: props.length, minScore: Math.min(...props.map(p => p.score)),
          titulo: document.querySelector("#legenda .titulo").textContent,
          metrica};`);
confere("o filtro de score alvo corta o mapa", r.depois < r.antes && r.depois > 0,
        `${r.antes} → ${r.depois} calçadas`);
confere("sobra só o que passa do alvo", r.minScore >= 30, `menor score ${r.minScore}`);
confere("a cor continua sendo a da métrica escolhida",
        r.titulo.includes(METRICA_ROT[r.metrica] || r.metrica), `métrica ${r.metrica} · "${r.titulo}"`);
await js(`document.querySelector('#pills-filtro button[data-f="boa"]').click();
          await new Promise(r=>setTimeout(r,1500)); return 1;`);

r = await js(`
  const falta = sel => [...document.querySelectorAll(sel)].filter(b => !b.title.trim()).length;
  return {m: falta("#pills-metrica button"), f: falta("#pills-filtro button"),
          p: falta("#pills-ponto button"),
          exemplo: document.querySelector('#pills-metrica button[data-m="sem_rampa"]').title.slice(0, 60)};`);
confere("todo indicador tem tooltip", r.m === 0 && r.f === 0 && r.p === 0,
        `sem título: métricas ${r.m}, filtros ${r.f}, pontos ${r.p}`);
confere("o tooltip explica o indicador", r.exemplo.length > 30, `"${r.exemplo}…"`);

/* leva 3: orientação e clareza -------------------------------------------- */
console.log("\nA. clicar no mapa não teleporta o usuário");
r = await js(`
  mapa.setView([-23.5615, -46.6890], 15);
  await new Promise(r => setTimeout(r, 5000));
  const z0 = mapa.getZoom(), c0 = mapa.getCenter();
  const alvo = camadaDistritos.getLayers().find(l => l.feature.properties.id === "pinheiros");
  alvo.fire("click", {latlng: c0});
  await new Promise(r => setTimeout(r, 4000));
  const c1 = mapa.getCenter();
  return {z0, z1: mapa.getZoom(),
          dLat: Math.abs(c1.lat - c0.lat), dLng: Math.abs(c1.lng - c0.lng)};`);
confere("clicar num distrito mantém zoom e posição", r.z0 === r.z1 && r.dLat < 1e-6 && r.dLng < 1e-6,
        `zoom ${r.z0}→${r.z1}, deslocou ${r.dLat.toFixed(6)}, ${r.dLng.toFixed(6)}`);

console.log("\nB. contorno dos distritos por baixo da calçada");
r = await js(`return {contorno: !!camadaContorno && mapa.hasLayer(camadaContorno),
                      linhas: camadaContorno ? camadaContorno.getLayers().length : 0};`);
confere("a divisa continua desenhada com a calçada na tela", r.contorno,
        `${r.linhas} distritos contornados`);

console.log("\nC. a escala nunca troca de lado");
r = await js(`
  const ler = async k => {
    document.querySelector('#pills-metrica button[data-m="' + k + '"]').click();
    await new Promise(r => setTimeout(r, 900));
    return {rot: [...document.querySelectorAll("#legenda .escala-rot span")].map(e => e.textContent),
            cores: [...document.querySelectorAll("#legenda .escala i")].map(e => e.style.background)};
  };
  const a = await ler("barreira"), b = await ler("declive"), c = await ler("score");
  return {a, b, c};`);
const primeiros = [r.a, r.b, r.c].map(x => x.cores[0]);
confere("a rampa de cor começa igual em todas as métricas",
        new Set(primeiros).size === 1, primeiros.join(" / "));
confere("nas métricas contínuas o menor fica à esquerda",
        [r.b, r.c].every(x => /^0/.test(x.rot[0])),
        [r.a, r.b, r.c].map(x => `[${x.rot[0]} … ${x.rot.at(-1)}]`).join(" "));

console.log("\nD. a tabela diz o que mede");
r = await js(`
  document.querySelector('#pills-metrica button[data-m="score"]').click();
  await new Promise(r => setTimeout(r, 1200));
  const base = document.querySelector("#tabela .tab-base").textContent;
  const v = document.querySelector("#tabela tbody .v").textContent;
  const cab = document.querySelector("#ordenar").textContent.trim();
  document.querySelector('#pills-metrica button[data-m="declive"]').click();
  await new Promise(r => setTimeout(r, 1200));
  return {base, v, cab,
          base2: document.querySelector("#tabela .tab-base").textContent,
          v2: document.querySelector("#tabela tbody .v").textContent};`);
confere("score não aparece como porcentagem", !r.v.includes("%"), `valor "${r.v}", cabeçalho "${r.cab}"`);
confere("score explica a base", /0 a 100/.test(r.base), r.base);
confere("inclinação diz o denominador", /calçadas do distrito/.test(r.base2), r.base2);
confere("inclinação continua em %", r.v2.includes("%"), `valor "${r.v2}"`);

console.log("\nE. controles cinza sem calçada na tela");
r = await js(`
  mapa.setView([-23.60, -46.63], 10);
  await new Promise(r => setTimeout(r, 3000));
  const ler = sel => [...document.querySelectorAll(sel)].map(b => b.disabled);
  return {filtros: ler("#pills-filtro button"), pontos: ler("#pills-ponto button"),
          favela: document.querySelector("#btn-favela").disabled, abertos: abertos.length};`);
confere("filtros de calçada ficam desabilitados no zoom aberto",
        r.filtros.every(Boolean) && r.pontos.every(Boolean) && r.favela,
        `filtros ${r.filtros} · pontos ${r.pontos} · favela ${r.favela}`);
r = await js(`
  mapa.setView([-23.5615, -46.6890], 15);
  await new Promise(r => setTimeout(r, 5000));
  return {filtros: [...document.querySelectorAll("#pills-filtro button")].map(b => b.disabled)};`);
confere("e voltam a valer quando a calçada entra", r.filtros.every(v => !v), `${r.filtros}`);

console.log("\nF. o mapa tem folga para sair de baixo do painel");
r = await js(`
  const b = mapa.options.maxBounds, d = camadaDistritos.getBounds();
  return {folgaOeste: (d.getWest() - b.getWest()).toFixed(3),
          folgaNorte: (b.getNorth() - d.getNorth()).toFixed(3)};`);
confere("há margem além dos distritos nos quatro lados",
        Number(r.folgaOeste) > 0.1 && Number(r.folgaNorte) > 0.1,
        `oeste ${r.folgaOeste}°, norte ${r.folgaNorte}°`);

/* leva 5: layout estável e referência preservada -------------------------- */
console.log("\nH. o layout não pula quando a calçada entra");
r = await js(`
  mapa.setView([-23.5615, -46.6890], 13);
  await new Promise(r => setTimeout(r, 3500));
  const alt = () => Math.round(document.querySelector("#controles").getBoundingClientRect().height);
  const topo = () => Math.round(document.querySelector("#mapa").getBoundingClientRect().top);
  const a = {alt: alt(), topo: topo(), abertos: abertos.length};
  mapa.setZoom(14);
  await new Promise(r => setTimeout(r, 6000));
  return {a, b: {alt: alt(), topo: topo(), abertos: abertos.length}};`);
confere("a barra de controles não muda de altura", r.a.alt === r.b.alt,
        `${r.a.alt}px → ${r.b.alt}px`);
confere("o mapa não desce na página", r.a.topo === r.b.topo, `${r.a.topo}px → ${r.b.topo}px`);
confere("o botão voltar mora dentro do mapa",
        await js(`return document.querySelector("#voltar").closest(".envelope-mapa") !== null;`));

console.log("\nI. a referência do bairro se mantém");
r = await js(`
  return {veu: !!camadaContorno && mapa.hasLayer(camadaContorno),
          rotulos: camadaRotulos ? camadaRotulos.getLayers().length : 0,
          abertos: abertos.length,
          nomes: camadaRotulos ? camadaRotulos.getLayers().map(m => m.options.icon.options.html) : [],
          base: document.querySelector(".envelope-mapa").classList.contains("perto"),
          botao: !document.querySelector("#voltar").hidden};`);
confere("o véu do distrito continua pintado por baixo", r.veu);
confere("um rótulo para cada distrito carregado", r.rotulos === r.abertos && r.rotulos > 0,
        `${r.rotulos} rótulos: ${r.nomes.join(", ")}`);
confere("o mapa base fica mais legível de perto", r.base);
confere("o botão voltar aparece", r.botao);

r = await js(`
  const c0 = mapa.getCenter(), z0 = mapa.getZoom();
  document.querySelector("#voltar").click();
  await new Promise(r => setTimeout(r, 3000));
  return {abertos: abertos.length, rotulos: camadaRotulos ? 1 : 0,
          base: document.querySelector(".envelope-mapa").classList.contains("perto")};`);
confere("voltar à cidade limpa véu, rótulo e mapa base",
        r.abertos === 0 && r.rotulos === 0 && !r.base, JSON.stringify(r));

/* leva 6 ----------------------------------------------------------------- */
console.log("\nJ. escolher um distrito fixa o recorte");
r = await js(`
  mapa.setView([-23.5615, -46.6890], 13);
  await new Promise(r => setTimeout(r, 5000));
  const semSelecao = abertos.length;
  const linha = [...document.querySelectorAll("#tabela tr[data-d] button")]
    .find(b => b.closest("tr").dataset.d === "Pinheiros");
  linha.click();
  await new Promise(r => setTimeout(r, 5000));
  return {semSelecao, comSelecao: abertos.map(p => p.NM_DIST),
          cartao: document.querySelector("#cartoes .onde").textContent,
          naTela: document.querySelector("#tabela .quantos").textContent};`);
confere("clicar na tabela recorta os dados naquele distrito",
        r.comSelecao.length === 1 && r.comSelecao[0] === "Pinheiros",
        `${r.semSelecao} distritos antes → ${r.comSelecao.join(", ")} · cartão "${r.cartao}"`);
confere("a tabela continua mostrando os vizinhos da tela",
        parseInt(r.naTela) > 1, `${r.naTela}`);

/* Clicar de novo no distrito fixado só tira o foco. O que ele NÃO pode fazer é
 * voltar à cidade: o usuário perde a referência de onde estava olhando. */
r = await js(`
  const antes = {z: mapa.getZoom(), c: mapa.getCenter()};
  const linha = [...document.querySelectorAll("#tabela tr[data-d] button")]
    .find(b => b.closest("tr").dataset.d === "Pinheiros");
  linha.click();
  await new Promise(r => setTimeout(r, 5000));
  const d = mapa.getCenter();
  return {fixado: selecionado, abertos: abertos.map(p => p.NM_DIST),
          calcadas: camadaCalcadas ? camadaCalcadas.getLayers().length : 0,
          zoomIgual: mapa.getZoom() === antes.z,
          moveu: Math.max(Math.abs(d.lat - antes.c.lat), Math.abs(d.lng - antes.c.lng))};`);
confere("clicar de novo na mesma linha solta a fixação", r.fixado === null,
        `fixado=${r.fixado} · ${r.abertos.join(", ")}`);
confere("e o mapa fica onde estava, com as calçadas na tela",
        r.zoomIgual && r.moveu < 1e-6 && r.calcadas > 100,
        `zoom igual=${r.zoomIgual} · centro moveu ${r.moveu} · ${r.calcadas} calçadas`);
confere("os vizinhos voltam ao recorte", r.abertos.length > 1, r.abertos.join(", "));

r = await js(`
  mapa.setView([-23.5300, -46.6200], 14);
  await new Promise(r => setTimeout(r, 6000));
  return {abertos: abertos.map(p => p.NM_DIST), fixado: selecionado};`);
confere("sair de vista solta a fixação", r.fixado === null && r.abertos.length >= 1,
        `fixado=${r.fixado} · ${r.abertos.join(", ")}`);

console.log("\nK. score sem % em lugar nenhum");
r = await js(`
  mapa.setView([-23.60, -46.63], 10);
  await new Promise(r => setTimeout(r, 3000));
  document.querySelector('#pills-metrica button[data-m="score"]').click();
  await new Promise(r => setTimeout(r, 1500));
  const l = camadaDistritos.getLayers()[0];
  l.fire("mousemove", {originalEvent: {clientX: 400, clientY: 400}, latlng: mapa.getCenter()});
  await new Promise(r => setTimeout(r, 400));
  return {dica: document.querySelector("#dica").textContent.replace(/\s+/g, " ").trim(),
          tabela: document.querySelector("#tabela tbody .v").textContent,
          legenda: [...document.querySelectorAll("#legenda .escala-rot span")].map(e => e.textContent)};`);
confere("a dica do distrito não põe % no score", !/\d,\d%/.test(r.dica), r.dica.slice(0, 70));
confere("a tabela também não", !r.tabela.includes("%"), r.tabela);
confere("nem a legenda", !r.legenda.join("").includes("%"), r.legenda.join(" … "));
await js(`document.querySelector('#pills-metrica button[data-m="barreira"]').click();
          await new Promise(r=>setTimeout(r,1200)); return 1;`);

console.log("\nL. incidente conta o que foi reportado");
r = await js(`
  mapa.setView([-23.5615, -46.6890], 15);
  await new Promise(r => setTimeout(r, 6000));
  const b = document.querySelector("#pt-incidentes");
  if (b.getAttribute("aria-pressed") !== "true") b.click();
  await new Promise(r => setTimeout(r, 3000));
  const camada = camadasPonto.incidentes;
  if (!camada || !camada.getLayers().length) return {n: 0};
  const m = camada.getLayers()[0];
  m.fire("mousemove", {originalEvent: {clientX: 400, clientY: 400}, latlng: m.getLatLng()});
  await new Promise(r => setTimeout(r, 400));
  return {n: camada.getLayers().length,
          dica: document.querySelector("#dica").textContent.replace(/\s+/g, " ").trim()};`);
confere("passar o mouse no incidente diz o que foi reportado",
        r.n > 0 && /Capina|árvore|Queda|Poda|reclamação/i.test(r.dica || ""),
        `${r.n} incidentes · "${(r.dica || "").slice(0, 80)}"`);
confere("com data e situação", /\d{2}\/\d{4}/.test(r.dica || ""), (r.dica || "").slice(0, 90));

console.log("\nM. quem mora aqui sobrevive ao nível da calçada");
r = await js(`
  mapa.setView([-23.5615, -46.6890], 15);
  await new Promise(r => setTimeout(r, 6000));
  const t = document.querySelector("#cartoes").textContent;
  return {texto: t.slice(-160), abertos: abertos.length,
          criancas: abertos.map(p => p.criancas_0a4),
          municipioCriancas: municipio.criancas_0a4,
          saidaQuemMora: quemMora(abertos).slice(0, 60),
          temCriancas: t.indexOf("de 0 a 4 anos") >= 0,
          temPct: t.indexOf("da cidade") >= 0};`);
confere("o cartão da calçada mantém as crianças de 0 a 4", r.temCriancas,
        r.temCriancas ? (r.texto.match(/[\d.]+ crianças de 0 a 4 anos moram aqui[^.]*/) || [""])[0]
        : `abertos=${r.abertos} criancas=[${r.criancas}] municipio=${r.municipioCriancas} quemMora="${r.saidaQuemMora}"`);
confere("e diz quanto pesa na cidade", r.temPct);

/* leva 7: potencial de adoção --------------------------------------------- */
console.log("\nN. potencial de adoção");
r = await js(`
  mapa.setView([-23.60, -46.63], 10);
  await new Promise(r => setTimeout(r, 3500));
  document.querySelector('#pills-metrica button[data-m="potencial"]').click();
  await new Promise(r => setTimeout(r, 2000));
  const linhas = [...document.querySelectorAll("#tabela tr[data-d]")];
  const l = camadaDistritos.getLayers().find(x => x.feature.properties.NM_DIST === "República");
  l.fire("mousemove", {originalEvent: {clientX: 400, clientY: 400}, latlng: mapa.getCenter()});
  await new Promise(r => setTimeout(r, 400));
  return {base: document.querySelector("#tabela .tab-base").textContent,
          primeiro: linhas[0] ? linhas[0].dataset.d : null,
          valor: linhas[0] ? linhas[0].querySelector(".v").textContent : null,
          titleLinha: linhas[0] ? linhas[0].querySelector("button").title : "",
          legenda: [...document.querySelectorAll("#legenda .escala-rot span")].map(e => e.textContent),
          dica: document.querySelector("#dica").textContent,
          dicaTemKm: document.querySelector("#dica").textContent.indexOf(" km") >= 0,
          dicaTemCriancas: document.querySelector("#dica").textContent.indexOf("de 0 a 4") >= 0,
          pintou: new Set(camadaDistritos.getLayers().map(x => x.options.fillColor)).size};`);
confere("a pílula ordena a tabela pelo potencial", r.primeiro === "República",
        `${r.primeiro} ${r.valor}`);
confere("sem % na coluna", !String(r.valor).includes("%"), String(r.valor));
confere("a base explica o que é", /por km²/.test(r.base), r.base);
confere("a legenda vai de 0 a 450", r.legenda[0] === "0" && r.legenda.at(-1) === "450",
        r.legenda.join(" … "));
confere("o mapa fica com vários tons", r.pintou > 3, `${r.pintou} tons`);
confere("a dica traz crianças e km² junto do valor",
        r.dicaTemCriancas && r.dicaTemKm, r.dica.slice(0, 100));
confere("a linha da tabela também", /crianças de 0 a 4 em/.test(r.titleLinha), r.titleLinha);

r = await js(`
  mapa.setView([-23.5615, -46.6890], 15);
  await new Promise(r => setTimeout(r, 6000));
  return {titulo: document.querySelector("#legenda .titulo").textContent,
          nota: document.querySelector("#legenda .nd").textContent.trim()};`);
confere("de perto a cor cai para a faixa livre", /faixa livre/.test(r.titulo), r.titulo);
confere("e a legenda diz que o indicador é só por distrito",
        /face de quadra|distrito/.test(r.nota), r.nota);
await js(`document.querySelector('#pills-metrica button[data-m="barreira"]').click();
          await new Promise(r=>setTimeout(r,1500)); return 1;`);

/* filtros ainda subtraem -------------------------------------------------- */
console.log("\nfiltros (regressão)");
r = await js(`
  mapa.setView([-23.5615, -46.6890], 15);
  await new Promise(r => setTimeout(r, 6000));
  const antes = camadaCalcadas.getLayers().length;
  document.querySelector('#pills-filtro button[data-f="livre"]').click();
  await new Promise(r => setTimeout(r, 1200));
  return {antes, depois: camadaCalcadas.getLayers().length};`);
confere("ligar um filtro apaga calçada do mapa", r.depois < r.antes,
        `${r.antes} → ${r.depois} calçadas`);

console.log(falhas.length ? `\n${falhas.length} FALHA(S): ${falhas.join(" · ")}`
                          : "\ntudo conferido");
ws.close();
process.exit(falhas.length ? 1 : 0);
