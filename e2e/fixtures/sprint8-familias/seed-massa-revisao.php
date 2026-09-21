<?php

/**
 * Massa de testes — Revisão geral das HUs #9759–#9764 (Sprint 8).
 *
 * 7 famílias / 20 indivíduos no tenant E2E (uuid 00000000-0000-4000-8000-0000000000c1),
 * códigos familiares 32000000xx (não colide com a massa CadÚnico 16000000xx).
 * Idempotente: re-executar não duplica (chaveado por family_code / cpf / nis).
 *
 * Cobertura desenhada:
 *  - 3 "MARIA"s em famílias distintas → busca parcial por nome (#9759 CA04) com múltiplos hits;
 *  - CPF/Código Familiar exatos (#9759 CA02/CA03) — família F1 com 5 membros;
 *  - nome social precedendo o civil (F2 — JOANA) e criança SEM CPF (F1 — "—" na coluna);
 *  - mother_name preenchida → coluna "Filiação 1" com valor real;
 *  - idoso (F3, 1950) e criança (F1, 2020) → cálculo de idade nas pontas;
 *  - F4/F5/F6 com inconsistência de endereço ABERTA (uma por razão: cep_missing,
 *    cep_not_found, no_match) → painel #9762 e export #9763;
 *  - F6 com inconsistência RESOLVIDA adicional → histórico preservado fora do painel;
 *  - F5 SEM telefone → coluna vazia no CSV (#9763 RN04);
 *  - prontuário (#9760/#9761) usa qualquer família; F1 é a mais rica.
 *
 * Uso (host):
 *   docker cp e2e/fixtures/sprint8-familias/seed-massa-revisao.php api-laravel.test-1:/tmp/seed-massa.php
 *   docker exec api-laravel.test-1 php artisan tinker --execute="require '/tmp/seed-massa.php';"
 */

use App\Models\Address;
use App\Models\Family;
use App\Models\FamilyAddressInconsistency;
use App\Models\FamilyMember;
use App\Models\Person;
use App\Models\Tenant;

$tenant = Tenant::where('uuid', '00000000-0000-4000-8000-0000000000c1')->firstOrFail();
$address = Address::query()->whereHas('city', fn ($q) => $q->where('name', 'Fortaleza'))->firstOrFail();
$statusId = Family::withoutGlobalScopes()->whereNotNull('status_id')->value('status_id') ?? 1;

// [family_code, telefone|null, membros[]]; membro = [full_name, cpf|null, nis, birth, mother|null, social|null, rf?]
$familias = [
    ['3200000001', '85988110001', [
        ['MARIA APARECIDA DA SILVA', '32000000101', '32000001011', '1985-04-12', 'ROSA MARIA DA SILVA', null, true],
        ['JOSE CARLOS DA SILVA', '32000000102', '32000001021', '1982-09-30', 'ANTONIA DA SILVA', null, false],
        ['ANA CLARA DA SILVA', '32000000103', '32000001031', '2010-02-14', 'MARIA APARECIDA DA SILVA', null, false],
        ['PEDRO HENRIQUE DA SILVA', '32000000104', '32000001041', '2015-07-01', 'MARIA APARECIDA DA SILVA', null, false],
        ['LUIZ MIGUEL DA SILVA', null, '32000001051', '2020-11-23', 'MARIA APARECIDA DA SILVA', null, false],
    ]],
    ['3200000002', '85988110002', [
        ['MARIA JOSE OLIVEIRA', '32000000201', '32000002011', '1990-06-05', 'FRANCISCA OLIVEIRA', null, true],
        ['JOAO BATISTA OLIVEIRA', '32000000202', '32000002021', '1995-01-17', 'FRANCISCA OLIVEIRA', 'JOANA BATISTA OLIVEIRA', false],
        ['FRANCISCO OLIVEIRA NETO', '32000000203', '32000002031', '2008-12-08', 'MARIA JOSE OLIVEIRA', null, false],
    ]],
    ['3200000003', '85988110003', [
        ['ANTONIO PEREIRA DOS SANTOS', '32000000301', '32000003011', '1950-01-20', null, null, true],
        ['TEREZINHA PEREIRA DOS SANTOS', '32000000302', '32000003021', '1955-05-09', null, null, false],
    ]],
    ['3200000004', '85988110004', [
        ['RAIMUNDO NONATO DA COSTA', '32000000401', '32000004011', '1978-03-03', 'LUZIA DA COSTA', null, true],
        ['SOCORRO DA COSTA', '32000000402', '32000004021', '1980-08-19', 'LUZIA DA COSTA', null, false],
        ['CARLOS EDUARDO DA COSTA', '32000000403', '32000004031', '2012-04-27', 'SOCORRO DA COSTA', null, false],
        ['LARISSA DA COSTA', '32000000404', '32000004041', '2018-10-10', 'SOCORRO DA COSTA', null, false],
    ]],
    ['3200000005', null, [
        ['FRANCISCA DAS CHAGAS LIMA', '32000000501', '32000005011', '1988-02-25', 'DAS DORES LIMA', null, true],
        ['GABRIEL LIMA', '32000000502', '32000005021', '2009-09-09', 'FRANCISCA DAS CHAGAS LIMA', null, false],
        ['SOPHIA LIMA', '32000000503', '32000005031', '2016-06-16', 'FRANCISCA DAS CHAGAS LIMA', null, false],
    ]],
    ['3200000006', '85988110006', [
        ['SEBASTIAO ROCHA FILHO', '32000000601', '32000006011', '1970-07-07', null, null, true],
        ['IVONE ROCHA', '32000000602', '32000006021', '1972-12-01', null, null, false],
    ]],
    ['3200000007', '85988110007', [
        ['MARIA DAS DORES FERREIRA', '32000000701', '32000007011', '1965-10-31', 'BENEDITA FERREIRA', null, true],
    ]],
];

