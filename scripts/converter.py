#!/usr/bin/env python3
"""
Converte as planilhas de endereços selecionados + CNEFE completo (PNS 2026,
Campos dos Goytacazes e região) em app/dados.js, usado pelo app de campo offline.

Uso:
    python3 scripts/converter.py

Lê por padrão "dados-fonte/selecionado e completo.xlsx" (sheets "selecionados"
e "completo"). Gera app/dados.js e relatorio-conversao.txt na raiz do projeto.

Reexecutável: rode de novo sempre que as planilhas mudarem.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import openpyxl

try:
    import shapefile  # pyshp
except ImportError:
    shapefile = None

REPO_ROOT = Path(__file__).resolve().parent.parent
DADOS_FONTE = REPO_ROOT / "dados-fonte"
COMBINADO_XLSX = DADOS_FONTE / "selecionado e completo.xlsx"
SELECIONADOS_XLSX = DADOS_FONTE / "selecionados.xlsx"
COMPLETO_XLSX = DADOS_FONTE / "completo.xlsx"
MALHA_SHP = DADOS_FONTE / "RJ_setores_CD2022" / "RJ_setores_CD2022.shp"
OUT_DADOS_JS = REPO_ROOT / "app" / "dados.js"
OUT_RELATORIO = REPO_ROOT / "relatorio-conversao.txt"
# Nome/telefone NÃO entram em app/dados.js (que pode ser publicado publicamente).
# Ficam neste arquivo à parte, para distribuir só à equipe por um canal privado
# (WhatsApp, Drive com link restrito etc.) e importar pelo menu do app.
OUT_DADOS_PESSOAIS = DADOS_FONTE / "dados-pessoais.json"

# Caixa aproximada da região de estudo (Campos dos Goytacazes e municípios
# vizinhos amostrados). Ver seção 4.2 da especificação.
LAT_MIN, LAT_MAX = -22.3, -21.2
LNG_MIN, LNG_MAX = -41.9, -40.8

# Tolerância de simplificação dos polígonos (graus) — só para reduzir tamanho.
SIMPLIFY_TOLERANCIA = 0.00005
# "Buffer" aproximado (graus) aplicado ao contorno de fallback por hull de pontos.
BUFFER_FALLBACK_DEG = 30 / 111_320  # ~30 m

ENTREVISTADORES_SEED = [
    {"nome": "Maurício", "letra": "M"},
    {"nome": "Ricardo", "letra": "R"},
    {"nome": "Maria Letícia", "letra": "ML"},
    {"nome": "Lorena", "letra": "L"},
]

HEADER_MARCADOR = "Controle"
TITULO_MARCADOR = "Lista de Enderecos"

CAMPOS_ESPERADOS = [
    "Controle", "ID_CNEFE", "N.º Domicilio", "Quadra", "Face", "Logradouro",
    "Número", "Complemento", "Bairro", "Latitude", "Longitude", "Telefone",
    "Morador", "Situação", "Selecionado", "Antropometria", "Biomarcadores",
    "ID Zona", "Nome ZONA",
]

DMS_RE = re.compile(
    r"^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s*([NSEWOnsewo]?)\s*$"
)


class Relatorio:
    def __init__(self):
        self.linhas: list[str] = []
        self.avisos: list[str] = []

    def info(self, msg: str) -> None:
        self.linhas.append(msg)

    def aviso(self, msg: str) -> None:
        self.avisos.append(msg)

    def escrever(self, path: Path) -> None:
        with path.open("w", encoding="utf-8") as f:
            f.write("Relatório de conversão — PNS 2026\n")
            f.write("=" * 40 + "\n\n")
            f.write("\n".join(self.linhas))
            f.write("\n\n")
            if self.avisos:
                f.write(f"Avisos / registros a revisar ({len(self.avisos)}):\n")
                f.write("-" * 40 + "\n")
                f.write("\n".join(self.avisos))
                f.write("\n")
            else:
                f.write("Nenhum aviso — nenhum registro fora da caixa, sem "
                        "coordenada ou com formato inesperado.\n")


def norm(v):
    """Normaliza célula: trim strings, trata '-' como vazio."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        if v == "" or v == "-":
            return None
        return v
    return v


