"""Baixa as camadas do WFS do GeoSampa que o mapa usa.

    python baixar_geosampa.py            # todas
    python baixar_geosampa.py arvores    # só uma

Sempre sob teto de memória, que é o que impede um download grande de derrubar
a sessão gráfica:

    systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 \\
        python3 baixar_geosampa.py

O serviço cai com frequência, então cada página vira um arquivo e uma segunda
execução pula o que já está em disco. Só a geometria é pedida: o resto do
cadastro não é usado e multiplicaria o download por cinco. O nome do campo de
identificação muda de camada para camada, e pedir o errado devolve HTTP 400 —
mais um motivo para não pedir.
"""

import io
import sys
import time
from pathlib import Path

import geopandas as gpd
import pandas as pd
import requests

WFS = "https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows"
PAGINA = 2000
FONTES = Path("fontes")

# nome curto -> (camada no WFS, campo de geometria, arquivo de saída)
CAMADAS = {
    "calcadas": ("geoportal:calcada", "ge_poligono", "calcadas_geom.parquet"),
    "arvores":  ("geoportal:arvore", "ge_ponto", "geo_arvores.parquet"),
    "postes":   ("geoportal:iluminacao_publica", "ge_ponto", "geo_postes.parquet"),
    # Reclamações com endereço. São o "incidente reportado" do score.
    "buraco":       ("geoportal:sac_tapa_buraco", "ge_ponto", "geo_sac_buraco.parquet"),
    "mato":         ("geoportal:sac_capinacao_guia_sarjeta", "ge_ponto", "geo_sac_mato.parquet"),
    "arvore_risco": ("geoportal:risco_ocorrencia_queda_arvore", "ge_ponto", "geo_sac_arvore_risco.parquet"),
    "arvore_urg":   ("geoportal:sac_quadra_arvore_urgencia", "ge_ponto", "geo_sac_arvore_urg.parquet"),
}


def quantas(camada):
    r = requests.get(WFS, params={"service": "WFS", "version": "2.0.0",
                                  "request": "GetFeature", "typeNames": camada,
                                  "resultType": "hits"}, timeout=60)
    r.raise_for_status()
    return int(r.text.split('numberMatched="')[1].split('"')[0])


def pagina(camada, geom, inicio, tentativas=4):
    params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": camada, "outputFormat": "application/json",
              "srsName": "EPSG:4326", "propertyName": geom,
              "count": PAGINA, "startIndex": inicio}
    for tentativa in range(tentativas):
        try:
            r = requests.get(WFS, params=params, timeout=120)
            r.raise_for_status()
            g = gpd.read_file(io.BytesIO(r.content))
            if len(g) == 0:
                raise RuntimeError("página vazia")
            return g[["geometry"]]
        except Exception as exc:
            if tentativa == tentativas - 1:
                raise
            espera = 5 * (tentativa + 1)
            print(f"    startIndex={inicio}: {exc} — nova tentativa em {espera}s", flush=True)
            time.sleep(espera)


def baixar(nome):
    camada, geom, saida = CAMADAS[nome]
    destino, paginas = FONTES / saida, FONTES / "wfs" / nome
    if destino.exists():
        print(f"{nome}: já está em {destino}")
        return
    paginas.mkdir(parents=True, exist_ok=True)
    total = quantas(camada)
    inicios = list(range(0, total, PAGINA))
    print(f"{nome}: {total:,} feições em {len(inicios)} páginas".replace(",", "."), flush=True)

    t0 = time.time()
    for n, inicio in enumerate(inicios, 1):
        arq = paginas / f"pg_{inicio:07d}.parquet"
        if arq.exists():
            continue
        pagina(camada, geom, inicio).to_parquet(arq)
        if n % 50 == 0:
            print(f"  {n}/{len(inicios)} · {time.time() - t0:.0f}s", flush=True)

    g = pd.concat([gpd.read_parquet(p) for p in sorted(paginas.glob("pg_*.parquet"))],
                  ignore_index=True)
    g = gpd.GeoDataFrame(g, geometry="geometry", crs="EPSG:4326")
    # O WFS às vezes devolve a última página repetida quando o serviço oscila;
    # sem esta conferência o excesso passa direto para as contagens do mapa.
    if len(g) != total:
        sys.exit(f"{nome}: esperava {total} feições, juntou {len(g)}")
    g.to_parquet(destino)
    print(f"{nome}: {len(g):,} → {destino} ({destino.stat().st_size / 1e6:.0f} MB, "
          f"{time.time() - t0:.0f}s)".replace(",", "."), flush=True)


if __name__ == "__main__":
    pedidas = sys.argv[1:] or list(CAMADAS)
    for nome in pedidas:
        if nome not in CAMADAS:
            sys.exit(f"camada desconhecida: {nome}. Conhecidas: {', '.join(CAMADAS)}")
    for nome in pedidas:
        baixar(nome)