$inconsistencias = [
    '3200000004' => ['open', 'cep_missing', 'RUA PROJETADA SEM CEP, 45, PIRAMBU'],
    '3200000005' => ['open', 'cep_not_found', 'AV. DAS DUNAS, 1200, CEP 99999-000, PRAIA DO FUTURO'],
    '3200000006' => ['open', 'no_match', 'RUA DE OUTRO MUNICIPIO, 10, CEP 01001-000, CENTRO'],
];

$pessoas = 0;

$criarPessoa = function (array $m): Person {
    [$name, $cpf, $nis, $birth, $mother] = $m;

    return $cpf
        ? Person::firstOrCreate(['cpf' => $cpf], ['full_name' => $name, 'birth_date' => $birth, 'mother_name' => $mother])
        : Person::firstOrCreate(['full_name' => $name, 'birth_date' => $birth], ['mother_name' => $mother]);
};

foreach ($familias as [$code, $phone, $membros]) {
    $rf = collect($membros)->first(fn ($m) => $m[6]);
    $rfPerson = $criarPessoa($rf);

    $family = Family::withoutGlobalScopes()
        ->where('tenant_id', $tenant->id)->where('family_code', $code)->first()
        ?? Family::factory()->create([
            'tenant_id' => $tenant->id,
            'family_code' => $code,
            'status_id' => $statusId,
            'address_id' => $address->id,
            'contact_phone_1' => $phone,
            'responsible_person_id' => $rfPerson->id,
            'responsible_nis' => $rf[2],
            'responsible_cpf' => $rf[1],
        ]);

    foreach ($membros as $m) {
        [, , $nis, , , $social, $isRf] = $m;
        $person = $isRf ? $rfPerson : $criarPessoa($m);

        FamilyMember::withoutGlobalScopes()->firstOrCreate(
            ['tenant_id' => $tenant->id, 'family_id' => $family->id, 'person_id' => $person->id],
            ['member_nis' => $nis, 'is_responsible' => $isRf, 'social_name' => $social, 'status' => 'active']
        );

        $pessoas++;
    }

    $criarInconsistencia = function (array $attrs) use ($tenant, $family): void {
        $exists = FamilyAddressInconsistency::withoutGlobalScopes()
            ->where('tenant_id', $tenant->id)->where('family_id', $family->id)
            ->where('status', $attrs['status'])->exists();

        if (! $exists) {
            FamilyAddressInconsistency::factory()->create(
                $attrs + ['tenant_id' => $tenant->id, 'family_id' => $family->id]
            );
        }
    };

    if (isset($inconsistencias[$code])) {
        [$st, $reason, $texto] = $inconsistencias[$code];
        $criarInconsistencia(['status' => $st, 'failure_reason' => $reason, 'rejected_address_text' => $texto, 'flagged_at' => now(), 'resolved_at' => null, 'resolved_by_import_id' => null]);
    }

    // F6: inconsistência antiga já resolvida (histórico fora do painel)
    if ($code === '3200000006') {
        $criarInconsistencia(['status' => 'resolved', 'failure_reason' => 'cep_missing', 'rejected_address_text' => 'ENDERECO ANTIGO JA CORRIGIDO, 1', 'flagged_at' => now()->subDays(30), 'resolved_at' => now()->subDays(7)]);
    }
}

echo "Massa sprint8-familias: {$pessoas} pessoas em ".count($familias)." famílias (tenant {$tenant->id})".PHP_EOL;
echo 'Inconsistências abertas no tenant: '.FamilyAddressInconsistency::withoutGlobalScopes()->where('tenant_id', $tenant->id)->where('status', 'open')->count().PHP_EOL;
