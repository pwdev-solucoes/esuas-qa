#!/usr/bin/env python3
"""Gera a massa de dados sintetica do CadUnico (HU #9748 / Sprint 8).

CPFs/NIS ficticios mas com digito verificador valido. Nenhum dado real (RN09/LGPD).
Layout: 1 linha por MEMBRO; colunas de familia (d.*) repetem no bloco; o ingest
deduplica a familia por cod_familiar_fam.
"""
import os

OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

DELIM = ";"

# --- geradores de digito verificador ------------------------------------------

def cpf(base9: str) -> str:
    """base9 = 9 digitos -> CPF de 11 digitos com DV valido."""
    assert len(base9) == 9 and base9.isdigit()
    nums = [int(c) for c in base9]
    d1 = (sum(n * w for n, w in zip(nums, range(10, 1, -1))) * 10) % 11
    d1 = 0 if d1 == 10 else d1
    nums.append(d1)
    d2 = (sum(n * w for n, w in zip(nums, range(11, 1, -1))) * 10) % 11
    d2 = 0 if d2 == 10 else d2
    nums.append(d2)
    return "".join(str(n) for n in nums)


def nis(base10: str) -> str:
    """base10 = 10 digitos -> NIS/PIS de 11 digitos com DV valido."""
    assert len(base10) == 10 and base10.isdigit()
    weights = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    s = sum(int(c) * w for c, w in zip(base10, weights))
    dv = 11 - (s % 11)
    dv = 0 if dv in (10, 11) else dv
    return base10 + str(dv)


# pools deterministicos
_cpf_seq = iter(range(100000001, 100000400))
_nis_seq = iter(range(1600000001, 1600000400))

def next_cpf() -> str:
    return cpf(str(next(_cpf_seq)).zfill(9))

def next_nis() -> str:
    return nis(str(next(_nis_seq)).zfill(10))


# --- modelo de colunas --------------------------------------------------------

HEADER = [
    "cd_ibge", "uf", "municipio",
    # familia (d.*)
    "cod_familiar_fam", "dat_cadastramento_fam", "dat_atual_fam",
    "nom_localidade_fam", "nom_tip_logradouro_fam", "nom_logradouro_fam",
    "num_logradouro_fam", "des_complemento_fam", "num_cep_logradouro_fam",
    "vlr_renda_media_fam", "vlr_renda_total_fam", "cod_local_domic_fam",
    "cod_familia_indigena_fam", "ind_familia_quilombola_fam",
    "num_ddd_contato_1_fam", "num_tel_contato_1_fam", "ind_parc_mds_fam",
    # pessoa (p.*)
    "num_nis_pessoa_atual", "nom_pessoa", "nom_apelido_pessoa", "num_cpf_pessoa",
    "dta_nasc_pessoa", "cod_sexo_pessoa", "cod_parentesco_rf_pessoa",
    "cod_raca_cor_pessoa", "grau_instrucao", "cod_deficiencia_memb",
    "ind_trabalho_infantil_pessoa", "marc_sit_rua", "marc_pbf",
]

IBGE = "2704302"
UF = "AL"
MUN = "Maceio"


def member(**kw):
    """Cria um dict de membro com defaults; campos de familia + pessoa."""
    base = {c: "" for c in HEADER}
    base.update({"cd_ibge": IBGE, "uf": UF, "municipio": MUN})
    base.update(kw)
    return base


def fam(cod, dat_atual, members, *, dat_cad="2019-05-02", local="01",
        renda_media="210.00", renda_total="840.00", indigena="0",
        quilombola="0", grupo="0", logr="MARIA SANTOS", num="100",
        cep="60000000", localidade="CENTRO", ddd="85", tel="40040000"):
    """Aplica os campos de familia (d.*) a todos os membros do bloco."""
    rows = []
    for m in members:
        m.update({
            "cod_familiar_fam": cod,
            "dat_cadastramento_fam": dat_cad,
            "dat_atual_fam": dat_atual,
            "nom_localidade_fam": localidade,
            "nom_tip_logradouro_fam": "RUA",
            "nom_logradouro_fam": logr,
            "num_logradouro_fam": num,
            "num_cep_logradouro_fam": cep,
            "vlr_renda_media_fam": renda_media,
            "vlr_renda_total_fam": renda_total,
            "cod_local_domic_fam": local,           # 01=urbano 02=rural
            "cod_familia_indigena_fam": indigena,
            "ind_familia_quilombola_fam": quilombola,
            "num_ddd_contato_1_fam": ddd,
            "num_tel_contato_1_fam": tel,
            "ind_parc_mds_fam": grupo,
        })
        rows.append(m)
    return rows


def write_csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(DELIM.join(HEADER) + "\n")
        for r in rows:
            f.write(DELIM.join(str(r[c]) for c in HEADER) + "\n")


# guarda os CPFs/NIS de RFs reusados entre remessas
RF = {}

def rf_for(key):
    if key not in RF:
        RF[key] = {"cpf": next_cpf(), "nis": next_nis()}
    return RF[key]


