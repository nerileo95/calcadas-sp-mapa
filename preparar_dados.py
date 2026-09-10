"""Prepara os dados do mapa a partir das fontes do IBGE e do GeoSampa.

    python preparar_dados.py

Lê `fontes/` e escreve `dados/`. Roda em ~1 min. Nada aqui depende de rede:
as fontes vêm no repositório, agregadas por setor censitário, sem identificação
individual. Como foram obtidas está no README.

O mapa tem duas resoluções, e este script produz as duas:
  cidade    96 distritos     taxas das calçadas de cada um, e o Censo 2022 por face
  distrito  a calçada em si  GeoSampa, 491.383 polígonos, um arquivo por distrito
            mais árvore, poste e reclamação da cidade, em dados/pontos/

A geometria das calçadas não cabe no repositório (161 MB): rode antes o
`baixar_calcadas.py`, que a busca no WFS do GeoSampa.
"""
import json
import re
import unicodedata
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

FONTES, SAIDA = Path("fontes"), Path("dados")
CRS_MAPA = 4326
# 6 casas decimais ≈ 10 cm. Mais que isso é byte sem informação: o próprio
# dado do Censo é por face de quadra, não por centímetro.
GEOJSON = {"driver": "GeoJSON", "COORDINATE_PRECISION": 6}

# Dicionário oficial: dicionarios_de_dados_entorno.zip -> dicionario_entorno_faces.xlsx
# https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/
#   Agregados_por_Setores_Censitarios_Caracteristicas_urbanisticas_do_entorno_dos_domicilios/
BLOCOS = {
    "pavimentada": ("V05406", "V05407", "V05408", "via pavimentada"),
    "bueiro":      ("V05409", "V05410", "V05411", "bueiro ou boca de lobo"),
    "iluminacao":  ("V05412", "V05413", "V05414", "iluminação pública"),
    "onibus":      ("V05415", "V05416", "V05417", "ponto de ônibus"),
    "ciclovia":    ("V05418", "V05419", "V05420", "via sinalizada para bicicleta"),
    "calcada":     ("V05421", "V05422", "V05423", "calçada"),
    "obstaculo":   ("V05424", "V05425", "V05426", "obstáculo na calçada"),
    "rampa":       ("V05427", "V05428", "V05429", "rampa para cadeirante"),
}
# Arborização não é sim/não: o Censo conta árvores por face, em quatro faixas.
ARBORIZACAO = {"V05430": "sem árvores", "V05431": "1 a 2", "V05432": "3 a 4",
               "V05433": "5 ou mais", "V05434": "saltado"}

# Decreto Municipal 59.671/2020 (regulamenta a Lei 15.442/2011) e NBR 9050.
# Os mesmos limiares do notebook 02 do trabalho integrador — não reinventar aqui.
FAIXA_LIVRE_MIN_M = 1.20     # faixa livre: o que sobra para andar
FAIXA_SERVICO_MIN_M = 0.70   # o que a árvore ou o poste toma da largura
DECLIVIDADE_MAX_PCT = 8.33   # 1:12
CRS_METRICO = 31983          # SIRGAS 2000 / UTM 23S, para contar em metros

# Nota de passeio, com os pesos do `motor.py` do trabalho integrador — mesma
# estrutura, para que o dash e o app de rotas falem a mesma língua. Lá a quinta
# parcela era "praça"; aqui ela dá lugar à reclamação, com o sinal trocado.
#
# A mesma árvore entra duas vezes e com sinais opostos, e isso é proposital:
# ela desconta 0,70 m da faixa livre (obstáculo) e soma sombra (conforto). Uma
# calçada larga e arborizada ganha nos dois; uma estreita com árvore no meio
# perde na largura mais do que ganha na sombra.
PESO = {"sombra": .30, "luz": .20, "largura": .20, "plano": .15, "reclamacao": .15}
# Densidade em que a parcela satura, medida NESTA unidade. Os valores vinham do
# `motor.py`, onde a unidade é o quarteirão do OSM e a árvore conta num buffer de
# 12 m do eixo da via. Aqui a unidade é o trecho de calçada (mediana de 24 m) e
# só conta a árvore DENTRO do polígono: 20 e 12 eram o p99 desta distribuição, de
# modo que só o 1% mais arborizado saturava e a nota ficava espremida no primeiro
# terço da régua. Estes são o p90 medido sobre as 491.383 calçadas.
ARVORES_REF_100M = 7.0       # p90 medido: 6,8 por 100 m
POSTES_REF_100M = 5.0        # p90 medido: 4,7 por 100 m
RECLAMACOES_REF = 3.0        # daqui para cima a penalidade é cheia
RAIO_RECLAMACAO_M = 20       # a reclamação é um endereço: cai na via, não na calçada

