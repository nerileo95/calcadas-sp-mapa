# Qualidade das Calçadas de São Paulo

**No ar:** https://nerileo95.github.io/calcadas-sp-mapa/

Dashboard estático e interativo sobre as 491.383 calçadas cadastradas pela Prefeitura de São Paulo,
lidas pela pergunta de quem empurra um carrinho de bebê: **dá para passar?**

Atividade Intermediária 03 · Prática Avançada em Data Science and Visualization · Insper

---

## A pergunta norteadora

> Medir a calçada da cidade pela pergunta de quem empurra um carrinho de bebê: dá para passar?

Ela está escrita no bloco **Objetivo**, logo abaixo do título, e é o que amarra a tela inteira. A
resposta, trecho a trecho, é o que sustentaria um aplicativo de rotas para pais e mães: antes de
sugerir um caminho ele precisa saber onde a calçada é larga o bastante, plana o bastante e livre de
obstáculo. Por isso o painel não para no diagnóstico. O **score de acessibilidade** dá uma nota a
cada trecho, e o **potencial de adoção** mostra onde há, ao mesmo tempo, criança pequena e calçada
boa o bastante para uma rota funcionar.

## O que a tela entrega

**Duas visualizações.** Um **mapa** com duas resoluções: os 96 distritos pintados pelo indicador
escolhido e, a partir do zoom 14, as calçadas de verdade, uma a uma, de todos os distritos que
couberem no enquadramento. E uma **tabela ordenável** que acompanha o mapa, onde cada linha traz a
barra proporcional do indicador, funcionando como gráfico de barras do ranking.

**Indicadores em destaque.** Quatro taxas do município, no alto da página: dentro das normas
(46,5%), com ao menos uma barreira (53,5%), sem rampa (81,4%) e abaixo de 1,20 m de faixa livre
(47,3%). As duas primeiras são complementares e somam 100%.

**Interatividade.** Dez indicadores que repintam mapa e tabela; cinco filtros que só subtraem, mais
o recorte de favela e comunidade urbana; três camadas de ponto no filtro avançado (652.976 árvores,
662.945 postes, 7.006 chamados); busca de distrito sem acento; drill-down por zoom; e link direto
com o estado da tela, como `#m=potencial&d=grajau&f=larga,livre&p=arvores`.

## A base, e por que não foi uma das duas coringa

O enunciado sugere CNPJ da Receita Federal ou RAIS. Usamos outra base pública, com o aval do
professor: o cadastro de calçadas do GeoSampa. A razão é que ele responde a uma pergunta que as
outras duas não alcançam, e que é a pergunta do nosso projeto integrador.

| fonte | o que entra |
|---|---|
| **GeoSampa**, camada `geoportal:calcada` | 491.383 trechos com área, largura mínima e média e declividade |
| **GeoSampa**, árvore, iluminação pública e chamados SAC | 652.976 árvores, 662.945 postes, 7.006 chamados |
| **IBGE**, Censo 2022, Agregados por Setores Censitários | 287.699 faces de quadra em 26.605 setores |

Tudo agregado: nenhum microdado individual, nenhuma identificação.

## A customização estética, e por quê

**Paleta.** O mapa usa uma **rampa sequencial de uma cor só**, do azul-claro `#cde2fb` ao
azul-escuro `#0d366b`. Escala sequencial é a escolha correta para grandeza ordenada, e uma cor só
evita que o leitor tente ler significado no matiz. A regra vale para os dez indicadores: **mais
forte é sempre mais intenso**, e o que muda é a frase da legenda, porque em "score" muito é bom e
em "barreira" muito é ruim. A alternativa que descartamos foi a rampa divergente vermelho-verde, que
insinuaria um ponto neutro no meio que os dados não têm.

As camadas de ponto do filtro avançado ficam **fora da família azul** de propósito: se fossem outro
tom de azul, uma árvore caindo em cima de uma calçada viraria mais um degrau da escala.

O basemap é dessaturado e desbotado. Ele é **contexto, não conteúdo**: o dado pintado é que manda.
Quando o zoom desce à calçada, ele volta a ficar legível, porque aí o nome da rua é a âncora que diz
ao usuário que ele continua no mesmo lugar.

**Tipografia.** **Archivo** para texto, uma grotesca de traço firme que aguenta corpo pequeno em
tabela densa. **IBM Plex Mono** para todo número e rótulo de eixo, com `font-variant-numeric:
tabular-nums`, para que os dígitos fiquem alinhados em coluna e a comparação vertical na tabela seja
possível sem esforço.

**Layout.** Mapa e tabela lado a lado, e não em abas: a tabela é o mesmo recorte do mapa em outra
forma, e alternar entre os dois quebraria a leitura. Os controles ficam entre o cabeçalho e o mapa,
agrupados por função, com o nome do grupo acima das pílulas. Tema claro e escuro seguem o sistema.

## Reprodutibilidade

```bash
git clone https://github.com/nerileo95/calcadas-sp-mapa
cd calcadas-sp-mapa
pip install -r requirements.txt

# 1. baixar as camadas do GeoSampa que não cabem no repositório (~400 MB)
python baixar_geosampa.py

# 2. preparar os dados do mapa: lê fontes/ e escreve dados/, ~1 min
python preparar_dados.py

# 3. servir
python -m http.server 8000
```

As camadas do IBGE e o cadastro de atributos das calçadas já vêm versionados em `fontes/`. A
geometria das calçadas, as árvores e os postes ficam fora do repositório por tamanho, e é isso que
o `baixar_geosampa.py` busca; ele grava página por página e uma segunda execução pula o que já
está em disco, porque o serviço do GeoSampa cai com frequência.

### Verificação

```bash
python verificar.py                              # recalcula os números do parquet contra o publicado
node verificar_no_navegador.mjs http://localhost:8000/
```

O primeiro prende os **números**: refaz cada taxa a partir da fonte e compara com o que está em
`dados/`. O segundo prende o **comportamento**, dirigindo a página pelo DevTools Protocol: se um
filtro deixa de apagar calçada do mapa, se a legenda inverte, se a escala perde tons, ele acusa.

## Os arquivos

| arquivo | o que faz |
|---|---|
| `index.html` | a página: estrutura, paleta e tipografia |
| `app.js` | o mapa, a tabela, os filtros e os indicadores |
| `baixar_geosampa.py` | baixa as camadas do WFS do GeoSampa |
| `preparar_dados.py` | agrega `fontes/` em `dados/`, na resolução do mapa |
| `verificar.py` | confere os números |
| `verificar_no_navegador.mjs` | confere o comportamento da página |

`app.js` e os arquivos de `dados/` compartilham uma versão (`const V` no topo do `app.js`, e
`app.js?v=` no `index.html`). Ela precisa subir a cada publicação que mexa em qualquer um dos dois,
senão o navegador continua servindo o anterior por dez minutos.

## O que este painel não diz

O cadastro descreve a **geometria** da calçada, não o estado dela: não há buraco, piso solto nem
rampa de esquina. Rampa para cadeirante só existe no Censo, por face de quadra, e por isso é métrica
de distrito e nunca filtro de calçada. A faixa livre desconta 0,70 m onde há árvore ou poste, com
desconto binário, o mesmo para uma árvore e para quarenta, porque o cadastro não registra a posição
do obstáculo; é por isso que ela chega a ficar negativa. A metodologia completa está no rodapé da
própria página.
