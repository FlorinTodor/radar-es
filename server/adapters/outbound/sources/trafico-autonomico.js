// Tráfico de las comunidades con competencias propias, que la DGT no cubre del todo:
// Cataluña (Servei Català de Trànsit, GML) y Euskadi (Trafikoa, API JSON). Sin clave.
import { arr, madridLocalToMs, madridToday, num, text, xmlParser } from './parse.js';

// ---------- Cataluña ----------
const SCT_URL = 'https://www.gencat.cat/transit/opendata/incidenciesGML.xml';
const SCT_TYPES = { Obres: ['roadMaintenance', 'Obras'], 'Retenció': ['abnormalTraffic', 'Retención'], Accident: ['accident', 'Accidente'] };
const SCT_LEVEL = { 1: 'baja', 2: 'media', 3: 'alta', 4: 'alta', 5: 'muy alta' };

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createSctSource({ http }) {
  return {
    id: 'sct',
    name: 'Servei Català de Trànsit: incidencias',
    kind: 'events',
    interval: 300_000,
    url: SCT_URL,
    license: "Generalitat de Catalunya. Departament d'Interior i Seguretat Pública. Servei Català de Trànsit",
    async fetch() {
      const doc = xmlParser.parse(await http.text(SCT_URL));
      const events = [];
      for (const member of arr(doc.FeatureCollection?.featureMember)) {
        const f = member.mct2_v_afectacions_data;
        const [lon, lat] = (text(f?.geom?.Point?.coordinates) ?? '').split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const kind = text(f.descripcio_tipus) ?? '';
        const [type, label] = SCT_TYPES[kind] ?? ['otro', kind || 'Incidencia'];
        const level = num(text(f.nivell));
        const desc = text(f.descripcio) ?? '';
        const road = text(f.carretera);
        const km = num(text(f.pk_inici));
        events.push({
          id: `sct:${text(f.identificador)}`,
          category: 'carretera',
          type,
          severity: SCT_LEVEL[level] ?? 'media',
          closed: level === 5 || /tallad/i.test(desc),
          title: `${label}${road ? ` · ${road}` : ''}${km !== null ? ` km ${km.toFixed(1)}` : ''}`,
          description: [desc, text(f.causa), text(f.cap_a) && `sentido ${text(f.cap_a)}`].filter(Boolean).join(' · '),
          lat,
          lon,
          start: Date.parse(text(f.data)) || null,
        });
      }
      return { events };
    },
  };
}

// ---------- Euskadi ----------
const EUSKADI_URL = 'https://api.euskadi.eus/traffic/v1.0/incidences/byDate';
const EUSKADI_LEVEL = { Blanco: 'baja', Verde: 'baja', Amarillo: 'media', Rojo: 'alta', Negro: 'muy alta' };
const MAX_PAGES = 25;
// La API devuelve las incidencias del día sin hora de fin: los sucesos puntuales (accidentes,
// averías) se descartan pasadas unas horas para no mostrar como activos los ya resueltos.
const TRANSIENT_MAX_AGE_MS = 6 * 3600_000;

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createTraficoEuskadiSource({ http }) {
  return {
    id: 'trafico-euskadi',
    name: 'Tráfico Euskadi: incidencias del día',
    kind: 'events',
    interval: 300_000,
    url: EUSKADI_URL,
    license: 'Open Data Euskadi (CC BY 4.0)',
    async fetch() {
      const [y, m, d] = madridToday().split('-');
      const now = Date.now();
      const events = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await http.json(`${EUSKADI_URL}/${y}/${m}/${d}?_page=${page}`);
        for (const i of data.incidences ?? []) {
          const lat = num(i.latitude);
          const lon = num(i.longitude);
          if (lat === null || lon === null) continue;
          const isWork = /^obra/i.test(i.incidenceType ?? '');
          const start = madridLocalToMs(i.startDate);
          if (!isWork && start && now - start > TRANSIENT_MAX_AGE_MS) continue;
          const km = num(i.pkStart);
          events.push({
            id: `euskadi:${i.incidenceId}`,
            category: 'carretera',
            type: isWork ? 'roadMaintenance' : /accidente/i.test(i.incidenceType) ? 'accident' : 'otro',
            severity: EUSKADI_LEVEL[i.incidenceLevel] ?? 'media',
            closed: i.incidenceLevel === 'Negro',
            title: `${i.cause || i.incidenceType}${i.road ? ` · ${i.road}` : ''}${km !== null ? ` km ${km.toFixed(1)}` : ''}`,
            description: [i.incidenceType, i.cityTown, i.direction && `sentido ${i.direction}`].filter(Boolean).join(' · '),
            lat,
            lon,
            start,
          });
        }
        if (page >= (data.totalPages ?? 1)) break;
      }
      return { events };
    },
  };
}