# Reclamação com endereço. Tapa-buraco ficou de fora: é da via, não da calçada.
RECLAMACOES = ["geo_sac_mato.parquet", "geo_sac_arvore_risco.parquet",
               "geo_sac_arvore_urg.parquet"]


def slug(nome):
    s = unicodedata.normalize("NFKD", str(nome))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def metricas(g):
    """Taxas a partir das contagens de face.

    Duas famílias de denominador, e a diferença importa:
      - sobre TODAS as faces: pavimentação, iluminação, calçada, arborização
      - sobre as faces QUE TÊM calçada: obstáculo e rampa

    `rampa_faces` existe porque o vão (pavimentação − rampa) só pode ser subtraído
    se as duas taxas dividirem o mesmo denominador. Sem isso o número principal do
    painel estaria errado por construção.
    """
    faces = g["V05400"]
    com_calcada = g["V05421"]
    seguro = lambda num, den: np.where(den > 0, 100 * num / den.replace(0, np.nan), np.nan)

    m = pd.DataFrame(index=g.index)
    m["faces"] = faces
    for chave, (sim, _nao, _nd, _rot) in BLOCOS.items():
        m[chave] = seguro(g[sim], faces)
    # obstáculo e rampa: o universo é quem tem calçada
    m["obstaculo"] = seguro(g["V05424"], com_calcada)
    m["rampa"] = seguro(g["V05427"], com_calcada)
    # A pergunta útil é quantas faces com calçada NÃO têm rampa: é o que falta,
    # não o que existe. V05429 (não determinado) fica de fora dos dois lados.
    m["sem_rampa"] = seguro(g["V05428"], com_calcada)
    m["rampa_faces"] = seguro(g["V05427"], faces)
    m["sem_calcada"] = seguro(g["V05422"], faces)
    m["sem_arvore"] = seguro(g["V05430"], faces)
    m["muitas_arvores"] = seguro(g["V05433"], faces)
    m["vao"] = m["pavimentada"] - m["rampa_faces"]
    return m.round(2)


def contagens(g):
    """As contagens brutas vão junto: é com elas que o navegador recalcula os
    cartões quando o usuário move o mapa. Recalcular a partir de percentuais
    daria média de média."""
    cols = ["V05400", "V05421", "V05406", "V05412", "V05422", "V05424", "V05427",
            "V05428", "V05409", "V05415", "V05418", "V05430", "V05433"]
    return g[cols].astype(int)


