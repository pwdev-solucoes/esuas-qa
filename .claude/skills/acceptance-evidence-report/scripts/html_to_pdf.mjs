#!/usr/bin/env node
// Converte um relatório HTML local em PDF A4 (com imagens embutidas), usando o
// Playwright já instalado em `e2e/node_modules`.
//
// Uso:  node html_to_pdf.mjs <relatorio.html> <relatorio.pdf>
//
// Por que este script existe: o `playwright-cli goto/open file://…` retorna
// about:blank (não carrega o arquivo local). A renderização precisa de um
// `page.goto('file://…')` real seguido de `page.pdf()` — é o que fazemos aqui.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// scripts -> acceptance-evidence-report -> skills -> .claude -> <repo root>
const repoRoot = path.resolve(__dirname, '../../../..')
const e2eDir = process.env.E2E_DIR || path.join(repoRoot, 'e2e')
const require = createRequire(path.join(e2eDir, 'package.json'))
const { chromium } = require('playwright')

const [, , htmlArg, pdfArg] = process.argv
if (!htmlArg || !pdfArg) {
  console.error('Uso: node html_to_pdf.mjs <relatorio.html> <relatorio.pdf>')
  process.exit(1)
}

const htmlAbs = path.resolve(htmlArg)
const pdfAbs = path.resolve(pdfArg)

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(pathToFileURL(htmlAbs).href, { waitUntil: 'networkidle' })
  const imgs = await page.evaluate(() => ({
    total: document.images.length,
    loaded: [...document.images].filter((i) => i.naturalWidth > 0).length,
  }))
  await page.pdf({
    path: pdfAbs,
    format: 'A4',
    printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
  })
  console.log(`PDF gerado: ${pdfAbs} (imagens ${imgs.loaded}/${imgs.total})`)
} finally {
  await browser.close()
}
