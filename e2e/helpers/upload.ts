import * as path from 'node:path';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

/**
 * Path absoluto para a fixture PNG 1x1 transparente (~68 bytes).
 *
 * Uso em specs:
 *   await page.locator('input[type="file"]').setInputFiles(avatarFixturePath());
 *
 * Para testar rejeição por tamanho (> 2MB), use `bigImageBuffer()` que gera
 * o buffer em memória sem precisar versionar um arquivo grande.
 */
export function avatarFixturePath(): string {
  return path.join(FIXTURES_DIR, 'avatar-1x1.png');
}

/**
 * Buffer de PNG inválido (extensão .jpg mas conteúdo de texto) — útil para
 * validar que o backend rejeita por MIME real (não pela extensão).
 */
export function fakeImageBuffer(): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: 'fake.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('this is plain text, not an image'),
  };
}

/**
 * Buffer de PNG válido com tamanho > 2MB para testar rejeição por size.
 * Header PNG válido + payload preenchido para chegar a ~3MB.
 *
 * NOTA: na prática, a validação `image` do Laravel pode rejeitar primeiro
 * por estrutura (chunks PNG inválidos). Para garantir 422 por SIZE, este
 * helper retorna um JPG válido inflado.
 */
export function oversizeImageBuffer(): { name: string; mimeType: string; buffer: Buffer } {
  // JPEG válido mínimo (SOI + APP0 + SOF0 + SOS + EOI) preenchido com bytes
  // de payload até passar 2MB.
  const padding = Buffer.alloc(3 * 1024 * 1024, 0xff);

  return {
    name: 'oversize.jpg',
    mimeType: 'image/jpeg',
    buffer: padding,
  };
}
