# De Critério de Aceite a caso de teste

## 1. Triagem — nem todo CA vira E2E

O E2E do eSUAS cobre **o que só o navegador prova**. Regra de backend já tem Pest, e duplicar custa
lentidão e fragilidade sem comprar confiança.

**Vai para E2E** quando o critério fala de:

- **afordância** — a tela oferece (ou esconde) o que a regra permite: botão ausente, ação some, campo
  muda de forma conforme o dado;
- **filtro de lista visível** — o que o select mostra, e não o que o servidor recusa;
- **redação que o usuário lê** — aviso, mensagem de negativa, toast, estado vazio;
- **fluxo de várias telas** — registrar numa aba e ver refletido em outra, sem recarregar;
- **artefato entregue ao cidadão** — PDF emitido pela tela.

**Fica no Pest** quando o critério exige:

- **segundo tenant** (isolamento), **segundo usuário** com papel distinto, ou **duas unidades do mesmo
  tipo** — cenários que a massa da tela não tem e que no navegador viram teatro;
- **estado de dado sem superfície** — registro antigo com coluna nula, trilha de auditoria, migration;
- **status HTTP e `error_code`** de caminho que a UI nem oferece;
- **cálculo/contagem** conferido campo a campo.

**Vai para ambos** quando o critério tem as duas metades: a tela esconde a ação **e** o servidor recusa
quem forçar. No E2E, prove a metade visível e cite o teste Pest da outra.

### Tabela-exemplo (US-ACOMP-07, real)

| CA | Destino | Por quê |
|---|---|---|
| CA02 — a lista só oferece unidades do tipo certo | **E2E** | O filtro é comportamento de tela; o Pest prova a recusa do servidor, não o que o select mostra |
| CA04 — aviso ao escolher a unidade, sem confirmação | **E2E** | Texto e ausência de diálogo só existem no navegador |
| CA05 — código externo mantém o campo de texto | **E2E** | A forma do formulário muda conforme o dado |
| CA07 — definir unidade num encaminhamento antigo | **E2E** | Ação na lista, diálogo e linha atualizada sem recarregar |
| CA08 — desfecho trava a alteração | **ambos** | A ação sumir é E2E; o 409 `referral_destination_locked_by_outcome` é Pest |
| CA03 — destino ≠ origem | **Pest** | Exige duas unidades do mesmo tipo; a massa da tela tem um CREAS só |
| CA06 — encaminhamento antigo não concede acesso | **Pest** | Regra de dado, sem superfície de tela |
| CA12 — isolamento entre municípios | **Pest** | Exige um segundo tenant |
| CA-extra-B — 403 para quem não é autor nem Master | **Pest** | Exige dois operadores com acesso ao mesmo prontuário |

Entregue a tabela **antes** de escrever código: é ela que define o tamanho do spec.

## 2. Convenção de título

```ts
test('CA01 — os cinco tipos do leiaute aparecem na ordem do XML, sem porta de criação', …)
test('CA02/CA03/CA04 — cada tipo mostra contagem, natureza temporal e obrigatoriedade', …)
```

Regras, ditadas por `e2e/helpers/evidence.ts:51` (`criteriaFromTitle`):

- os identificadores vêm **antes do travessão `—`** e casam `CA|RN|D` + **dois dígitos**. `CA1` e
  `CA012` não são reconhecidos, e **`CA-extra-A` também não** — o print sairia como `sem-criterio`.
  Para os critérios "extra" das specs, comece o título pela decisão ou regra equivalente (`D08 — …`,
  `RN05 — …`) e **cite o CA no fim do título**: `'D08 — … (CA-extra-C)'`;
- vários critérios no mesmo caso separam-se por `/`, e o helper grava **um arquivo por critério**;
- depois do travessão vem **o que a tela prova**, em pt-BR, afirmativo: "a exclusão é recusada com
  explicação que orienta inativar", não "testa exclusão".
- o `describe` nomeia a HU: `'US-ACOMP-02 — acompanhamento familiar no prontuário (client)'` ou
  `'HU #10619 — ingresso e programas sociais no prontuário (client)'`.

Numere pelo **chamado/spec vigente**. Renumerar depois custou cinco commits de correção de dossiê em
setembro/2026.

## 3. Tradução do Gherkin

| Cláusula | Vira |
|---|---|
| **Dado** (pré-condição de dado) | massa no `beforeAll` via API, idempotente; ou `test.skip` com a dica quando só o seeder cria |
| **Dado** (perfil/sessão) | escolha do project; outro perfil → `loginAsTenantUser` em página própria |
| **Quando** | a ação na tela: `goto` + `dismissPlatformUpdates`, clique, preenchimento — com `waitForResponse` encadeado antes da ação que dispara a chamada |
| **Então** (visível) | asserção na tela por `data-testid` / `getByRole`; ausência com `toHaveCount(0)` |
| **Então** (persistido) | segunda asserção pela API, no mesmo caso — a dupla prova |
| **Então** (status HTTP de caminho sem UI) | não force pela tela: cite o teste Pest na tabela de triagem |

Exemplo, do CA04 da US-ACOMP-07:

```gherkin
Dado que escolhi o "CREAS" como unidade de destino no formulário
Então vejo o aviso "A equipe de CREAS passará a enxergar o prontuário…"
Quando eu salvar
Então o registro é salvo sem diálogo de confirmação
E o toast de sucesso repete o aviso
```

```ts
test('CA04 — o aviso do efeito no acesso aparece ao escolher, e o toast o repete', async ({ page }) => {
  await openReferralSheet(page, FAMILY_WORK!);            // Dado
  await chooseDestinationUnit(page, 'E2E CREAS');         // Quando (1)

  const notice = page.getByTestId('referral-destination-access-notice');
  await expect(notice).toHaveAttribute('role', 'status'); // Então: informativo
  await expect(notice).toContainText(/passará a enxergar o prontuário/i);

  const created = page.waitForResponse((r) =>
    r.url().includes('/referrals') && r.request().method() === 'POST');
  await page.getByTestId('referral-form-submit').click(); // Quando (2)
  expect((await created).status()).toBe(201);

  await expect(page.getByRole('alertdialog')).toHaveCount(0);        // sem confirmação
  await expect(page.locator('[data-sonner-toast]')).toContainText(/passará a enxergar/i);
});
```

## 4. Quando o CA não couber

- **Massa inexistente** → `test.skip(cond, SEED_HINT)` com o comando exato, ou asserção que falha
  carregando a dica (`expect(codes, seedHint(slug)).toEqual(...)`). Pular em silêncio conta a história
  errada; falhar sem dizer o comando também.
- **Alvo sem `data-testid`** → proponha ao usuário: `getByRole` estável agora, ou o testid no front.
- **CA que depende de HU futura** → declare "pendente por design" no resumo e no JSDoc do spec, como se
  faz no dossiê. Não escreva teste que finge provar.
