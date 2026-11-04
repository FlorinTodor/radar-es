// Instituto Geográfico Nacional: terremotos de los últimos 10 días, de su servicio oficial de
// visualización INSPIRE de geofísica (capa «Terremotos últimos 10 días», que también se sirve en GeoJSON).
// Sin clave. Trae todos, desde magnitud 1, con la localización que les pone el propio IGN («NE GÓJAR.GR»,
// «GOLFO DE CÁDIZ»); el RSS sólo trae los de magnitud 2,6 o más. Licencia CC BY 4.0 ign.es (la que
// declara el servicio en sus GetCapabilities y la del catálogo). Se muestran los de los dos últimos días
// (domain/sismos.js).
import { SPAIN_BOUNDS, widenBounds } from '../../../domain/geo.js';
import { MIN_QUAKE_MAGNITUDE, quakeExpires, quakeSeverity, quakeWhen } from '../../../domain/sismos.js';
import { ignPlace } from './ign-place.js';
import { num } from './parse.js';

// La misma zona que el EMSC (emsc-sismos.js). En WMS 1.3.0 con EPSG:4326 la caja va en latitud, longitud.
const [WEST, SOUTH, EAST, NORTH] = widenBounds(SPAIN_BOUNDS, 1);
const URL = 'https://www.ign.es/wms-inspire/geofisica?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
  + `&LAYERS=Ultimos10dias&STYLES=&CRS=EPSG:4326&BBOX=${SOUTH},${WEST},${NORTH},${EAST}&WIDTH=1000&HEIGHT=1000`
  + `&FORMAT=${encodeURIComponent('application/json;type=geojson')}`;
const PAGE = 'https://www.ign.es/web/ign/portal/ultimos-terremotos';
// CloudFront guarda las respuestas del WMS (que no traen Cache-Control) 20 min o más: medido el
// 4-nov-2026, un terremoto de las 18:43 UTC seguía sin salir a las 19:14. El RSS del IGN, en cambio, pide
// que se guarde 2 min (s-maxage=120). Con un parámetro que cambia en cada lectura (GeoServer ignora los
// que no conoce) se lee la capa como está; dos servidores en los mismos 3 min comparten la copia.
const READ_MS = 180_000;
const DETAILS = 'https://www.ign.es/web/ign/portal/ultimos-terremotos/-/ultimos-terremotos/getDetails?evid=';

// «04/11/2026 17:34:26», en UTC (contrastado con el EMSC: la misma hora, al segundo).
const DATE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;

/** @param {{ http: import('../http/http-client.js').HttpClient, now?: () => number }} deps */
export function createIgnSismosSource({ http, now = Date.now }) {
  return {
    id: 'ign-sismos',
    name: 'IGN terremotos (magnitud 1,5 o más, últimos 2 días)',
    kind: 'events',
    interval: READ_MS,
    url: URL,
    page: PAGE,
    license: 'Obra derivada de Catálogo de terremotos IGN · CC-BY 4.0 ign.es · Instituto Geográfico Nacional (IGN). Catálogo de terremotos. https://doi.org/10.7419/162.03.2022',
    async fetch() {
      const doc = await http.json(`${URL}&LECTURA=${Math.floor(now() / READ_MS)}`, { timeout: 30_000 });
      const events = [];
      for (const f of Array.isArray(doc?.features) ? doc.features : []) {
        const p = f?.properties ?? {};
        const [lon, lat] = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates.map(num) : [];
        const magnitude = num(p.magnitud);
        const d = DATE.exec(String(p.fecha ?? ''));
        const start = d ? Date.UTC(+d[3], +d[2] - 1, +d[1], +d[4], +d[5], +d[6]) : NaN;
        const evid = /[?&]evid=(\w{1,40})/.exec(String(p.info ?? ''))?.[1];
        if (lat == null || lon == null || magnitude === null || !Number.isFinite(start) || !evid) continue;
        if (magnitude < MIN_QUAKE_MAGNITUDE) continue;
        const place = ignPlace(p['localización']) ?? { text: 'zona sin nombre', near: false };
        const depth = num(p.profundidad);
        // Intensidad con la que se sintió (escala EMS-98, en números romanos), si se sintió.
        const felt = String(p.intensidad ?? '').trim();
        events.push({
          id: `ign:${evid}`,
          category: 'sismo',
          type: 'terremoto',
          severity: quakeSeverity(magnitude),
          title: `Terremoto M${magnitude.toFixed(1)} · ${place.text}`,
          description: `Terremoto de magnitud ${magnitude.toFixed(1)}${depth ? ` a ${Math.round(Math.abs(depth))} km de profundidad` : ''}`
            + `${place.near ? `, ${place.text},` : ` (${place.text}),`} el ${quakeWhen(start, lat, lon)}. Localizado por el Instituto Geográfico Nacional (IGN).`
            + `${/^[IVX]{1,5}(-[IVX]{1,5})?$/.test(felt) ? ` Se sintió con intensidad ${felt}.` : ''}`,
          magnitude,
          lat,
          lon,
          start,
          expires: quakeExpires(start),
          url: `${DETAILS}${evid}`,
        });
      }
      return { events };
    },
  };
}
