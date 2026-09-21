# Runbook eSUAS — dirigir CAs no client e gerar evidências

Comandos **reais** validados na execução do CadÚnico. Substitua `<slug>` pela fila/feature.

## 1. Preparar a stack (reusar a que já está no ar)

```bash
# A stack do eSUAS roda via Sail. Confirme:
docker ps --format '{{.Names}}\t{{.Ports}}' | grep api-laravel
#   api-laravel.test-1  -> API em http://localhost (porta 80) + client interno
#   api-laravel.worker-1 -> worker (queue:work --queue=high,default,low,dne)
#   api-pgsql-1, api-redis-1, api-minio-1, api-mailpit-1
# Client (Vite) costuma estar em :5174 apontando p/ http://localhost/api (não-mock).
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5174     # 200 = client no ar
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/up       # 200 = API no ar
```

> **Se já está no ar, NÃO edite `.env` nem suba outra stack.** Use como está.
> Porta 8000 pode ser de OUTRO projeto (no ambiente de referência era `glpi`). A API do eSUAS é `:80`.

```bash
APP=api-laravel.test-1
# Migrations da feature (aditivas) + dados E2E + permissões
docker exec $APP php artisan migrate --force
docker exec $APP php artisan db:seed --class='Database\Seeders\E2ESeeder' --force
docker exec $APP php artisan permissions:sync
# Conferir master/operador/município (esperado: master Y, operador N):
docker exec $APP php artisan tinker --execute="
  \$m=App\Models\Client::where('cpf','52998224725')->first();
  \$o=App\Models\Client::where('cpf','11144477735')->first();
  echo 'master='.(\$m?->hasPermissionTo('<slug>-imports.store')?'Y':'N').' operador='.(\$o&&\$o->hasPermissionTo('<slug>-imports.store')?'Y':'N');
"
```

### Worker da fila da feature (jobs assíncronos)

O worker padrão só cobre `high,default,low,dne`. Suba um para a fila da feature **em background** e
encerre-o no teardown:

```bash
# rodar em background (Bash run_in_background):
docker exec $APP php artisan queue:work --queue=<slug> --tries=1 --timeout=600 --sleep=1
# teardown:
docker exec $APP pkill -f "queue:work --queue=<slug>"
```

### Credenciais (E2ESeeder)

| Papel | CPF | Senha | Tem `<slug>-imports.*`? |
|---|---|---|---|
| Master | `52998224725` | `senha123` | sim |
| Operador | `11144477735` | `senha123` | não (gating CA03) |

Tenant: "Organização E2E CadÚnico" (uuid `00000000-0000-4000-8000-0000000000c1`, IBGE 2304400).

## 2. playwright-cli — login + gates

```bash
playwright-cli open http://localhost:5174/auth/login
playwright-cli resize 1440 900
playwright-cli --raw snapshot            # achar refs do form (CPF, Senha, "Acessar Sistema")
playwright-cli fill <refCPF> "52998224725"
playwright-cli fill <refSenha> "senha123"
playwright-cli click "getByRole('button', { name: 'Acessar Sistema' })"
```

**Gate select-tenant** (se houver >1 tenant): clicar o nome da organização → "Entrar/Continuar".

**Gate legal-acceptance** (comum): a tela exige aceite de Termo de Uso + Política de Privacidade.
Para cada documento: clicar a **linha do checkbox** (`generic [cursor=pointer]` logo antes de
"Li e aceito…") → botão "Aceitar e continuar" (doc 1) / "Aceitar e entrar" (doc 2) → por fim
"Entrar no SigSuas". (Os `refs` mudam; `snapshot` antes de cada clique.)

Navegar ao módulo: clicar na sidebar (ex.: "Importações do CadÚnico") ou
`playwright-cli goto http://localhost:5174/app/<slug>-imports`.

## 3. Dirigir um CA e capturar (padrão de upload)

```bash
playwright-cli click "getByRole('button', { name: 'Nova importação' })"
# UPLOAD: o input é escondido → setInputFiles (NÃO use `playwright-cli upload`):
playwright-cli run-code "async page => { await page.locator('input[type=file]').first().setInputFiles('/abs/e2e/fixtures/<slug>/arquivo.csv'); return 'set'; }"
playwright-cli click "getByRole('button', { name: 'Validar arquivo' })"
playwright-cli --raw snapshot | grep -iE 'validado|erro'          # checar resultado
playwright-cli screenshot --filename=<output_dir>/screenshots/ca01-validado.png
```

Confirmar + sincronizar (assíncrono → o worker processa; UI faz polling ~5s):

