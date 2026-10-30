// Renfe: posiciones de Cercanías/Rodalies y de AV/Larga/Media Distancia (feeds de sus
// visores públicos) y avisos de servicio (GTFS-RT Service Alerts). Sin clave.
import { madridLocalToMs, num } from './parse.js';

// Tabla de productos extraída del propio visor de Renfe (tiempo-real.largorecorrido.renfe.com).
const PRODUCTS = {
  0: ['Movimientos', 'otros'], 2: ['AVE', 'av'], 3: ['Avant', 'av'], 4: ['Talgo', 'ld'], 5: ['Altaria', 'ld'],
  7: ['Diurno', 'ld'], 8: ['Estrella', 'ld'], 9: ['Tren Hotel', 'ld'], 10: ['Euromed', 'ld'], 11: ['Alvia', 'ld'],
  13: ['Intercity', 'ld'], 14: ['Andalucía Express', 'md'], 15: ['Catalunya Express', 'md'], 16: ['Media Distancia', 'md'],
  18: ['Regional', 'md'], 19: ['Regional Exprés', 'md'], 20: ['TRD', 'md'], 21: ['Cercanías', 'cercanias'],
  22: ['Tren Histórico', 'otros'], 23: ['Tren Turístico', 'otros'], 24: ['AV City', 'ld'], 25: ['AVE TGV', 'av'],
  26: ['Tranvía', 'tranvia'], 27: ['Euskotren', 'md'], 28: ['Avlo', 'av'], 29: ['Tren Temático', 'otros'],
};

const INCIDENT_WORDS = /suspend|interrump|cortad|incidencia|avería|accidente/i;
const GTFSRT = 'https://gtfsrt.renfe.com';

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, stations: import('../../../application/ports.js').StationCatalogPort }} deps
 * @returns {import('../../../application/ports.js').DataSourcePort[]}
 */
