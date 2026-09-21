#!/usr/bin/env python3
"""
Gera um relatório HTML de evidências de Critérios de Aceite a partir de um manifest JSON.

Uso:
    python3 generate_report.py --manifest <manifest.json> --out <output_dir>

O <output_dir> é onde `relatorio.html` é escrito; os caminhos de `images` e de
`appendix.file` no manifest são resolvidos RELATIVOS a esse diretório (ex.:
"screenshots/ca01.png", "pest.txt"). Veja references/manifest-schema.md.

Status por CA: "nav" (navegador), "auto" (automatizado), "parc" (parcial/ambos).
"""
import argparse
import html
import json
import pathlib

STATUS = {
    "nav":  ("#1d7a46", "ATENDIDO · navegador"),
    "auto": ("#0b5cad", "ATENDIDO · automatizado"),
    "parc": ("#8a6d00", "ATENDIDO · navegador + automatizado"),
    "fail": ("#9b1c1c", "NÃO ATENDIDO"),
}


def esc(s):
    return html.escape(str(s), quote=False)


def build(manifest: dict, out: pathlib.Path) -> str:
    meta = manifest.get("meta", {})
    cas = manifest.get("cas", [])
    appendix = manifest.get("appendix")
    notes = manifest.get("notes", [])

    meta_rows = "".join(
        f"<div><span>{esc(k)}:</span> {esc(v)}</div>" for k, v in meta.get("rows", [])
    )

    summary_rows = "\n".join(
        f'<tr><td class="caid">{esc(c["id"])}</td><td>{esc(c.get("title",""))}</td>'
        f'<td><span class="pill" style="background:{STATUS.get(c.get("status","nav"),STATUS["nav"])[0]}">'
        f'{STATUS.get(c.get("status","nav"),STATUS["nav"])[1]}</span></td></tr>'
        for c in cas
    )

    sections = []
    for c in cas:
        color, label = STATUS.get(c.get("status", "nav"), STATUS["nav"])
        imgs = "".join(
            f'<figure><img src="{esc(im)}" alt="{esc(c["id"])} evidência"/>'
            f'<figcaption>{esc(pathlib.PurePath(im).name)}</figcaption></figure>'
            for im in c.get("images", [])
        )
        results = "".join(f"<li>{esc(r)}</li>" for r in c.get("results", []))
        evid = imgs or '<p class="noimg">Evidência por cobertura automatizada — ver Anexo.</p>'
        sections.append(f"""
    <section class="ca" id="{esc(c['id'])}">
      <h2>{esc(c['id'])} — {esc(c.get('title',''))} <span class="pill" style="background:{color}">{label}</span></h2>
      <p class="gherkin"><strong>Critério (Gherkin):</strong> {esc(c.get('gherkin',''))}</p>
      <p class="steps"><strong>Como foi testado:</strong> {c.get('steps_html','')}</p>
      <div class="results"><strong>Resultado observado:</strong><ul>{results}</ul></div>
      <div class="evid">{evid}</div>
    </section>""")

    # Notas do dossie (observacoes, ressalvas, achados) — entram no relatorio
    # DEPOIS dos CAs e ANTES do anexo. Sem isto, tudo que o manifest registra em
    # `notes` (ressalvas de negocio, achados de ambiente, defeitos encontrados na
    # captura) ficaria so no JSON e nunca chegaria ao PDF que o PO le.
    notes_html = ""
    if notes:
        items = "".join(
            f'<section class="note"><h3>{esc(n.get("title",""))}</h3>{n.get("html","")}</section>'
            for n in notes
        )
        notes_html = f"""
  <h2>Observações e ressalvas</h2>
  {items}"""

    appendix_html = ""
    if appendix and appendix.get("file"):
        p = out / appendix["file"]
        content = p.read_text(encoding="utf-8") if p.exists() else "(saída não disponível)"
        appendix_html = f"""
  <h2>Anexo — {esc(appendix.get('label','Cobertura automatizada'))}</h2>
  <pre class="pest">{esc(content)}</pre>"""

    return f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>{esc(meta.get('title','Relatório de Aceite'))}</title>