# ============================== REMESSA 1 =====================================
r1 = []

# F01 — RF + conjuge + 2 filhos (familia completa, PBF, parda/preta)
r = rf_for("F01")
r1 += fam("1600000001", "2026-05-11", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="MARIA SOUZA LIMA",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1988-03-12", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="4", grau_instrucao="4",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1", nom_apelido_pessoa="MARIA"),
    member(num_nis_pessoa_atual=next_nis(), nom_pessoa="JOSE SOUZA LIMA",
           num_cpf_pessoa=next_cpf(), dta_nasc_pessoa="1985-07-22", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="2", cod_raca_cor_pessoa="2", grau_instrucao="3",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
    member(num_nis_pessoa_atual=next_nis(), nom_pessoa="ANA SOUZA LIMA",
           num_cpf_pessoa=next_cpf(), dta_nasc_pessoa="2012-08-01", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="3", cod_raca_cor_pessoa="4", grau_instrucao="1",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
    member(num_nis_pessoa_atual=next_nis(), nom_pessoa="PEDRO SOUZA LIMA",
           num_cpf_pessoa=next_cpf(), dta_nasc_pessoa="2015-11-30", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="3", cod_raca_cor_pessoa="4", grau_instrucao="1",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
], renda_media="320.00", renda_total="1280.00")

# F02 — unipessoal idoso, deficiencia, branca
r = rf_for("F02")
r1 += fam("1600000002", "2026-04-02", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="ANTONIO PEREIRA",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1950-01-09", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="1", grau_instrucao="2",
           cod_deficiencia_memb="1", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
], renda_media="600.00", renda_total="600.00", local="01")

# F03 — familia indigena rural
r = rf_for("F03")
r1 += fam("1600000003", "2026-05-30", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="RAIMUNDA TABAJARA",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1979-06-18", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="5", grau_instrucao="2",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
    member(num_nis_pessoa_atual=next_nis(), nom_pessoa="KAUA TABAJARA",
           num_cpf_pessoa=next_cpf(), dta_nasc_pessoa="2010-02-14", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="3", cod_raca_cor_pessoa="5", grau_instrucao="1",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="1", marc_sit_rua="2",
           marc_pbf="2"),
], indigena="1", grupo="101", local="02", renda_media="150.00", renda_total="300.00",
   localidade="ALDEIA NOVA")

# F04 — quilombola, situacao de rua no RF
r = rf_for("F04")
r1 += fam("1600000004", "2026-03-21", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="BENEDITO ROSA",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1972-09-05", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="2", grau_instrucao="1",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="1",
           marc_pbf="1"),
], quilombola="1", grupo="201", renda_media="0.00", renda_total="0.00")

# F05, F06, F07, F08 — variacoes simples
for i, (cod, dat, nome, nasc, sexo, raca, grau) in enumerate([
    ("1600000005", "2026-05-05", "LUCIA FERREIRA", "1990-12-01", "2", "3", "5"),
    ("1600000006", "2026-04-18", "CARLOS MENDES",  "1983-04-27", "1", "4", "4"),
    ("1600000007", "2026-02-10", "FRANCISCA ALVES","1965-08-19", "2", "2", "2"),
    ("1600000008", "2026-05-08", "PAULO GOMES",    "1995-10-03", "1", "1", "6"),
]):
    r = rf_for(cod)
    r1 += fam(cod, dat, [
        member(num_nis_pessoa_atual=r["nis"], nom_pessoa=nome, num_cpf_pessoa=r["cpf"],
               dta_nasc_pessoa=nasc, cod_sexo_pessoa=sexo, cod_parentesco_rf_pessoa="1",
               cod_raca_cor_pessoa=raca, grau_instrucao=grau, cod_deficiencia_memb="2",
               ind_trabalho_infantil_pessoa="2", marc_sit_rua="2", marc_pbf="1"),
    ])

# F09 — sera ATUALIZADA na remessa2 (data maior + membro removido). RF + 2 membros.
r = rf_for("F09")
m09b_nis = next_nis(); m09b_cpf = next_cpf()
m09c_nis = next_nis(); m09c_cpf = next_cpf()
r1 += fam("1600000009", "2026-03-01", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="TEREZA CAMPOS",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1980-05-10", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="4", grau_instrucao="3",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
    member(num_nis_pessoa_atual=m09b_nis, nom_pessoa="IGOR CAMPOS",
           num_cpf_pessoa=m09b_cpf, dta_nasc_pessoa="2008-01-20", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="3", cod_raca_cor_pessoa="4", grau_instrucao="2",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
    member(num_nis_pessoa_atual=m09c_nis, nom_pessoa="BRUNO CAMPOS",
           num_cpf_pessoa=m09c_cpf, dta_nasc_pessoa="2006-09-15", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="3", cod_raca_cor_pessoa="4", grau_instrucao="3",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
])

# F10 — sera IGNORADA na remessa2 (data menor). RF unico.
r = rf_for("F10")
r1 += fam("1600000010", "2026-05-20", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="SEBASTIAO ROCHA",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1969-11-11", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="2", grau_instrucao="2",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
])

