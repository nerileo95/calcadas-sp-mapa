"""Confere cada número publicado contra a fonte.

    python verificar.py

Um mapa bonito com taxa mal calculada é pior que mapa nenhum. Este script
recalcula tudo do parquet e compara com o que está em `dados/`, e confere as
âncoras que já foram apresentadas à banca no trabalho integrador.
"""
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

FONTES, SAIDA = Path("fontes"), Path("dados")
TOL = 0.05          # pontos percentuais
falhas = []


def confere(rotulo, obtido, esperado, tol=TOL):
    ok = abs(obtido - esperado) <= tol
    print(f"  {'ok  ' if ok else 'FALHA'} {rotulo:52s} {obtido:9.2f}  esperado {esperado:9.2f}")
    if not ok:
        falhas.append(rotulo)


def main():
    setores = gpd.read_parquet(FONTES / "setores_sp.parquet")
    V = [c for c in setores.columns if c.startswith("V054")]
    t = setores[V].sum()
    F, COM = t["V05400"], t["V05421"]

    print("\n1. Totais do município contra o parquet")
    m = json.loads((SAIDA / "municipio.json").read_text())
    confere("faces", m["faces"], F, 0)
    confere("moradores", m["moradores"], setores.moradores.sum(), 0)
    confere("crianças 0 a 4", m["criancas_0a4"], setores.criancas_0a4.sum(), 0)
    for k, cod in [("pavimentada", "V05406"), ("iluminacao", "V05412"),
                   ("calcada", "V05421"), ("bueiro", "V05409"),
                   ("onibus", "V05415"), ("ciclovia", "V05418")]:
        confere(f"% {k}", m["taxas"][k], 100 * t[cod] / F)
    confere("% obstáculo (das que têm calçada)", m["taxas"]["obstaculo"], 100 * t["V05424"] / COM)
    confere("% rampa (das que têm calçada)", m["taxas"]["rampa"], 100 * t["V05427"] / COM)
    confere("% rampa (de todas as faces)", m["rampa_faces"], 100 * t["V05427"] / F)
    confere("o vão", m["vao"], 100 * t["V05406"] / F - 100 * t["V05427"] / F)

    print("\n2. Âncoras do trabalho integrador (já apresentadas à banca)")
    confere("287.699 faces de quadra", F, 287699, 0)
    confere("94,9% via pavimentada", 100 * t["V05406"] / F, 94.9, 0.05)
    confere("93,7% iluminação pública", 100 * t["V05412"] / F, 93.7, 0.05)
    confere("17,8% das faces sem calçada", 100 * t["V05422"] / F, 17.8, 0.05)
    confere("72,7% com obstáculo (das com calçada)", 100 * t["V05424"] / COM, 72.7, 0.05)
    confere("18,6% com rampa (das com calçada)", 100 * t["V05427"] / COM, 18.6, 0.05)
    confere("588.582 crianças de 0 a 4 anos", setores.criancas_0a4.sum(), 588582, 0)

    print("\n3. Os 96 distritos")
    d = gpd.read_file(SAIDA / "distritos.geojson")
    confere("quantidade de distritos", len(d), setores.NM_DIST.nunique(), 0)
    confere("soma das faces dos distritos = município", d.faces.sum(), F, 0)
    confere("soma das crianças dos distritos = município", d.criancas_0a4.sum(),
            setores.criancas_0a4.sum(), 0)

    g = setores.groupby("NM_DIST")[V].sum()
    esperado = pd.DataFrame({
        "pavimentada": 100 * g.V05406 / g.V05400,
        "iluminacao": 100 * g.V05412 / g.V05400,
        "sem_calcada": 100 * g.V05422 / g.V05400,
        "sem_arvore": 100 * g.V05430 / g.V05400,
        "obstaculo": np.where(g.V05421 > 0, 100 * g.V05424 / g.V05421, np.nan),
        "rampa": np.where(g.V05421 > 0, 100 * g.V05427 / g.V05421, np.nan),
    }, index=g.index)
    pior = {}
    for col in esperado.columns:
        dif = (d.set_index("NM_DIST")[col] - esperado[col]).abs()
        pior[col] = dif.max()
    for col, v in pior.items():
        confere(f"maior divergência entre 96 distritos — {col}", v, 0.0)

    print("\n4. Os arquivos de setor por distrito")
    arquivos = sorted((SAIDA / "setores").glob("*.geojson"))
    confere("um arquivo por distrito", len(arquivos), setores.NM_DIST.nunique(), 0)
    total_setores = sum(len(gpd.read_file(a)) for a in arquivos)
    confere("soma dos setores dos arquivos", total_setores, len(setores), 0)

    print("\n5. Recorte favela × resto")
    fav = json.loads((SAIDA / "favela.json").read_text())
    em = setores[setores.NM_FCU.notna()][V].sum()
    fora = setores[setores.NM_FCU.isna()][V].sum()
    confere("sem calçada, em favela", fav["em_favela"]["sem_calcada"], 100 * em.V05422 / em.V05400)
    confere("sem calçada, fora", fav["fora"]["sem_calcada"], 100 * fora.V05422 / fora.V05400)
    confere("rampa, em favela", fav["em_favela"]["rampa"], 100 * em.V05427 / em.V05421)
    confere("rampa, fora", fav["fora"]["rampa"], 100 * fora.V05427 / fora.V05421)

    print("\n6. O piloto de Pinheiros")
    p = gpd.read_parquet(FONTES / "piloto_calcadas.parquet")
    pg = gpd.read_file(SAIDA / "piloto_calcadas.geojson")
    confere("calçadas no piloto", len(pg), len(p), 0)
    confere("26,3% abaixo de 1,20 m de faixa livre", 100 * (p.livre_min < 1.20).mean(), 26.3, 0.05)
    confere("51,8% com ao menos uma árvore", 100 * (p.arvores > 0).mean(), 51.8, 0.05)

    print()
    if falhas:
        print(f"{len(falhas)} FALHA(S): " + " · ".join(falhas))
        raise SystemExit(1)
    print("todos os números conferem")


if __name__ == "__main__":
    main()