```bash
playwright-cli click "getByRole('button', { name: 'Confirmar importação' })"
sleep 8                                   # aguarda Etapa 1 (worker)
# abrir detalhe pela linha:
MA=$(playwright-cli --raw snapshot | grep -nE 'button "Mais ações"' | head -1 | grep -oE 'ref=e[0-9]+' | head -1 | cut -d= -f2)
playwright-cli click "$MA"; playwright-cli click "getByText('Ver detalhes')"
playwright-cli click "getByRole('button', { name: 'Sincronizar famílias' })"
sleep 8                                   # aguarda Etapa 2
```

**Conferir os números no banco** (a sheet pode estar defasada):

```bash
docker exec $APP php artisan tinker --execute="\$i=App\Models\CadunicoImport::latest('id')->first(); echo 'created='.\$i->families_created.' analyzed='.\$i->total_analyzed.' sync='.\$i->sync_status->value;"
```

**Sheet defasada** → `playwright-cli reload` + reabrir o detalhe antes do print (findOne re-busca).

### Casos especiais
- **Gating (CA03)**: logout (menu do usuário → "Sair"), login como **operador**, aceitar termos, e
  evidenciar: sidebar sem o módulo + `playwright-cli goto …/app/<slug>-imports` → página `/403`.
- **Concorrência (RN11)**: injetar lote ativo e printar o botão desabilitado:
  ```bash
  docker exec $APP php artisan tinker --execute="\$t=App\Models\Tenant::where('cnpj','11222333000181')->first(); App\Models\CadunicoImport::create([...,'status'=>App\Enums\CadunicoImportStatus::PROCESSING,...]);"
  playwright-cli reload   # botão "Nova importação" fica [disabled] + tooltip da RN11
  # depois: forceDelete do lote injetado.
  ```

## 4. Suíte automatizada (CAs de backend)

```bash
docker exec $APP php -d memory_limit=1G vendor/bin/pest --filter=<Feature> --colors=never \
  | sed 's/\x1b\[[0-9;]*m//g' > <output_dir>/<suite>.txt
```

## 5. Montar manifest + gerar HTML + PDF

```bash
# manifest.json conforme references/manifest-schema.md (copiar o Gherkin da spec §5)
python3 .claude/skills/acceptance-evidence-report/scripts/generate_report.py \
  --manifest <output_dir>/manifest.json --out <output_dir>
node .claude/skills/acceptance-evidence-report/scripts/html_to_pdf.mjs \
  <output_dir>/relatorio.html <output_dir>/relatorio.pdf
```

## 6. Teardown

```bash
playwright-cli close
docker exec $APP pkill -f "queue:work --queue=<slug>"
# NÃO commitar/pushar; NÃO restaurar .env (não foi tocado). Informar caminhos dos artefatos.
```

## GOTCHAS (resumo)

1. **Upload** → `run-code` + `setInputFiles('input[type=file]')`; `playwright-cli upload` falha (precisa file-chooser).
2. **PDF** → `html_to_pdf.mjs` (`page.goto('file://…')` + `page.pdf()`); `playwright-cli goto/open file://` dá `about:blank`.
3. **Refs voláteis** → `snapshot` antes de agir; prefira `getByRole`/`getByText`.
4. **Sheet defasada** → `reload` antes do print; confirme números via `tinker`.
5. **Fila** → suba o worker da fila certa; senão o lote fica `Processando` e os contadores não aparecem.
6. **Ambiente já no ar** → reuse; não edite `.env` nem suba stack nova; a API do eSUAS é `:80` (não `:8000`).

## Exemplo de referência — CadÚnico (12 CAs)

| CA | Status | Evidência |
|----|--------|-----------|
| CA01 validação OK | nav | "Arquivo validado" + Confirmar habilitado |
| CA02 rejeição | nav | cabeçalho divergente, não-CSV, outro município (RN01) |
| CA03 sem permissão | nav | operador sem o módulo + `/403` |
| CA04 famílias inéditas | nav | "Novas famílias 1" |
| CA05 atualização por data | nav | "Atualizadas por data 1" |
| CA06 ignoradas | nav | "Ignoradas por sincronização 1" |
| CA07 concorrência | nav | botão desabilitado + tooltip RN11 |
| CA08 métricas | nav | "Resumo da sincronização" |
| CA09/CA10 permissão por papel | auto | Pest (master tem / operador não) |
| CA11 histórico | nav | lista com executor "…[Master]" |
| CA12 isolamento | parc | histórico só do tenant + Pest 404 cruzado |