# F11 — alt-key (RN03): remessa2 reenvia com COD diferente mas MESMO NIS do RF.
r = rf_for("F11")
r1 += fam("1600000011", "2026-04-09", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="HELENA DIAS",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1992-07-07", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="3", grau_instrucao="5",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
])

# --- blocos com ERRO (RN07/CA08) ---
# Eb1 — bloco SEM cod_familiar_fam -> missing_family_code
r1 += fam("", "2026-05-01", [
    member(num_nis_pessoa_atual=next_nis(), nom_pessoa="ERRO SEM CODIGO",
           num_cpf_pessoa=next_cpf(), dta_nasc_pessoa="1990-01-01", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="4", grau_instrucao="2",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
])

# Eb2 — dat_atual_fam INVALIDA -> invalid_date
r = rf_for("Eb2")
r1 += fam("1600000012", "XX/XX/XXXX", [   # data nao-numerica -> parseDate retorna null -> invalid_date
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="ERRO DATA INVALIDA",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1975-03-03", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="1", grau_instrucao="1",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
])

write_csv(os.path.join(OUT, "massa-cadunico-remessa1.csv"), r1)


# ============================== REMESSA 2 =====================================
r2 = []

# F09 — data MAIOR (atualiza) + membro BRUNO removido (desvinculo). Mantem RF + IGOR.
r = rf_for("F09")
r2 += fam("1600000009", "2026-06-15", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="TEREZA CAMPOS",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1980-05-10", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="4", grau_instrucao="4",  # grau mudou
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
    member(num_nis_pessoa_atual=m09b_nis, nom_pessoa="IGOR CAMPOS",
           num_cpf_pessoa=m09b_cpf, dta_nasc_pessoa="2008-01-20", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="3", cod_raca_cor_pessoa="4", grau_instrucao="3",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
    # BRUNO (m09c) NAO consta -> deve ser DESVINCULADO (status=unlinked), nunca excluido.
], renda_media="450.00", renda_total="1350.00")

# F10 — data MENOR (ignora)
r = rf_for("F10")
r2 += fam("1600000010", "2026-01-10", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="SEBASTIAO ROCHA",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1969-11-11", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="2", grau_instrucao="2",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
])

# F11 — alt-key: COD novo (9999...) mas MESMO NIS do RF, data maior -> casa por NIS e atualiza
r = rf_for("F11")
r2 += fam("1600099911", "2026-06-20", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="HELENA DIAS",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1992-07-07", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="3", grau_instrucao="6",  # grau mudou
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="1"),
])

# F13 — familia INEDITA na 2a remessa (criacao)
r = rf_for("F13")
r2 += fam("1600000013", "2026-06-25", [
    member(num_nis_pessoa_atual=r["nis"], nom_pessoa="VITORIA NUNES",
           num_cpf_pessoa=r["cpf"], dta_nasc_pessoa="1998-02-28", cod_sexo_pessoa="2",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="4", grau_instrucao="5",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
])

write_csv(os.path.join(OUT, "massa-cadunico-remessa2.csv"), r2)


# ===================== MUNICIPIO DIVERGENTE (CA02/RN01) =======================
rd = fam("1600000099", "2026-05-11", [
    member(num_nis_pessoa_atual=next_nis(), nom_pessoa="FORA DO MUNICIPIO",
           num_cpf_pessoa=next_cpf(), dta_nasc_pessoa="1990-01-01", cod_sexo_pessoa="1",
           cod_parentesco_rf_pessoa="1", cod_raca_cor_pessoa="4", grau_instrucao="2",
           cod_deficiencia_memb="2", ind_trabalho_infantil_pessoa="2", marc_sit_rua="2",
           marc_pbf="2"),
])
for m in rd:
    m["cd_ibge"] = "3550308"   # Sao Paulo/SP
    m["uf"] = "SP"
    m["municipio"] = "Sao Paulo"
write_csv(os.path.join(OUT, "massa-cadunico-municipio-divergente.csv"), rd)


# ===================== CABECALHO INVALIDO (CA02/RN06) =========================
with open(os.path.join(OUT, "massa-cadunico-cabecalho-invalido.csv"), "w", encoding="utf-8") as f:
    f.write("coluna_a;coluna_b;coluna_c\n")
    f.write("1;2;3\n4;5;6\n")


# ===================== FORMATO INVALIDO (CA02/RN01) — PDF =====================
pdf = (
    b"%PDF-1.4\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R"
    b"/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
    b"4 0 obj<</Length 58>>stream\nBT /F1 18 Tf 20 80 Td (Arquivo NAO-CSV) Tj ET\nendstream endobj\n"
    b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
    b"trailer<</Root 1 0 R>>\n%%EOF\n"
)
with open(os.path.join(OUT, "massa-cadunico-formato-invalido.pdf"), "wb") as f:
    f.write(pdf)

print("OK ->", OUT)
for name in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, name)
    print(f"  {name:48s} {os.path.getsize(p):>6d} bytes")