export function createRenfeSources({ http, stations }) {
  const cercanias = {
    id: 'renfe-cercanias',
    name: 'Renfe Cercanías / Rodalies (visor + GTFS-RT)',
    kind: 'vehicles',
    interval: 20_000,
    url: 'https://tiempo-real.renfe.com/renfe-visor/flota.json',
    license: 'Datos públicos de Renfe',
    async fetch() {
      // El visor trae retraso y estaciones, pero omite ~1 de cada 4 trenes (muchos esperando en
      // andén) que sí están en el GTFS-RT oficial. Se combinan ambos.
      const [visor, positions, updates] = await Promise.allSettled([
        http.json(this.url),
        http.json(`${GTFSRT}/vehicle_positions.json`),
        http.json(`${GTFSRT}/trip_updates.json`),
      ]);
      if (visor.status === 'rejected' && positions.status === 'rejected') throw visor.reason;
      const d = visor.status === 'fulfilled' ? visor.value : {};
      const vehicles = [];
      const seen = new Set();
      for (const t of d.trenes ?? []) {
        if (!Number.isFinite(t.latitud) || !Number.isFinite(t.longitud)) continue;
        seen.add(t.tripId);
        vehicles.push({
          id: `renfe-c:${t.tripId || t.codTren}`,
          mode: 'cercanias',
          operator: 'Renfe',
          service: 'Cercanías',
          line: t.codLinea || null,
          label: t.codTren,
          lat: t.latitud,
          lon: t.longitud,
          delay: num(t.retrasoMin),
          origin: stations.name(t.codEstOrig),
          destination: stations.name(t.codEstDest),
          current: stations.name(t.codEstAct),
          next: stations.name(t.codEstSig),
          nextEta: t.horaLlegadaSigEst || null,
          platform: t.via || null,
          area: stations.get(t.codEstAct)?.place ?? stations.get(t.codEstSig)?.place ?? null,
          accessible: !!t.accesible,
        });
      }

      if (positions.status === 'fulfilled') {
        // GTFS-RT: el retraso viene en segundos en trip_updates.
        const delays = new Map(updates.status === 'fulfilled'
          ? (updates.value.entity ?? []).map((e) => [e.tripUpdate?.trip?.tripId, e.tripUpdate?.delay])
          : []);
        for (const e of positions.value.entity ?? []) {
          const v = e.vehicle;
          const tripId = v?.trip?.tripId;
          const pos = v?.position;
          if (!tripId || seen.has(tripId) || !Number.isFinite(pos?.latitude) || !Number.isFinite(pos?.longitude)) continue;
          // Etiqueta "C5-23737-PLATF.(5)": línea, número de tren y vía en la que espera.
          const [, line, number, platform] = /^([A-Za-z]+\d*[a-z]?)-(\d+)(?:-PLATF\.\((\w+)\))?/.exec(v.vehicle?.label ?? '') ?? [];
          const stopped = v.currentStatus === 'STOPPED_AT';
          const delay = num(delays.get(tripId));
          vehicles.push({
            id: `renfe-c:${tripId}`,
            mode: 'cercanias',
            operator: 'Renfe',
            service: 'Cercanías',
            line: line ?? null,
            label: number ?? v.vehicle?.id ?? tripId,
            lat: pos.latitude,
            lon: pos.longitude,
            delay: delay === null ? null : Math.round(delay / 60),
            origin: null,
            destination: null,
            current: stopped ? stations.name(v.stopId) : null,
            next: stopped ? null : stations.name(v.stopId),
            platform: platform ?? null,
            area: stations.get(v.stopId)?.place ?? null,
            fixTime: v.timestamp ? +v.timestamp * 1000 : null,
          });
        }
      }
      return { vehicles, sourceTime: madridLocalToMs(d.fechaActualizacion) };
    },
  };

  const largaDistancia = {
    id: 'renfe-ld',
    name: 'Renfe Alta Velocidad, Larga y Media Distancia',
    kind: 'vehicles',
    interval: 20_000,
    url: 'https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json',
    license: 'Datos públicos de Renfe',
    async fetch() {
      const d = await http.json(this.url);
      const vehicles = [];
      for (const t of d.trenes ?? []) {
        if (!Number.isFinite(t.latitud) || !Number.isFinite(t.longitud)) continue;
        const [service, mode] = PRODUCTS[t.codProduct] ?? [`Producto ${t.codProduct}`, 'otros'];
        vehicles.push({
          id: `renfe-ld:${t.codComercial}`,
          mode,
          operator: 'Renfe',
          service,
          line: service,
          label: t.codComercial,
          lat: t.latitud,
          lon: t.longitud,
          delay: num(t.ultRetraso),
          origin: stations.name(t.codOrigen),
          destination: stations.name(t.codDestino),
          current: stations.name(t.codEstAnt),
          next: stations.name(t.codEstSig),
          nextEta: t.horaLlegadaSigEst || null,
          rollingStock: t.mat || null,
          accessible: !!t.accesible,
          // Hora del último GPS del tren: permite distinguir "parado" de "sin señal".
          fixTime: t.time ? t.time * 1000 : null,
        });
      }
      return { vehicles, sourceTime: madridLocalToMs(d.fechaActualizacion) };
    },
  };

  const avisos = {
    id: 'renfe-avisos',
    name: 'Renfe avisos de servicio (GTFS-RT)',
    kind: 'events',
    interval: 120_000,
    url: 'https://gtfsrt.renfe.com/alerts.json',
    license: 'Datos públicos de Renfe (GTFS-RT)',
    async fetch() {
      const d = await http.json(this.url);
      const now = Date.now() / 1000;
      const events = [];
      for (const e of d.entity ?? []) {
        const a = e.alert;
        if (!a) continue;
        const periods = a.activePeriod ?? [];
        const active = !periods.length || periods.some((p) => (!p.start || +p.start <= now) && (!p.end || +p.end >= now));
        if (!active) continue;
        const translations = a.descriptionText?.translation ?? a.headerText?.translation ?? [];
        const description = ((translations.find((t) => !t.language || t.language.startsWith('es')) ?? translations[0])?.text ?? '').trim();
        // Si el aviso referencia una estación, lo ubicamos en el mapa.
        const stop = (a.informedEntity ?? []).map((ie) => stations.get(ie.stopId)).find(Boolean);
        const lines = [...new Set((a.informedEntity ?? []).map((ie) => ie.routeId?.match(/C\d+[a-z]?|R\d+[A-Z]?|RT?\d+/)?.[0]).filter(Boolean))];
        events.push({
          id: `renfe-aviso:${e.id}`,
          category: 'ferroviario',
          type: 'aviso',
          severity: INCIDENT_WORDS.test(description) ? 'alta' : 'media',
          title: lines.length ? `Aviso Renfe · ${lines.join(', ')}` : 'Aviso Renfe',
          description,
          lat: stop?.lat ?? null,
          lon: stop?.lon ?? null,
          start: periods[0]?.start ? +periods[0].start * 1000 : null,
          end: periods[0]?.end ? +periods[0].end * 1000 : null,
        });
      }
      return { events, sourceTime: d.header?.timestamp ? +d.header.timestamp * 1000 : null };
    },
  };

  return [cercanias, largaDistancia, avisos];
}