def pontuar(c):
    """Conta árvore, poste e reclamação em cada calçada e devolve a nota 0..1.

    A contagem de árvore e poste é refeita aqui a partir do WFS, e não herdada:
    é o que torna `n_obst` reproduzível por este repositório. O resultado é
    conferido contra a coluna herdada logo abaixo.
    """
    utm = c[["geometry"]].to_crs(CRS_METRICO)

    def dentro(arquivo):
        p = gpd.read_parquet(FONTES / arquivo).to_crs(CRS_METRICO)
        j = gpd.sjoin(p, utm, how="inner", predicate="within")
        return j.groupby("index_right").size().reindex(c.index, fill_value=0), len(p)

    c["n_arvores"], n_arv = dentro("geo_arvores.parquet")
    c["n_postes"], n_pos = dentro("geo_postes.parquet")
    print(f"  {n_arv:,} árvores e {n_pos:,} postes contados nas calçadas".replace(",", "."))
    igual = (c.n_arvores + c.n_postes == c.obst).mean()
    print(f"  bate com o n_obst herdado em {igual * 100:.1f}% das calçadas")

    # A reclamação é um endereço: cai na via, não dentro do polígono da calçada.
    rec = pd.concat([gpd.read_parquet(FONTES / f).to_crs(CRS_METRICO) for f in RECLAMACOES],
                    ignore_index=True)
    j = gpd.sjoin_nearest(rec, utm, how="inner", max_distance=RAIO_RECLAMACAO_M)
    c["n_rec"] = j.groupby("index_right").size().reindex(c.index, fill_value=0)
    print(f"  {len(rec):,} reclamações, {int((c.n_rec > 0).sum()):,} calçadas atingidas"
          .replace(",", "."))

    # Densidade por 100 m. Não há comprimento no cadastro: área sobre largura
    # média é a melhor aproximação com o que existe.
    comp = (c.qt_area_calcada / c.qt_largura_media_trecho.replace(0, np.nan)).clip(lower=5)
    # guardado: vira indicador de mapa. É ESTIMATIVA, e o rótulo diz isso — o
    # cadastro não traz comprimento, e área sobre largura média é o que dá para
    # fazer com o que existe.
    c["comprimento"] = comp.round(1)
    por100 = lambda n: n / (comp / 100)
    q = pd.DataFrame(index=c.index)
    q["sombra"] = (por100(c.n_arvores) / ARVORES_REF_100M).clip(0, 1)
    q["luz"] = (por100(c.n_postes) / POSTES_REF_100M).clip(0, 1)
    q["largura"] = ((c.livre_min - FAIXA_LIVRE_MIN_M) / 1.80).clip(0, 1).fillna(.15)
    q["plano"] = (1 - c.declive / DECLIVIDADE_MAX_PCT).clip(0, 1)
    q["reclamacao"] = (c.n_rec / RECLAMACOES_REF).clip(0, 1)
    nota = (PESO["sombra"] * q.sombra + PESO["luz"] * q.luz
            + PESO["largura"] * q.largura + PESO["plano"] * q.plano
            - PESO["reclamacao"] * q.reclamacao).clip(0, 1)
    return nota.fillna(0)


def pontos_por_distrito(malha):
    """Um arquivo de pontos por distrito, para o filtro avançado do mapa.

    O distrito de cada ponto sai da malha censitária, a mesma das calçadas.
    Dissolver os 491 mil polígonos de calçada por distrito seria o caminho
    óbvio e estoura o GEOS: há geometria inválida no cadastro.
    """
    (SAIDA / "pontos").mkdir(exist_ok=True)
    camadas = {"arvores": ["geo_arvores.parquet"], "postes": ["geo_postes.parquet"],
               "incidentes": RECLAMACOES}
    guardados = {}
    for nome, arquivos in camadas.items():
        partes = []
        for f in arquivos:
            g = gpd.read_parquet(FONTES / f).to_crs(CRS_MAPA)
            if nome == "incidentes":
                # Cada camada nomeia os campos à sua maneira; aqui viram três
                # colunas só, que é o que a dica do mapa mostra.
                g["oque"] = (g["dc_servico"] if "dc_servico" in g
                             else g["dc_tipo_ocorrencia"]).str.strip()
                data = g["dt_abertura"] if "dt_abertura" in g else g["dt_ocorrencia"]
                g["quando"] = pd.to_datetime(data, utc=True, errors="coerce").dt.strftime("%m/%Y")
                g["situacao"] = (g["tx_situacao_solicitacao"].str.capitalize()
                                 if "tx_situacao_solicitacao" in g else "")
                g = g[["geometry", "oque", "quando", "situacao"]]
            partes.append(g)
        p = pd.concat(partes, ignore_index=True)
        p = gpd.GeoDataFrame(p, geometry="geometry", crs=CRS_MAPA)
        m = malha[["NM_DIST", "geometry"]]
        j = gpd.sjoin(p, m, how="left", predicate="within")
        j = j[~j.index.duplicated()]
        # 2 a 3% caem em vão da malha, como as calçadas: mesmo remendo, o setor
        # mais próximo. Sem isso somem 23 mil árvores e postes do mapa.
        orfaos = j.NM_DIST.isna().values
        if orfaos.any():
            perto = gpd.sjoin_nearest(p[orfaos], m, how="left")
            j.loc[orfaos, "NM_DIST"] = perto[~perto.index.duplicated()].NM_DIST.values
        j["distrito"] = j.NM_DIST.map(slug, na_action="ignore")
        j = j[j.distrito.notna()]
        for chave, grupo in j.groupby("distrito"):
            if nome == "incidentes":
                guardados.setdefault(chave, {})[nome] = [
                    [round(x, 5), round(y, 5), o, q or "", si or ""]
                    for x, y, o, q, si in zip(grupo.geometry.x, grupo.geometry.y,
                                              grupo.oque.fillna("reclamação"),
                                              grupo.quando, grupo.situacao)]
            else:
                guardados.setdefault(chave, {})[nome] = [
                    [round(x, 5), round(y, 5)] for x, y in zip(grupo.geometry.x, grupo.geometry.y)]
    for chave, camadas_do_distrito in guardados.items():
        (SAIDA / "pontos" / f"{chave}.json").write_text(
            json.dumps({k: camadas_do_distrito.get(k, []) for k in camadas}))
    total = {k: sum(len(v.get(k, [])) for v in guardados.values()) for k in camadas}
    print(f"  pontos/: {len(guardados)} distritos · " +
          " · ".join(f"{k} {v:,}".replace(",", ".") for k, v in total.items()))


