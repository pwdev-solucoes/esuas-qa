# Preparar o PDF do dossiê antes de anexar ao GLPI

Duas coisas atrapalham o anexo e ambas se resolvem **antes** do `upload_document`: o tamanho do
arquivo e o nome genérico. Nenhuma delas é detectada pelo MCP — o `upload_document` responde
`status: "created"` mesmo quando o resultado é inútil para quem vai abrir o anexo.

## 1. Tamanho

**O que se sabe:** um dossiê de 2,44 MB foi reportado pelo usuário como "aparecendo com problema" no
GLPI; a versão de 1,07 MB do mesmo relatório foi anexada em seguida. (Ticket #10617, 27/08/2026.)

**O que NÃO se sabe:** o limite exato configurado na instância. O MCP não expõe a configuração do GLPI
e ninguém confirmou o valor na interface. A suspeita é o padrão comum de 2 MB
(`document_max_size`), mas **isso é inferência** — não escreva o número como fato para o usuário.
Se algum dia for confirmado em *Configuração → Geral*, atualize esta seção com o valor real.

**Prática segura, independente do limite real:** manter o PDF **abaixo de ~1,5 MB**. É folgado o
bastante para qualquer configuração usual e não custa quase nada, já que quase todo o peso vem das
capturas de tela.

### Receita medida (ticket #10617)

O dossiê original tinha 2.443.412 bytes, com ~2,0 MB só de PNG.

| Tentativa | Resultado |
|---|---|
| Otimizar os PNG (resize 80% + paleta 256 cores) | capturas −59%, **PDF −16%** |
| Converter para JPEG (resize 75%, q72, progressive) | capturas −73%, **PDF −55% → 1.121.945 bytes** |

**Por que o PNG rende pouco:** o Chromium reencoda as imagens ao embutir no PDF, então otimização de
PNG na origem não se traduz proporcionalmente. JPEG entra como `DCTDecode` e é o que realmente reduz.

O procedimento não toca o dossiê original — monte a versão leve num diretório temporário:

```
1) copiar manifest.json + <suite>.txt para um dir temporário
2) reencodar cada screenshots/*.png como .jpg (resize ~0.75, quality ~72, optimize, progressive)
3) reapontar as entradas `images[]` do manifest de .png para .jpg
4) rodar generate_report.py e html_to_pdf.mjs sobre o dir temporário
5) conferir integridade antes de enviar (ver abaixo)
```

O `generate_report.py` usa os caminhos que estiverem em `images[]`, então trocar a extensão no
manifest é suficiente — o HTML sai apontando para os JPEG sozinho.

### Conferir antes de enviar

O `html_to_pdf.mjs` já reporta `imagens N/N` — confira que nenhuma ficou de fora. Além disso vale
checar o arquivo direto:

- começa com `%PDF-` e termina com `%%EOF`;
- número de páginas e de `/Subtype /Image` compatível com o dossiê original;
- `/DCTDecode` presente (confirma que as imagens entraram como JPEG).

Um PDF abaixo de ~50 KB é sinal de que as imagens **não** entraram — o mesmo alerta que a skill
`acceptance-evidence-report` já faz.

## 2. Nome do arquivo

O gerador sempre produz `relatorio.pdf`. Anexado assim, o ticket fica com um `relatorio.pdf` genérico
— e, quando várias HUs são validadas, vários arquivos indistinguíveis entre si.

**Faça uma cópia com nome descritivo e envie a cópia**, em vez de renomear o original: o
`html_to_pdf.mjs` recria `relatorio.pdf` a cada regeneração, e renomear dentro da pasta do dossiê
acabaria produzindo um par duplicado.

Padrão sugerido: `HU-<numero>-evidencias-<slug-curto-do-titulo>.pdf`
Exemplo real: `HU-10617-evidencias-acesso-prontuario-por-unidade.pdf`

O parâmetro `name` do `upload_document` é o título do Document no GLPI e é independente do nome do
arquivo — vale manter os dois descritivos.

## 3. Não dá para desfazer pelo MCP

**O MCP não expõe exclusão nem desvínculo de documento.** Cada `upload_document` + `link_document`
adiciona um anexo ao ticket, e reenviar deixa o anterior lá. No #10617 o ticket terminou com três
cópias do mesmo dossiê, todas removíveis só pela interface do GLPI.

Consequência prática: **acerte tamanho e nome antes do primeiro envio.** Se precisar reenviar, avise
o usuário na hora que o anexo anterior ficará no ticket e precisará ser removido à mão.

E nunca abra uma segunda validação ao reenviar o arquivo — a solicitação já existente continua válida,
pois o texto aprovado está nela e não no anexo.
