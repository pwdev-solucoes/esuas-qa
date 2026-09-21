# CA29 (HU-GEO-01) — fechado pela entrega do Construtor de Camadas

O CA29 ("camadas publicadas do Construtor aparecem na barra lateral do painel, desligadas
por padrão") havia sido **deferido por design** na entrega da HU-GEO-01 (o endpoint
`GET /geo-panel/layers` ficou preparado para a mescla, sem catálogo para consumir).

**Fechado em 2026-07-04** pela feature Construtor de Camadas (branch
`sprint9-construtor-camadas`: api `c89180c`, admin `af39815`+`340fbb3`, client
`69b14fe`+`95fed31`). Evidências: `e2e/reports/hu-cam-acceptance/` (seção CA29* —
sidebar com camadas mescladas desligadas por padrão, render por representação,
CA48 de remoção ao vivo com toast e CA49 de reativação).