def calcadas(setores):
    """A calçada em si, nos 96 distritos — o assunto do mapa.

    Atributo e geometria chegam separados: largura, declividade e obstáculo dos
    491.383 trechos estão em `calcadas_municipio.parquet`; o polígono vem do WFS
    do GeoSampa por `baixar_calcadas.py`. A chave é `cd_identificador_calcada`.

    Escreve um GeoJSON por distrito e devolve (taxas por distrito, totais da cidade).
    """
    at = pd.read_parquet(FONTES / "calcadas_municipio.parquet", columns=[
        "cd_identificador_calcada", "nm_logradouro", "qt_largura_minima_trecho",
        "qt_largura_media_trecho", "qt_area_calcada",
        "pc_declividade_media_trecho", "n_obst", "tx_plano_emergencial_calcada"])
    geo = gpd.read_parquet(FONTES / "calcadas_geom.parquet").to_crs(CRS_MAPA)
    c = geo.merge(at, on="cd_identificador_calcada", how="inner")
    if len(c) != len(geo):
        raise SystemExit(f"merge perdeu calçada: {len(geo)} polígonos, {len(c)} com atributo")

    larg = c.qt_largura_minima_trecho
    # A árvore e o poste não somem da calçada: tomam a faixa de serviço da
    # largura útil. É por isso que `livre_min` pode ficar negativo.
    c["livre_min"] = np.where(c.n_obst > 0, larg - FAIXA_SERVICO_MIN_M, larg).round(2)
    c["declive"] = c.pc_declividade_media_trecho.round(2)
    c["obst"] = c.n_obst.astype(int)
    c["pec"] = c.tx_plano_emergencial_calcada.notna()
    c["rua"] = c.nm_logradouro.fillna("")
    c["id"] = c.cd_identificador_calcada.astype(int)
    c["estreita"] = c.livre_min < FAIXA_LIVRE_MIN_M
    c["ingreme"] = c.declive > DECLIVIDADE_MAX_PCT
    c["barreira"] = c.estreita | c.ingreme
    c["score"] = (100 * pontuar(c)).round().astype(int)

    # De que distrito é cada calçada. Não há chave: `cd_setor_quadra` é cadastro
    # fiscal de 9 dígitos e o setor censitário do IBGE tem 15. Só resta o espaço.
    # Contra os setores, não contra o distrito já dissolvido e simplificado.
    # `representative_point` em vez de centroide: cai sempre dentro do polígono.
    malha = setores[["NM_DIST", "NM_FCU", "geometry"]]
    centro = gpd.GeoDataFrame(geometry=c.geometry.representative_point(), crs=c.crs)
    junta = gpd.sjoin(centro, malha, how="left", predicate="within")
    junta = junta[~junta.index.duplicated()]
    c["distrito"] = junta.NM_DIST.map(slug, na_action="ignore").values
    # O recorte de favela e comunidade urbana só existe no setor censitário.
    c["em_favela"] = junta.NM_FCU.notna().values

    # ~2% caem em vão da malha: ela não é um mosaico perfeito e o cadastro de
    # calçada vai até a divisa. Descartar seria perder 9,6 mil calçadas por
    # detalhe de topologia — vão para o setor mais próximo.
    orfas = c.distrito.isna().values
    if orfas.any():
        perto = gpd.sjoin_nearest(centro[orfas], malha, how="left")
        perto = perto[~perto.index.duplicated()]
        c.loc[orfas, "distrito"] = perto.NM_DIST.map(slug, na_action="ignore").values
        c.loc[orfas, "em_favela"] = perto.NM_FCU.notna().values
        print(f"  {int(orfas.sum())} calçadas em vão da malha, ligadas ao setor mais próximo")

    pontos_por_distrito(malha)

    (SAIDA / "calcadas").mkdir(exist_ok=True)
    # `larg_min` sai: é `livre_min` mais a faixa de serviço quando há obstáculo,
    # e o navegador refaz a conta de graça. `id` sai porque ninguém o lê.
    campos = ["rua", "livre_min", "declive", "obst", "pec", "em_favela", "score",
              "comprimento", "geometry"]
    for nome, grupo in c.groupby("distrito"):
        gs = grupo[campos].copy()
        gs["geometry"] = gs.geometry.simplify(0.00002)
        gs.to_file(SAIDA / "calcadas" / f"{nome}.geojson", **GEOJSON)

    taxa = lambda s: round(100 * s.mean(), 1)
    por_distrito = c.groupby("distrito").agg(
        cal_n=("id", "size"),
        cal_estreita=("estreita", taxa),
        cal_ingreme=("ingreme", taxa),
        cal_obst=("obst", lambda s: round(100 * (s > 0).mean(), 1)),
        cal_pec=("pec", taxa),
        cal_barreira=("barreira", taxa),
        cal_score=("score", lambda x: round(x.mean(), 1)),
        cal_declive=("declive", lambda x: round(x.mean(), 2)),
        cal_comprimento=("comprimento", lambda x: round(x.mean(), 1)),
    )
    cidade = {
        "calcadas": int(len(c)),
        "estreita": taxa(c.estreita),
        "ingreme": taxa(c.ingreme),
        "obst": round(100 * (c.obst > 0).mean(), 1),
        "pec": taxa(c.pec),
        "barreira": taxa(c.barreira),
        "passa_tudo": taxa(~c.barreira & (c.obst == 0)),
        # o complemento exato de `barreira`: passa na largura E na inclinação
        "dentro_norma": taxa(~c.barreira),
        "comprimento": round(float(c.comprimento.mean()), 1),
        "livre_min_mediana": round(float(c.livre_min.median()), 2),
        "score": round(float(c.score.mean()), 1),
        "declive": round(float(c.declive.mean()), 2),
        "ruas": int(c.rua.replace("", np.nan).nunique()),
    }
    # Onde o app seria melhor recebido: densidade de quem empurra carrinho vezes
    # a fração de calçada que dá para usar. Densidade e não contagem — medido: com
    # contagem absoluta o ranking vira quase o ranking de população infantil, e a
    # calçada mal reordena. A área sai da soma dos setores, que ladrilham o
    # distrito, em vez de um dissolve novo.
    km2 = (setores.to_crs(CRS_METRICO).area.groupby(setores.NM_DIST).sum() / 1e6)
    km2.index = km2.index.map(slug)
    por_distrito["km2"] = km2.round(2)
    criancas = setores.groupby("NM_DIST").criancas_0a4.sum()
    criancas.index = criancas.index.map(slug)
    por_distrito["criancas_km2"] = (criancas / km2).round(0)
    por_distrito["cal_potencial"] = (por_distrito.criancas_km2
                                     * (1 - por_distrito.cal_barreira / 100)).round(0)
    return por_distrito, cidade