def as_text(v):
    """Converte para texto preservando inteiros grandes sem notação científica."""
    v = norm(v)
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, int):
        return str(v)
    return str(v).strip()


def as_int(v):
    v = norm(v)
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def as_bool_sim(v):
    v = norm(v)
    return isinstance(v, str) and v.strip().lower() == "sim"


def parse_dms(valor, relatorio: Relatorio, contexto: str):
    """Converte 'GG MM SS.sss H' (H em N/S/E/W/O) para grau decimal com sinal."""
    v = norm(valor)
    if v is None:
        relatorio.aviso(f"{contexto}: coordenada ausente")
        return None
    texto = str(v).strip()
    m = DMS_RE.match(texto)
    if not m:
        relatorio.aviso(f"{contexto}: formato de coordenada inesperado: {texto!r}")
        return None
    g, mi, se, hemi = m.groups()
    try:
        graus = float(g) + float(mi) / 60 + float(se.replace(",", ".")) / 3600
    except ValueError:
        relatorio.aviso(f"{contexto}: coordenada não numérica: {texto!r}")
        return None
    hemi = hemi.upper()
    if hemi in ("S", "O", "W"):
        graus = -graus
    elif hemi not in ("N", "E", ""):
        relatorio.aviso(f"{contexto}: hemisfério desconhecido em {texto!r}")
    return graus


def parse_telefone(valor, relatorio: Relatorio, contexto: str):
    v = norm(valor)
    if v is None:
        return None
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v.is_integer():
            return str(int(v))
        relatorio.aviso(f"{contexto}: telefone com valor fracionário suspeito "
                         f"(possível notação científica corrompida): {v!r} — descartado")
        return None
    texto = str(v).strip()
    if re.search(r"[eE]\+?\d", texto) or "," in texto and "E" in texto.upper():
        relatorio.aviso(f"{contexto}: telefone em notação científica: {texto!r} — descartado")
        return None
    digitos = re.sub(r"\D", "", texto)
    return digitos or None


def ler_planilha(path: Path, aba: str, relatorio: Relatorio):
    """Lê uma aba, pulando linhas-título, vazias e cabeçalhos repetidos."""
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[aba]
    header = None
    linhas = []
    n_titulos = n_headers_repetidos = n_vazias = 0
    for raw in ws.iter_rows(values_only=True):
        primeira = raw[0]
        if all(c is None for c in raw):
            n_vazias += 1
            continue
        if isinstance(primeira, str) and TITULO_MARCADOR in primeira:
            n_titulos += 1
            continue
        if isinstance(primeira, str) and primeira.strip() == HEADER_MARCADOR:
            if header is not None:
                n_headers_repetidos += 1
            header = [h.strip() if isinstance(h, str) else h for h in raw]
            continue
        if header is None:
            relatorio.aviso(f"{path.name}/{aba}: linha antes do cabeçalho ignorada: {raw!r}")
            continue
        linhas.append(dict(zip(header, raw)))
    wb.close()
    relatorio.info(f"{path.name}/{aba}: {len(linhas)} linhas de dados "
                    f"({n_titulos} linhas-título, {n_headers_repetidos} cabeçalhos "
                    f"repetidos, {n_vazias} linhas vazias ignoradas)")
    return linhas


def montar_domicilio(row, relatorio: Relatorio):
    setor = as_text(row.get("Controle"))
    id_cnefe = as_text(row.get("ID_CNEFE"))
    contexto = f"domicílio setor={setor} id={id_cnefe}"
    lat = parse_dms(row.get("Latitude"), relatorio, contexto)
    lng = parse_dms(row.get("Longitude"), relatorio, contexto)
    if lat is not None and lng is not None:
        if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
            relatorio.aviso(f"{contexto}: coordenada fora da caixa da região "
                             f"(lat={lat}, lng={lng})")
    return {
        "id": id_cnefe,
        "setor": setor,
        "numDomicilio": as_int(row.get("N.º Domicilio")),
        "quadra": as_int(row.get("Quadra")),
        "face": as_int(row.get("Face")),
        "logradouro": as_text(row.get("Logradouro")),
        "numero": as_text(row.get("Número")),
        "complemento": as_text(row.get("Complemento")),
        "bairro": as_text(row.get("Bairro")),
        "lat": lat,
        "lng": lng,
        "telefone": parse_telefone(row.get("Telefone"), relatorio, contexto),
        "morador": as_text(row.get("Morador")),
        "situacao": as_text(row.get("Situação")),
        "antropometria": as_bool_sim(row.get("Antropometria")),
        "biomarcador": as_bool_sim(row.get("Biomarcadores")),
        "idZona": as_text(row.get("ID Zona")),
        "zona": as_text(row.get("Nome ZONA")),
    }


