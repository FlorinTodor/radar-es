// Ferrocarrils de la Generalitat de Catalunya: posición de los trenes en servicio.
// Portal de datos abiertos de FGC (Opendatasoft), sin clave.
const BASE = 'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100';

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createFgcSource({ http }) {
  return {
    id: 'fgc',
    name: 'FGC (Ferrocarrils de la Generalitat de Catalunya)',
    kind: 'vehicles',
    interval: 30_000,
    url: BASE,
    license: 'Ferrocarrils de la Generalitat de Catalunya (CC BY 4.0). Formato adaptado',
    async fetch() {
      const vehicles = [];
      // La API pagina de 100 en 100; FGC rara vez pasa de 100 trenes, pero por si acaso.
      for (let offset = 0; offset < 500; offset += 100) {
        const d = await http.json(`${BASE}&offset=${offset}`);
        for (const r of d.results ?? []) {
          const p = r.geo_point_2d;
          if (!p || !Number.isFinite(p.lat)) continue;
          vehicles.push({
            id: `fgc:${r.ut || r.id}`,
            // L6, L7, L8, L12: servicio urbano tipo metro. S/R: suburbano.
            mode: /^L/.test(r.lin) ? 'metro' : 'cercanias',
            operator: 'FGC',
            service: 'FGC',
            line: r.lin,
            label: r.ut || r.lin,
            lat: p.lat,
            lon: p.lon,
            delay: null,
            late: r.en_hora === 'False' ? true : r.en_hora === 'True' ? false : null,
            origin: r.origen,
            destination: r.desti,
            current: r.estacionat_a || null,
            next: (r.properes_parades ?? '').match(/"parada":\s*"([^"]+)"/)?.[1] ?? null,
            rollingStock: r.tipus_unitat ? `Serie ${r.tipus_unitat}` : null,
          });
        }
        if ((d.results?.length ?? 0) < 100) break;
      }
      return { vehicles };
    },
  };
}
