// Rodalies de Catalunya: estado del servicio por línea, del RSS de datos abiertos de la Generalitat
// ("Estat del servei de Rodalies de Catalunya", Llicència oberta d'ús d'informació – Catalunya).
// Las cancelaciones tren a tren salen del GTFS-RT de Renfe (fuente renfe-avisos). La API interna de
// la app de Rodalies no se usa: no está publicada como datos abiertos ni tiene licencia.
import { arr, text, xmlParser } from './parse.js';

const RSS = 'https://www.gencat.cat/rodalies/incidencies_rodalies_rss_es_ES.xml';
const NORMAL = /normalidad|servicio normal|sin incidencias/i;
const SEVERE = /suprim|cancel|anul|interrump|cortad|carretera|sin servicio/i;
// Recuadro de Cataluña para buscar la estación que nombra cada aviso.
const IN_CATALONIA = (s) => s.lat > 40.5 && s.lon > 0.15;

const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s-]+/g, ' ');

/**
 * @param {{ http: import('../http/http-client.js').HttpClient,
 *           stations: import('../../../application/ports.js').StationCatalogPort }} deps
 */
export function createRodaliesSource({ http, stations }) {
  /** Primera estación de Cataluña que menciona el texto, para situar el aviso en el mapa. */
  function locate(description) {
    const haystack = norm(description);
    let best = null;
    for (const s of stations.all()) {
      if (!IN_CATALONIA(s) || s.name.length < 5) continue;
      const at = haystack.indexOf(norm(s.name));
      if (at >= 0 && (!best || at < best.at)) best = { at, s };
    }
    return best?.s ?? null;
  }

  return {
    id: 'rodalies',
    name: 'Rodalies de Catalunya: estado del servicio por línea',
    kind: 'events',
    interval: 180_000,
    url: RSS,
    license: "Generalitat de Catalunya. Departament de Territori, Habitatge i Transició Ecològica · Llicència oberta d'ús d'informació – Catalunya",
    async fetch() {
      const channel = xmlParser.parse(await http.text(RSS)).rss?.channel;
      const events = [];
      for (const item of arr(channel?.item)) {
        const title = text(item.title) ?? '';
        const description = (text(item.description) ?? title).trim();
        if (!description || NORMAL.test(description)) continue;
        // El título empieza por "Línea R14,R13." y repite el texto recortado.
        const lines = /^L[ií]nea\s+([^.]+)\./i.exec(title)?.[1].split(',').map((l) => l.trim()).filter(Boolean) ?? [];
        const at = locate(description);
        events.push({
          id: `rodalies:${lines.join('-')}:${norm(description).slice(0, 80)}`,
          category: 'ferroviario',
          type: 'aviso',
          severity: SEVERE.test(description) ? 'alta' : 'media',
          title: lines.length ? `Rodalies · ${lines.join(', ')}` : 'Aviso Rodalies',
          description,
          lat: at?.lat ?? null,
          lon: at?.lon ?? null,
          start: Date.parse(text(item.pubDate) ?? '') || null,
        });
      }
      return { events, sourceTime: Date.parse(text(channel?.lastBuildDate) ?? '') || null };
    },
  };
}