def montar_roteiro_item(row, ordem, relatorio: Relatorio):
    setor = as_text(row.get("Controle"))
    id_cnefe = as_text(row.get("ID_CNEFE"))
    lat = parse_dms(row.get("Latitude"), relatorio, f"roteiro setor={setor} id={id_cnefe}")
    lng = parse_dms(row.get("Longitude"), relatorio, f"roteiro setor={setor} id={id_cnefe}")
    return {
        "id": id_cnefe,
        "setor": setor,
        "quadra": as_int(row.get("Quadra")),
        "face": as_int(row.get("Face")),
        "logradouro": as_text(row.get("Logradouro")),
        "numero": as_text(row.get("Número")),
        "complemento": as_text(row.get("Complemento")),
        "morador": as_text(row.get("Morador")),
        "telefone": parse_telefone(row.get("Telefone"), relatorio, f"roteiro setor={setor} id={id_cnefe}"),
        "numDomicilio": as_int(row.get("N.º Domicilio")),
        "lat": lat,
        "lng": lng,
        "alvo": False,
        "_ordem": ordem,
    }


# --------------------------------------------------------------------------
# Geometria (sem dependências pesadas: implementação própria de hull, área e
# simplificação de Douglas-Peucker, suficiente para exibição no mapa).
# --------------------------------------------------------------------------

