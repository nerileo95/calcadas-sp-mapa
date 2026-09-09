"""Baixa a geometria das 491.383 calçadas do município no WFS do GeoSampa.

Os atributos (largura, declividade, obstáculo) já estão em fontes/calcadas_municipio.parquet.
Aqui só falta o polígono. O WFS cai com frequência, então cada página vira um arquivo e uma
segunda execução pula o que já está em disco.

    systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 python3 baixar_calcadas.py
"""

import io
import sys
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests

WFS = "https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows"
CAMADA = "geoportal:calcada"
TOTAL = 491383          # numberMatched conferido no resultType=hits
PAGINA = 2000           # ~1,6 MB e ~1 s por página
PAGINAS = Path("fontes/wfs")
SAIDA = Path("fontes/calcadas_geom.parquet")


def baixar_pagina(inicio, tentativas=4):
    params = {
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": CAMADA, "outputFormat": "application/json",
        "srsName": "EPSG:4326", "propertyName": "cd_identificador_calcada,ge_poligono",
        "count": PAGINA, "startIndex": inicio,
    }
    for tentativa in range(tentativas):
        try:
            r = requests.get(WFS, params=params, timeout=120)
            r.raise_for_status()
            g = gpd.read_file(io.BytesIO(r.content))
            if len(g) == 0:
                raise RuntimeError("página vazia")
            return g[["cd_identificador_calcada", "geometry"]]
        except Exception as exc:
            if tentativa == tentativas - 1:
                raise
            espera = 5 * (tentativa + 1)
            print(f"  startIndex={inicio}: {exc} — nova tentativa em {espera}s")
            time.sleep(espera)


def main():
    PAGINAS.mkdir(parents=True, exist_ok=True)
    inicios = range(0, TOTAL, PAGINA)
    t0 = time.time()

    for n, inicio in enumerate(inicios, 1):
        destino = PAGINAS / f"pg_{inicio:06d}.parquet"
        if destino.exists():
            continue
        baixar_pagina(inicio).to_parquet(destino)
        if n % 20 == 0 or n == len(inicios):
            print(f"  {n}/{len(inicios)} páginas · {time.time() - t0:.0f}s", flush=True)

    print("juntando as páginas…")
    g = pd.concat([gpd.read_parquet(p) for p in sorted(PAGINAS.glob("pg_*.parquet"))],
                  ignore_index=True)
    g = gpd.GeoDataFrame(g, geometry="geometry", crs="EPSG:4326")
    g = g.drop_duplicates("cd_identificador_calcada").sort_values("cd_identificador_calcada")

    # A chave é sequencial densa (1…491383): se faltar alguma, o merge com os atributos
    # sai silenciosamente menor e o dash perde calçada sem avisar.
    ids = set(g.cd_identificador_calcada)
    faltando = set(range(1, TOTAL + 1)) - ids
    if faltando:
        sys.exit(f"faltaram {len(faltando)} calçadas, ex.: {sorted(faltando)[:5]}")
    if len(g) != TOTAL:
        sys.exit(f"esperava {TOTAL} calçadas, vieram {len(g)}")

    g.to_parquet(SAIDA)
    print(f"{SAIDA}: {len(g)} calçadas · {SAIDA.stat().st_size / 1e6:.0f} MB "
          f"· {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