def main():
    setores = gpd.read_parquet(FONTES / "setores_sp.parquet").to_crs(CRS_MAPA)
    print(f"{len(setores):,} setores censitários".replace(",", "."))

    SAIDA.mkdir(exist_ok=True)

    # ---------------- município ----------------
    tot = setores[[c for c in setores.columns if c.startswith("V054")]].sum()
    F = tot["V05400"]
    municipio = {
        "faces": int(F),
        "setores": len(setores),
        "moradores": int(setores.moradores.sum()),
        "criancas_0a4": int(setores.criancas_0a4.sum()),
        "idosos_60": int(setores.idosos_60.sum()),
        "taxas": {k: round(100 * tot[b[0]] / F, 1) for k, b in BLOCOS.items()},
        "rotulos": {k: b[3] for k, b in BLOCOS.items()},
        "arborizacao": {r: round(100 * tot[c] / F, 1) for c, r in ARBORIZACAO.items()},
    }
    municipio["taxas"]["obstaculo"] = round(100 * tot["V05424"] / tot["V05421"], 1)
    municipio["taxas"]["rampa"] = round(100 * tot["V05427"] / tot["V05421"], 1)
    municipio["taxas"]["sem_rampa"] = round(100 * tot["V05428"] / tot["V05421"], 1)
    municipio["rampa_faces"] = round(100 * tot["V05427"] / F, 1)
    # subtrair das contagens, não das taxas já arredondadas: 94,9 - 15,2 daria
    # 79,7 quando o valor é 79,8. É o número principal do painel.
    municipio["vao"] = round(100 * (tot["V05406"] - tot["V05427"]) / F, 1)

    # ---------------- 96 distritos ----------------
    vs = [c for c in setores.columns if c.startswith("V054")]
    g = setores.groupby("NM_DIST")[vs].sum()
    g = g[g.V05400 > 0]
    dist = metricas(g).join(contagens(g))
    dist["criancas_0a4"] = setores.groupby("NM_DIST").criancas_0a4.sum().astype(int)
    dist["idosos_60"] = setores.groupby("NM_DIST").idosos_60.sum().astype(int)
    dist["moradores"] = setores.groupby("NM_DIST").moradores.sum().astype(int)

    geo_dist = setores.dissolve("NM_DIST")[["geometry"]]
    geo_dist["geometry"] = geo_dist.geometry.simplify(0.0001)
    geo_dist = geo_dist.join(dist, how="inner").reset_index()
    geo_dist["id"] = geo_dist.NM_DIST.map(slug)

    # ---------------- calçadas, um arquivo por distrito ----------------
    # Precisa dos distritos já dissolvidos para saber de quem é cada calçada,
    # e devolve as taxas que pintam o distrito e ordenam a tabela lateral.
    por_distrito, cidade = calcadas(setores)
    municipio["calcadas"] = cidade
    geo_dist = geo_dist.merge(por_distrito, left_on="id", right_index=True, how="left")
    geo_dist.to_file(SAIDA / "distritos.geojson", **GEOJSON)
    (SAIDA / "municipio.json").write_text(json.dumps(municipio, ensure_ascii=False, indent=1))

    # ---------------- favela × resto ----------------
    setores["em_favela"] = setores.NM_FCU.notna()
    gf = setores.groupby("em_favela")[vs].sum()
    recorte = metricas(gf).join(contagens(gf))
    recorte["moradores"] = setores.groupby("em_favela").moradores.sum().astype(int)
    recorte["criancas_0a4"] = setores.groupby("em_favela").criancas_0a4.sum().astype(int)
    recorte.index = ["fora", "em_favela"]
    (SAIDA / "favela.json").write_text(recorte.to_json(orient="index", force_ascii=False))

    print(f"municipio.json · distritos.geojson ({len(geo_dist)}) · favela.json")
    print(f"calcadas/ ({len(list((SAIDA / 'calcadas').glob('*.geojson')))} distritos, "
          f"{cidade['calcadas']:,} calçadas): {cidade['barreira']}% são barreira, "
          f"score médio {cidade['score']}".replace(",", "."))


if __name__ == "__main__":
    main()
