// Metrotenerife: posición de los tranvías (backend de su web de información en tiempo
// real; no es un feed documentado como dato abierto y puede cambiar sin aviso).

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createTranviaTenerifeSource({ http }) {
  return {
    id: 'tranvia-tenerife',
    name: 'Tranvía de Tenerife',
    kind: 'vehicles',
    interval: 30_000,
    url: 'https://tranviaonline.metrotenerife.com/api/infoStops/vehicleLocation',
    license: 'Metrotenerife (endpoint público de su web, no documentado)',
    async fetch() {
      const list = await http.json(this.url);
      const vehicles = [];
      for (const t of Array.isArray(list) ? list : []) {
        const c = t.coordinate;
        if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
        vehicles.push({
          id: `tranvia-tenerife:${t.service}`,
          mode: 'tranvia',
          operator: 'Metrotenerife',
          service: 'Tranvía de Tenerife',
          line: t.route ? `L${t.route}` : null,
          label: t.service,
          lat: c.lat,
          lon: c.lon,
          delay: null,
          destination: t.destinationStopDescription ?? null,
          next: t.nextStopDescription ?? null,
          nextEta: null,
          nextInMinutes: t.remainingMinutes ?? null,
        });
      }
      return { vehicles };
    },
  };
}