def area_poligono(pontos):
    a = 0.0
    n = len(pontos)
    for i in range(n):
        x1, y1 = pontos[i]
        x2, y2 = pontos[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def rdp(pontos, tolerancia):
    if len(pontos) < 3:
        return pontos
    x1, y1 = pontos[0]
    x2, y2 = pontos[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = math.hypot(dx, dy)
    idx_max, dist_max = 0, 0.0
    for i in range(1, len(pontos) - 1):
        px, py = pontos[i]
        if norm == 0:
            dist = math.hypot(px - x1, py - y1)
        else:
            dist = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm
        if dist > dist_max:
            idx_max, dist_max = i, dist
    if dist_max > tolerancia:
        esquerda = rdp(pontos[:idx_max + 1], tolerancia)
        direita = rdp(pontos[idx_max:], tolerancia)
        return esquerda[:-1] + direita
    return [pontos[0], pontos[-1]]


def convex_hull(pontos):
    pts = sorted(set(pontos))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def hull_com_buffer(pontos_lonlat):
    hull = convex_hull(pontos_lonlat)
    if len(hull) < 3:
        # Menos de 3 pontos distintos: gera um pequeno quadrado ao redor.
        if not pontos_lonlat:
            return []
        lon0, lat0 = pontos_lonlat[0]
        d = BUFFER_FALLBACK_DEG * 3
        return [(lon0 - d, lat0 - d), (lon0 + d, lat0 - d),
                (lon0 + d, lat0 + d), (lon0 - d, lat0 + d)]
    cx = sum(p[0] for p in hull) / len(hull)
    cy = sum(p[1] for p in hull) / len(hull)
    buffered = []
    for x, y in hull:
        dx, dy = x - cx, y - cy
        dist = math.hypot(dx, dy)
        if dist == 0:
            buffered.append((x, y))
            continue
        fator = (dist + BUFFER_FALLBACK_DEG) / dist
        buffered.append((cx + dx * fator, cy + dy * fator))
    return buffered


def carregar_malha_ibge(setores_alvo: set, relatorio: Relatorio):
    """Retorna (aneis_por_setor, municipio_por_setor) a partir da malha do IBGE.

    aneis_por_setor: setor -> lista de anéis [(lon,lat), ...]
    municipio_por_setor: setor -> nome do município (NM_MUN da malha), usado nas etiquetas.
    """
    encontrados = {}
    municipios = {}
    if shapefile is None:
        relatorio.aviso("Biblioteca pyshp não disponível — pulando malha oficial do IBGE, "
                         "todos os setores usarão contorno aproximado (hull).")
        return encontrados, municipios
    if not MALHA_SHP.exists():
        relatorio.aviso(f"Malha do IBGE não encontrada em {MALHA_SHP} — todos os setores "
                         f"usarão contorno aproximado (hull).")
        return encontrados, municipios
    sf = shapefile.Reader(str(MALHA_SHP))
    campos = [f[0] for f in sf.fields[1:]]
    idx_setor = campos.index("CD_SETOR")
    idx_mun = campos.index("NM_MUN")
    for sr in sf.iterShapeRecords():
        codigo = sr.record[idx_setor]
        if codigo not in setores_alvo:
            continue
        municipios[codigo] = sr.record[idx_mun]
        shape = sr.shape
        pontos = shape.points
        partes = list(shape.parts) + [len(pontos)]
        aneis = [pontos[partes[i]:partes[i + 1]] for i in range(len(partes) - 1)]
        aneis_simplificados = [rdp(anel, SIMPLIFY_TOLERANCIA) for anel in aneis]
        encontrados[codigo] = aneis_simplificados
    return encontrados, municipios


def anel_para_geojson(anel):
    coords = [[round(x, 7), round(y, 7)] for x, y in anel]
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def main():
    relatorio = Relatorio()

    if COMBINADO_XLSX.exists():
        rows_sel = ler_planilha(COMBINADO_XLSX, "selecionados", relatorio)
        rows_comp = ler_planilha(COMBINADO_XLSX, "completo", relatorio)
    else:
        rows_sel = ler_planilha(SELECIONADOS_XLSX, "selecionados", relatorio)
        rows_comp = ler_planilha(COMPLETO_XLSX, "completo", relatorio)

    domicilios = []
    for row in rows_sel:
        if not as_bool_sim(row.get("Selecionado")):
            continue
        domicilios.append(montar_domicilio(row, relatorio))

    ids_alvo = {d["id"] for d in domicilios if d["id"]}
    relatorio.info(f"Domicílios selecionados (Selecionado=Sim): {len(domicilios)}")

    roteiro_por_setor: dict[str, list] = {}
    zonas_por_setor: dict[str, str] = {}
    for ordem, row in enumerate(rows_comp):
        item = montar_roteiro_item(row, ordem, relatorio)
        item["alvo"] = item["id"] in ids_alvo
        roteiro_por_setor.setdefault(item["setor"], []).append(item)
        nome_zona = as_text(row.get("Nome ZONA"))
        if nome_zona and item["setor"] not in zonas_por_setor:
            zonas_por_setor[item["setor"]] = nome_zona

    # Captura nome/telefone à parte ANTES de tirar do roteiro (ver OUT_DADOS_PESSOAIS acima).
    dados_pessoais = {}
    for itens in roteiro_por_setor.values():
        for it in itens:
            if it["morador"] or it["telefone"]:
                dados_pessoais[it["id"]] = {"morador": it["morador"], "telefone": it["telefone"]}

    for setor, itens in roteiro_por_setor.items():
        itens.sort(key=lambda it: (it["quadra"] or 0, it["face"] or 0, it["_ordem"]))
        for it in itens:
            del it["_ordem"]
            del it["setor"]
            del it["morador"]
            del it["telefone"]

    relatorio.info(f"Setores no roteiro (CNEFE completo): {len(roteiro_por_setor)}")
    total_roteiro = sum(len(v) for v in roteiro_por_setor.values())
    relatorio.info(f"Endereços no roteiro (CNEFE completo): {total_roteiro}")

    setores_codigos = set(roteiro_por_setor.keys()) | {d["setor"] for d in domicilios}
    malha, municipio_por_setor = carregar_malha_ibge(setores_codigos, relatorio)

    setores = []
    n_oficial = n_aproximado = 0
    for codigo in sorted(setores_codigos):
        aneis = malha.get(codigo)
        aproximado = aneis is None
        if aproximado:
            pontos = [(it["lng"], it["lat"]) for it in roteiro_por_setor.get(codigo, [])
                      if it["lat"] is not None and it["lng"] is not None]
            aneis = [hull_com_buffer(pontos)] if pontos else []
            if not aneis or len(aneis[0]) < 3:
                relatorio.aviso(f"Setor {codigo}: sem pontos suficientes para gerar contorno "
                                 f"aproximado")
            n_aproximado += 1
        else:
            n_oficial += 1
        geojson = {
            "type": "Polygon",
            "coordinates": [anel_para_geojson(anel) for anel in aneis if len(anel) >= 3],
        }
        setores.append({
            "controle": codigo,
            "nomeZona": zonas_por_setor.get(codigo),
            "municipio": municipio_por_setor.get(codigo),
            "aproximado": aproximado,
            "geojson": geojson,
        })

    relatorio.info(f"Setores com malha oficial do IBGE: {n_oficial}")
    relatorio.info(f"Setores com contorno aproximado (hull de pontos): {n_aproximado}")

    roteiro_export = {setor: [
        {k: v for k, v in it.items() if k not in ("lat", "lng")}
        for it in itens
    ] for setor, itens in roteiro_por_setor.items()}

    # domicilios (planilha "selecionados") é autoridade sobre seu próprio nome/telefone —
    # sobrescreve o que veio do roteiro/completo, e cobre o caso de o id não aparecer lá.
    for d in domicilios:
        if d["morador"] or d["telefone"]:
            dados_pessoais[d["id"]] = {"morador": d["morador"], "telefone": d["telefone"]}

    domicilios_export = [
        {**d, "municipio": municipio_por_setor.get(d["setor"]), "morador": None, "telefone": None}
        for d in domicilios
    ]

    dados = {
        "geradoEm": __import__("datetime").datetime.now().astimezone().isoformat(),
        "entrevistadores": ENTREVISTADORES_SEED,
        "setores": setores,
        "domicilios": domicilios_export,
        "roteiro": roteiro_export,
    }

    OUT_DADOS_JS.parent.mkdir(parents=True, exist_ok=True)
    with OUT_DADOS_JS.open("w", encoding="utf-8") as f:
        f.write("// Gerado por scripts/converter.py — não editar à mão.\n")
        f.write("// SEM dados pessoais (nome/telefone) — este arquivo pode ser publicado\n")
        f.write("// publicamente. Ver dados-fonte/dados-pessoais.json e seção 5 do README.\n")
        f.write("const DADOS = ")
        json.dump(dados, f, ensure_ascii=False, indent=1)
        f.write(";\n")

    OUT_DADOS_PESSOAIS.parent.mkdir(parents=True, exist_ok=True)
    with OUT_DADOS_PESSOAIS.open("w", encoding="utf-8") as f:
        json.dump(dados_pessoais, f, ensure_ascii=False, indent=1)
        f.write("\n")

    relatorio.info(f"\napp/dados.js gerado com {len(domicilios)} domicílios, "
                    f"{len(setores)} setores, {total_roteiro} endereços no roteiro "
                    f"(sem nome/telefone).")
    relatorio.info(f"{OUT_DADOS_PESSOAIS.relative_to(REPO_ROOT)} gerado com "
                    f"{len(dados_pessoais)} registro(s) de nome/telefone — NÃO publicar, "
                    f"distribuir só por canal privado à equipe.")
    relatorio.escrever(OUT_RELATORIO)

    print(f"OK: {OUT_DADOS_JS} gerado (sem dados pessoais).")
    print(f"OK: {OUT_DADOS_PESSOAIS} gerado ({len(dados_pessoais)} registros — NÃO publicar).")
    print(f"Relatório: {OUT_RELATORIO} ({len(relatorio.avisos)} avisos)")


if __name__ == "__main__":
    sys.exit(main())
