"""Prepara os dados do mapa a partir das fontes do IBGE e do GeoSampa.

    python preparar_dados.py

Lê `fontes/` e escreve `dados/`. Roda em ~1 min. Nada aqui depende de rede:
as fontes vêm no repositório, agregadas por setor censitário, sem identificação
individual. Como foram obtidas está no README.

O mapa tem três resoluções, e este script produz as três:
  cidade    96 distritos          IBGE, Censo 2022, por face de quadra
  distrito  os setores de cada um mesma base, 26.605 setores
  piloto    a calçada em si       GeoSampa, só Pinheiros/Vila Madalena
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
            "V05409", "V05415", "V05418", "V05430", "V05433"]
    return g[cols].astype(int)


def main():
    setores = gpd.read_parquet(FONTES / "setores_sp.parquet").to_crs(CRS_MAPA)
    print(f"{len(setores):,} setores censitários".replace(",", "."))

    SAIDA.mkdir(exist_ok=True)
    (SAIDA / "setores").mkdir(exist_ok=True)

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
    municipio["rampa_faces"] = round(100 * tot["V05427"] / F, 1)
    # subtrair das contagens, não das taxas já arredondadas: 94,9 - 15,2 daria
    # 79,7 quando o valor é 79,8. É o número principal do painel.
    municipio["vao"] = round(100 * (tot["V05406"] - tot["V05427"]) / F, 1)
    (SAIDA / "municipio.json").write_text(json.dumps(municipio, ensure_ascii=False, indent=1))

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
    geo_dist.to_file(SAIDA / "distritos.geojson", **GEOJSON)

    # ---------------- setores, um arquivo por distrito ----------------
    # Carregar 26.605 polígonos de uma vez seria 9 MB e travaria o navegador.
    # Quebrado por distrito, cada arquivo tem ~100 KB e só entra quando pedido.
    ms = metricas(setores.set_index("CD_SETOR")[vs]).join(
        contagens(setores.set_index("CD_SETOR")[vs]))
    ms["criancas_0a4"] = setores.set_index("CD_SETOR").criancas_0a4.astype(int)
    ms["em_favela"] = setores.set_index("CD_SETOR").NM_FCU.notna()

    for nome, grupo in setores.groupby("NM_DIST"):
        gs = grupo.set_index("CD_SETOR")[["geometry"]].copy()
        gs["geometry"] = gs.geometry.simplify(0.00003)
        gs = gs.join(ms, how="left").reset_index()
        gs.to_file(SAIDA / "setores" / f"{slug(nome)}.geojson", **GEOJSON)

    # ---------------- favela × resto ----------------
    setores["em_favela"] = setores.NM_FCU.notna()
    gf = setores.groupby("em_favela")[vs].sum()
    recorte = metricas(gf).join(contagens(gf))
    recorte["moradores"] = setores.groupby("em_favela").moradores.sum().astype(int)
    recorte["criancas_0a4"] = setores.groupby("em_favela").criancas_0a4.sum().astype(int)
    recorte.index = ["fora", "em_favela"]
    (SAIDA / "favela.json").write_text(recorte.to_json(orient="index", force_ascii=False))

    print(f"municipio.json · distritos.geojson ({len(geo_dist)}) · "
          f"setores/ ({len(list((SAIDA / 'setores').glob('*.geojson')))}) · favela.json")

    # ---------------- piloto: a calçada de verdade ----------------
    piloto = gpd.read_parquet(FONTES / "piloto_calcadas.parquet").to_crs(CRS_MAPA)
    piloto["geometry"] = piloto.geometry.simplify(0.00002)
    piloto.to_file(SAIDA / "piloto_calcadas.geojson", **GEOJSON)
    for camada in ("arvores", "postes"):
        p = gpd.read_parquet(FONTES / f"piloto_{camada}.parquet").to_crs(CRS_MAPA)
        pontos = [[round(x, 5), round(y, 5)] for x, y in zip(p.geometry.x, p.geometry.y)]
        (SAIDA / f"piloto_{camada}.json").write_text(json.dumps(pontos))
        print(f"piloto_{camada}.json: {len(pontos)} pontos")
    print(f"piloto_calcadas.geojson: {len(piloto)} calçadas")


if __name__ == "__main__":
    main()