<style>
  :root {{ --ink:#1a2430; --muted:#5b6b7b; --line:#dde5ec; --bg:#f5f8fa; }}
  * {{ box-sizing:border-box; }}
  body {{ font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); margin:0; background:#fff; line-height:1.5; }}
  .wrap {{ max-width:1080px; margin:0 auto; padding:32px 28px 56px; }}
  header.cover {{ border-bottom:3px solid #0b5cad; padding-bottom:18px; margin-bottom:24px; }}
  header.cover h1 {{ margin:0 0 6px; font-size:25px; }}
  header.cover .sub {{ color:var(--muted); font-size:14px; }}
  .meta {{ display:grid; grid-template-columns:1fr 1fr; gap:6px 24px; margin-top:14px; font-size:13px; }}
  .meta div span {{ color:var(--muted); }}
  h2 {{ font-size:18px; margin:26px 0 8px; border-top:1px solid var(--line); padding-top:18px; }}
  .pill {{ color:#fff; font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; vertical-align:middle; white-space:nowrap; }}
  section.note {{ border:1px solid var(--line); border-left:4px solid #b06a00; border-radius:6px; padding:10px 14px; margin:10px 0; background:#fffdf7; font-size:13px; }}
  section.note h3 {{ margin:0 0 6px; font-size:13.5px; color:#8a5200; }}
  section.note p {{ margin:6px 0; }}
  section.note ul {{ margin:6px 0 6px 18px; padding:0; }}
  section.note pre {{ background:var(--bg); border:1px solid var(--line); border-radius:4px; padding:8px; overflow-x:auto; font-size:11px; white-space:pre-wrap; }}
  table.summary {{ width:100%; border-collapse:collapse; margin:10px 0 8px; font-size:13.5px; }}
  table.summary th, table.summary td {{ text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }}
  table.summary th {{ background:var(--bg); font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }}
  td.caid {{ font-weight:700; white-space:nowrap; }}
  section.ca p {{ margin:6px 0; font-size:13.5px; }}
  .gherkin {{ background:var(--bg); border-left:3px solid #0b5cad; padding:8px 12px; border-radius:4px; }}
  .results ul {{ margin:4px 0 0; padding-left:20px; }}
  .results li {{ margin:3px 0; font-size:13.5px; }}
  .evid {{ display:flex; flex-direction:column; align-items:center; gap:20px; margin-top:14px; }}
  figure {{ margin:0 auto; border:1px solid var(--line); border-radius:8px; overflow:hidden; width:90%; max-width:100%; background:#fff; box-shadow:0 1px 4px rgba(16,32,48,.08); }}
  figure img {{ width:100%; display:block; }}
  figcaption {{ font-size:12px; color:var(--muted); padding:8px 10px; border-top:1px solid var(--line); font-family:ui-monospace,Menlo,monospace; text-align:center; }}
  .noimg {{ color:var(--muted); font-style:italic; }}
  pre.pest {{ background:#0f1b27; color:#d7e3ee; padding:16px; border-radius:8px; overflow:auto; font-size:11.5px; line-height:1.45; white-space:pre-wrap; }}
  footer {{ margin-top:36px; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }}
  @media print {{ section.ca {{ break-inside:avoid; }} figure {{ width:96%; break-inside:avoid; }} }}
</style></head>
<body><div class="wrap">
  <header class="cover">
    <h1>{esc(meta.get('title','Relatório de Critérios de Aceite'))}</h1>
    <div class="sub">{esc(meta.get('subtitle',''))}</div>
    <div class="meta">{meta_rows}</div>
  </header>

  <h2 style="border-top:none;padding-top:0">Resumo</h2>
  <p style="font-size:13.5px;margin-top:0">{esc(manifest.get('summary',''))}</p>
  <table class="summary">
    <thead><tr><th>CA</th><th>Critério</th><th>Status</th></tr></thead>
    <tbody>{summary_rows}</tbody>
  </table>
  {''.join(sections)}
  {notes_html}
  {appendix_html}
  <footer>Relatório gerado pela skill <code>acceptance-evidence-report</code> (playwright-cli + Pest). Evidências em <code>screenshots/</code>.</footer>
</div></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True, help="diretório de saída (onde fica relatorio.html)")
    ap.add_argument("--name", default="relatorio.html")
    args = ap.parse_args()

    manifest = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    doc = build(manifest, out)
    dest = out / args.name
    dest.write_text(doc, encoding="utf-8")
    print(f"HTML gerado: {dest} ({len(doc)} bytes, {len(manifest.get('cas', []))} CAs)")


if __name__ == "__main__":
    main()
