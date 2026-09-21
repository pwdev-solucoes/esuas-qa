# Fechamento de débito — gradiente do heatmap de camadas custom

**Débito registrado no dossiê HU-CAM (Construtor de Camadas):** o heatmap OpenLayers das
camadas custom usava o gradiente **default do OL**, ignorando `style.color`/`style.palette`
configurados no Construtor.

**Fechado em 2026-07-05 pela HU #9863** (branch `sprint9-heatmap-vulnerabilidades` do client,
commit `b9a1b73`): a camada com `representation = heatmap` passa a derivar o gradiente da
paleta declarada no `style` (ou interpolação clara→cor quando só há `color`; fallback = paleta
quente padrão), e ganha entrada nomeada na legenda dinâmica de densidade.

**Evidência:** `e2e/reports/9863-acceptance/` — CA07
(`screenshots/ca07-camada-custom-paleta-configurada.png`): camada "Famílias beneficiárias do
PBF" (`style.color = #163c84`) renderizada com gradiente clara→`#163c84` e legenda própria.

**Permanece registrado** (não coberto): paridade plena do heatmap no engine Leaflet (segue
aproximação por círculos difusos com cor da paleta) e preview de `boundaries` no admin sem
choropleth por setor.
