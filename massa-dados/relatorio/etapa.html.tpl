<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{titulo_pagina}}</title>
<!-- Gerado por qa/massa-dados/lib/relatorio.ts a partir de relatorio/*.html.tpl (molde: .planning/roadmap-massa-dados/evidencias-template.html). -->
<style>
  :root {
    --bg: #f6f8fb; --surface: #ffffff; --text: #1d2939; --muted: #667085;
    --brand: #1d4181; --accent: #feb72f; --border: #d0d5dd;
    --ok: #12795b; --ok-bg: #e7f6ef; --fail: #b42318; --fail-bg: #fdecea;
    --warn: #93600a; --warn-bg: #fef4e0; --skip: #475467; --skip-bg: #eef1f5;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0f1623; --surface: #172131; --text: #e6ebf2; --muted: #98a2b3;
      --brand: #8fb0ff; --accent: #feb72f; --border: #2c3a50;
      --ok: #5fd3a5; --ok-bg: #12352a; --fail: #ff8a80; --fail-bg: #3d1a1a;
      --warn: #f5c56b; --warn-bg: #3a2c0f; --skip: #b0b8c6; --skip-bg: #222c3c;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0f1623; --surface: #172131; --text: #e6ebf2; --muted: #98a2b3;
    --brand: #8fb0ff; --accent: #feb72f; --border: #2c3a50;
    --ok: #5fd3a5; --ok-bg: #12352a; --fail: #ff8a80; --fail-bg: #3d1a1a;
    --warn: #f5c56b; --warn-bg: #3a2c0f; --skip: #b0b8c6; --skip-bg: #222c3c;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
  header.top { background: var(--brand); color: #fff; border-radius: 12px; padding: 20px 24px; }
  :root[data-theme="dark"] header.top { color: #0f1623; }
  header.top .tag { display: inline-block; background: var(--accent); color: #1d4181;
    font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; }
  header.top h1 { margin: 8px 0 4px; font-size: 22px; }
  header.top p { margin: 0; opacity: .9; }
  section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 20px; margin-top: 20px; }
  h2 { margin: 0 0 12px; font-size: 18px; color: var(--brand); }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .meta div { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .meta b { display: block; font-size: 12px; color: var(--muted); font-weight: 600; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  .st { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
  .st.ok { color: var(--ok); background: var(--ok-bg); }
  .st.fail { color: var(--fail); background: var(--fail-bg); }
  .st.warn { color: var(--warn); background: var(--warn-bg); }
  .st.skip { color: var(--skip); background: var(--skip-bg); }
  a { color: var(--brand); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  figure { margin: 12px 0; }
  figure img { max-width: 100%; border: 1px solid var(--border); border-radius: 8px; }
  figcaption { font-size: 13px; color: var(--muted); margin-top: 4px; }
  .note { border-left: 4px solid var(--accent); padding: 8px 12px; background: var(--warn-bg); border-radius: 6px; }
  .grid9 td, .grid9 th { font-size: 12px; padding: 4px 6px; }
  td.dif { color: var(--fail); background: var(--fail-bg); font-weight: 700; }
  td.exp { color: var(--warn); background: var(--warn-bg); font-weight: 700; }
  details summary { cursor: pointer; color: var(--brand); font-weight: 600; }
  ul.lista { margin: 4px 0; padding-left: 20px; }
  footer { margin-top: 24px; font-size: 12px; color: var(--muted); text-align: center; }
</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <span class="tag">Etapa {{codigo}}</span>
  <h1>{{codigo}} — {{titulo}}</h1>
  <p><a href="index.html" style="color:inherit">← índice da execução {{execucao_id}}</a></p>
</header>

<section id="resumo">
  <h2>Resumo</h2>
  <div class="meta">
    <div><b>Status</b>{{{status_html}}}</div>
    <div><b>Papel</b>{{papel}}</div>
    <div><b>CAs</b>{{cas}}</div>
    <div><b>Duração</b>{{duracao}}</div>
  </div>
</section>

<section id="requisicoes">
  <h2>Requisições</h2>
  {{{requisicoes}}}
</section>

<section id="passos">
  <h2>Passos e conferências</h2>
  {{{passos}}}
</section>

<section id="prints">
  <h2>Evidências visuais</h2>
  {{{prints}}}
</section>

<section id="contagens">
  <h2>Contagens conferidas</h2>
  {{{contagens}}}
</section>

<section id="avisos">
  <h2>Avisos, achados e divergências</h2>
  {{{avisos}}}
</section>

<footer>Relatório gerado por qa/massa-dados · execução {{execucao_id}} · dados 100% fictícios (RN01) · sem credenciais (RN-T7)</footer>
</div>
</body>
</html>
