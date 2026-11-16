// SVG → PNG de la tarjeta de compartir, con resvg en WebAssembly (@resvg/resvg-wasm, MPL-2.0). Se ejecuta en un hilo
// de cálculo (workers/tasks.js): unos 50 ms por tarjeta, hasta 1,4 s con la VPS ocupada (medido el 16-11-2026), que
// en el hilo principal pararían la web.
//
// La versión WebAssembly y no la nativa (@resvg/resvg-js): la nativa no suelta el lienzo de cada tarjeta (unos 3 MB,
// 1200×630×4) ni con el recolector, y con 200 tarjetas ocupaba 680 MB. Con WebAssembly, liberando cada objeto con
// free(), la memoria se queda en unos 20 MB fijos (300 tarjetas seguidas, medido en la VPS).
//
// La letra: DejaVu Sans, del sistema (en la imagen de Docker, el paquete font-dejavu de Alpine; en Ubuntu,
// fonts-dejavu-core). Sin ella no hay tarjeta (la página de cada enlace enseña entonces la imagen general).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Dónde la deja cada sistema: Alpine (la imagen de Docker), Debian/Ubuntu y Fedora.
const FONT_DIRS = ['/usr/share/fonts/dejavu', '/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/dejavu-sans-fonts'];
const FONT_FILES = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'];
export const CARD_FONT = 'DejaVu Sans';

/** Los ficheros de la letra en este sistema, o null si no está. */
export function findCardFonts(dirs = FONT_DIRS) {
  for (const dir of dirs) {
    const files = FONT_FILES.map((f) => `${dir}/${f}`);
    if (files.every((f) => existsSync(f))) return files;
  }
  return null;
}

let ready = null; // { Resvg, fontBuffers }: una vez por hilo

async function load(fontFiles) {
  const { Resvg, initWasm } = await import('@resvg/resvg-wasm');
  await initWasm(await readFile(new URL(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))));
  const fontBuffers = await Promise.all(fontFiles.map((f) => readFile(f)));
  return { Resvg, fontBuffers };
}

/**
 * El PNG de una tarjeta. Rechaza si no hay letra o el SVG no se puede dibujar.
 * @param {string} svg
 * @param {string[]|null} [fontFiles]  por defecto, los que encuentra findCardFonts
 * @returns {Promise<Uint8Array>}
 */
export async function renderCardPng(svg, fontFiles = findCardFonts()) {
  if (!fontFiles?.length) throw new Error('No está la letra DejaVu Sans: sin tarjetas');
  if (!ready) ready = load(fontFiles).catch((err) => { ready = null; throw err; });
  const { Resvg, fontBuffers } = await ready;
  const resvg = new Resvg(svg, { fitTo: { mode: 'original' }, font: { fontBuffers, defaultFontFamily: CARD_FONT } });
  let image = null;
  try {
    image = resvg.render();
    // asPng devuelve una copia fuera de la memoria de WebAssembly: se puede liberar todo antes de devolverla.
    return image.asPng();
  } finally {
    image?.free();
    resvg.free();
  }
}
