// Fuentes de avisos oficiales de emergencias: cada una lee su formato tal y como lo publica su
// administración (con los mismos campos y rarezas que el original) y da los avisos en vigor.
// Sin red ni esperas: http y geocodificador falsos y el reloj de cada fuente fijado (`now`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDITS, createAndaluciaEmergenciasSource, createBalearsPremsaSource, createCanariasAlertasSource, createCatalunaPlansSource, createClmPlansSource,
  createCyl112Source, createRiojaSosSource, decodeXml, firstItems, parseCanariasAlertas, parseCatalunaPlans, parseClmPlans, parseRiojaSos,
} from '../../server/adapters/outbound/sources/emergencias-oficiales.js';
import { CUT_MAX_AGE, PLAN_MAX_AGE } from '../../server/domain/emergencias.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 3_600_000;
const clock = () => NOW;
const fakeHttp = (byUrl) => ({
  text: async (url) => { const body = byUrl(url); if (body instanceof Error) throw body; return body; },
  json: async (url) => { const body = byUrl(url); if (body instanceof Error) throw body; return body; },
});
// Geocodificador falso: conoce unos cuantos pueblos y apunta qué le preguntan.
function fakeGeocoder(known) {
  const calls = [];
  return {
    calls,
    async locate(name, scope) {
      calls.push({ name, ...scope });
      return known[name] ? { name, lat: known[name][0], lon: known[name][1] } : null;
    },
  };
}
const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>RSS</title>${items}</channel></rss>`;

// ---------- Canarias ----------
const canariasItem = ({ p, title, date, body = '', desc = '' }) => `<item><title>${title}</title>
  <link>https://www3.gobiernodecanarias.org/noticias/aviso-${p}/</link><pubDate>${date}</pubDate>
  <guid isPermaLink="false">https://www3.gobiernodecanarias.org/noticias/?p=${p}</guid>
  <category><![CDATA[Alertas]]></category><description><![CDATA[${desc}]]></description>
  <content:encoded><![CDATA[${body}]]></content:encoded></item>`;
const CANARIAS_XML = rss([
  canariasItem({
    p: 900, title: 'El Gobierno actualiza la situación a alerta por lluvias en La Palma, La Gomera y El Hierro', date: 'Mon, 02 Nov 2026 09:07:25 +0000',
    body: '<p>Municipios o ámbitos afectados: La Palma, La Gomera y El Hierro</p>',
  }),
  canariasItem({
    p: 899, title: 'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma', date: 'Mon, 02 Nov 2026 07:49:18 +0000',
    // El texto libre dice «La Gomera» por error; el campo de ámbito dice La Palma.
    body: '<p>La Dirección General de Emergencias, en base a la situación acaecida de cero energético que afecta a la isla de La Gomera, declara la situación de alerta.</p>'
      + '<p><strong>Municipios o ámbitos afectados:</strong> Isla de La Palma</p>'
      + '<p><strong>Observaciones:</strong> A las 06:42 h se ha producido un fallo general del sistema eléctrico en la isla de La Palma (cero energético), perdiéndose completamente el suministro de electricidad en la isla.</p>',
  }),
  canariasItem({ p: 898, title: 'El Gobierno de Canarias declara la Alerta Máxima por lluvias en La Palma', date: 'Mon, 02 Nov 2026 02:59:00 +0000' }),
  canariasItem({ p: 890, title: 'El Gobierno de Canarias finaliza la situación de prealerta por calima en el archipiélago', date: 'Thu, 29 Oct 2026 10:08:00 +0000' }),
  canariasItem({ p: 880, title: 'El Gobierno de Canarias declara la situación de prealerta por calima en todo el Archipiélago', date: 'Mon, 26 Oct 2026 12:44:00 +0000' }),
  canariasItem({ p: 870, title: 'El Gobierno de Canarias analiza el estado de las infraestructuras y barrancos ante la próxima temporada de lluvias', date: 'Mon, 02 Nov 2026 08:00:00 +0000' }),
].join(''));

test('Canarias: el apagón de La Palma en su isla (la del campo de ámbito, no la del texto), con sus observaciones', async () => {
  const src = createCanariasAlertasSource({ http: fakeHttp(() => CANARIAS_XML), now: clock });
  const { events, sourceTime } = await src.fetch();
  const cut = events.find((e) => e.power);
  assert.equal(cut.id, 'emergencias-canarias:899:la-palma');
  assert.equal(cut.type, 'apagon');
  assert.equal(cut.area, 'La Palma');
  assert.equal(cut.approx, 'isla');
  assert.equal(cut.severity, 'alta');
  assert.match(cut.description, /^A las 06:42 h se ha producido un fallo general/);
  assert.equal(cut.credit, 'Fuente: Gobierno de Canarias');
  assert.equal(cut.issued, Date.parse('2026-11-02T07:49:18Z'));
  assert.equal(sourceTime, Date.parse('2026-11-02T09:07:25Z'), 'la fecha de actualización es la del último aviso publicado');
  assert.match(src.license, /^Fuente: Gobierno de Canarias · CC BY 4\.0/);
});

test('Canarias: la alerta por lluvias más nueva sustituye a la anterior; la calima ya finalizó; lo que no es un aviso no entra', async () => {
  const { events } = await createCanariasAlertasSource({ http: fakeHttp(() => CANARIAS_XML), now: clock }).fetch();
  const rain = events.filter((e) => !e.power).map((e) => `${e.area}:${e.severity}:${e.id.split(':')[1]}`).sort();
  assert.deepEqual(rain, ['El Hierro:alta:900', 'La Gomera:alta:900', 'La Palma:alta:900']);
  assert.ok(events.every((e) => e.group === `emergencias-canarias:${e.id.split(':')[1]}`));
  assert.equal(parseCanariasAlertas(CANARIAS_XML).notices.some((n) => /infraestructuras/.test(n.title)), false);
});

// ---------- Cataluña ----------
test('Cataluña: planes activos con su fase y su fecha (día/mes), el PDF del CECAT y la fecha de actualización', async () => {
  const rows = [
    {
      plaicona: { url: 'https://documents.dadesobertes.gencat.cat/cecat/docs/ico_INUNCAT.png' }, plaacronim: 'INUNCAT', planom: 'INUNCAT',
      plafase: 'ALERTA', plaactivat: 'SI', fasedatahora: '02/11/2026 12:07',
      comunicatpdf: { url: 'https://documents.dadesobertes.gencat.cat/cecat/docs/I-128574_INICI--ACTIVAT_INUNCAT_202611021221.pdf' },
      descripcio: 'SMP - Intensitat de pluja en 30 minuts 2 i 3/11 - ',
    },
    { plaacronim: 'NEUCAT', planom: 'NEUCAT', plafase: 'PREALERTA', plaactivat: 'NO', fasedatahora: '01/11/2026 08:00' },
  ];
  const src = createCatalunaPlansSource({ http: fakeHttp((url) => (url.includes('/api/views/') ? { rowsUpdatedAt: 1793618770 } : rows)) });
  const { events, sourceTime } = await src.fetch();
  assert.equal(events.length, 1, 'el plan desactivado no cuenta');
  const [e] = events;
  assert.equal(e.title, 'INUNCAT · ALERTA');
  assert.equal(e.severity, 'alta');
  assert.equal(e.issued, Date.parse('2026-11-02T11:07:00Z'), '02/11 a las 12:07 de Madrid, no el 11 de febrero');
  assert.match(e.url, /INUNCAT_202611021221\.pdf$/);
  assert.equal(e.area, 'Cataluña');
  assert.equal(e.approx, 'comunidad');
  assert.equal(e.icon, undefined, 'sus iconos no se usan');
  assert.equal(sourceTime, 1793618770_000);
  assert.equal(e.credit, CREDITS['emergencias-cataluna']);
});

test('Cataluña: sin planes activos, nada; si falla la ficha del conjunto, los planes se ven igual', async () => {
  assert.deepEqual(parseCatalunaPlans([]), []);
  const src = createCatalunaPlansSource({ http: fakeHttp((url) => (url.includes('/api/views/') ? new Error('HTTP 500') : [{ planom: 'PROCICAT', plafase: 'EMERGÈNCIA', plaactivat: 'SI', descripcio: 'Apagada elèctrica generalitzada' }])) });
  const { events, sourceTime } = await src.fetch();
  assert.equal(sourceTime, null);
  assert.equal(events[0].type, 'apagon');
  assert.equal(events[0].severity, 'muy alta');
});

// ---------- Andalucía ----------
const andaluciaNews = (results) => ({ results, pagination: { total_items: results.length } });
const NEWS = andaluciaNews([
  {
    id: 'GeNews-300', title: 'La cifra de emergencias en relación a las borrascas se eleva a 10.613', subtitle: 'El 1-1-2 mantiene el operativo',
    publication_date: '2026-11-02T08:00:00.000Z', update_date: '2026-11-02T09:30:00.000Z',
    path: { uri: 'https://www.juntadeandalucia.es/presidencia/portavoz/emergencias112/300' },
    photo: { uri: 'https://www.juntadeandalucia.es/imagenes/portavoz/foto.jpg', name: 'Logo' },
    body: '<p>En <strong>Benamahoma</strong> el ayuntamiento informó que toda la población estaba anoche sin suministro eléctrico ni cobertura desde la tarde de ayer.</p>'
      + '<p>Hay falta de suministro eléctrico en Espera y San José del Valle, mientras que en Puerto Serrano ya se ha recuperado tanto la luz como la cobertura.</p>',
  },
  {
    id: 'GeNews-301', title: 'La Junta activa la fase de preemergencia del Plan de Emergencia ante el Riesgo de Inundaciones en Cádiz', subtitle: 'Por las lluvias previstas',
    publication_date: '2026-11-02T07:00:00.000Z', path: { uri: 'https://www.juntadeandalucia.es/presidencia/portavoz/emergencias112/301' }, body: '<p>Sin incidencias graves.</p>',
  },
  {
    id: 'GeNews-200', title: 'Restablecido el suministro eléctrico en Benamahoma', subtitle: '',
    publication_date: '2026-10-30T07:00:00.000Z', path: { uri: 'x' }, body: '<p>En Benamahoma se ha restablecido el suministro eléctrico.</p>',
  },
  { id: 'GeNews-302', title: 'Dos personas evacuadas al hospital tras un incendio de vivienda en Puente Genil', publication_date: '2026-11-01T13:16:00.000Z', body: '<p>Sin más.</p>' },
]);

test('Andalucía: cortes de luz en los pueblos que cita la noticia, situados con CartoCiudad; la luz que vuelve no cuenta', async () => {
  const geocoder = fakeGeocoder({ Benamahoma: [36.77, -5.47], Espera: [36.87, -5.8], 'San José del Valle': [36.61, -5.8], 'Puerto Serrano': [36.92, -5.54] });
  const src = createAndaluciaEmergenciasSource({ http: fakeHttp(() => NEWS), geocoder, now: clock });
  const { events, sourceTime } = await src.fetch();
  const cuts = events.filter((e) => e.power).map((e) => `${e.area}:${e.approx}`).sort();
  assert.deepEqual(cuts, ['Benamahoma:municipio', 'Espera:municipio', 'San José del Valle:municipio'], 'en Puerto Serrano ya ha vuelto');
  assert.ok(geocoder.calls.every((c) => c.region === '01'), 'sólo pueblos de Andalucía');
  const benamahoma = events.find((e) => e.area === 'Benamahoma');
  assert.equal(benamahoma.lat, 36.77);
  assert.match(benamahoma.description, /toda la población estaba anoche sin suministro eléctrico/);
  assert.equal(benamahoma.url, 'https://www.juntadeandalucia.es/presidencia/portavoz/emergencias112/300');
  assert.equal(benamahoma.credit, 'Información obtenida del Portal de la Junta de Andalucía');
  assert.ok(events.every((e) => !JSON.stringify(e).includes('foto.jpg')), 'las fotos no se usan');
  assert.equal(sourceTime, Date.parse('2026-11-02T09:30:00Z'));
});

test('Andalucía: el plan activado en su provincia; las noticias que no son ni planes ni cortes no entran', async () => {
  const { events } = await createAndaluciaEmergenciasSource({ http: fakeHttp(() => NEWS), geocoder: fakeGeocoder({}), now: clock }).fetch();
  const plan = events.find((e) => e.type === 'plan');
  assert.equal(plan.area, 'Cádiz');
  assert.equal(plan.approx, 'provincia');
  assert.equal(plan.severity, 'alta');
  assert.ok(!events.some((e) => /Puente Genil/.test(e.title)));
  // Sin geocodificar ningún pueblo, los cortes quedan en el centro de Andalucía, sin perderse.
  assert.ok(events.some((e) => e.power && e.approx === 'comunidad' && e.area === 'Andalucía'));
});

// ---------- Castilla-La Mancha ----------
const clmItem = (slug, title, iso) => `<item><title>${title}</title><link>https://112.castillalamancha.es/112/emergencias-e-incidencias/${slug}</link>
  <description>${title}&lt;span class="field field--name-uid"&gt;&lt;span&gt;omgf04&lt;/span&gt;&lt;/span&gt; &lt;time datetime="${iso}" class="datetime"&gt;x&lt;/time&gt; &lt;div class="social-sharing-buttons"&gt;¿Te ha gustado? Comparte:&lt;/div&gt;</description>
  <pubDate>Wed, 28 Oct 2026 09:07:53 +0000</pubDate></item>`;

test('Castilla-La Mancha: planes por provincia con la fecha de su publicación; nunca el usuario que lo publicó', async () => {
  const xml = rss([
    clmItem('platecam-activado-en-la-provincia-de-toledo', 'PLATECAM, activado en la provincia de Toledo', '2026-11-02T10:07:53+01:00'),
    clmItem('meteocam-cuenca-y-guadalajara', 'METEOCAM. Cuenca y Guadalajara', '2026-11-01T20:57:22+01:00'),
    clmItem('meteocam-desactivado-en-guadalajara', 'METEOCAM, desactivado en Guadalajara', '2026-11-02T08:00:00+01:00'),
  ].join(''));
  const { events, sourceTime } = await createClmPlansSource({ http: fakeHttp(() => xml), now: clock }).fetch();
  assert.deepEqual(events.map((e) => e.area).sort(), ['Cuenca', 'Toledo'], 'Guadalajara ya se desactivó');
  const toledo = events.find((e) => e.area === 'Toledo');
  assert.equal(toledo.issued, Date.parse('2026-11-02T09:07:53Z'));
  assert.equal(toledo.description, '');
  assert.ok(events.every((e) => !JSON.stringify(e).includes('omgf04')));
  assert.equal(sourceTime, Date.parse('2026-11-02T09:07:53Z'));
});

test('Castilla-La Mancha: un corte de luz ya caducado no tapa la alerta de su provincia que sigue en vigor', async () => {
  // El fallo de la auditoría: el corte de hace 30 h (un día de vigencia) ocupaba el sitio de la alerta
  // de hace 40 h (cuatro días) y, al quitarlo después por viejo, Toledo se quedaba sin nada.
  const iso = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();
  const xml = rss([
    clmItem('corte-de-luz-en-toledo', 'Corte de luz en Toledo', iso(30)),
    clmItem('meteocam-alerta-toledo', 'METEOCAM. Activada la alerta en la provincia de Toledo', iso(40)),
  ].join(''));
  const { events } = await createClmPlansSource({ http: fakeHttp(() => xml), now: clock }).fetch();
  assert.deepEqual(events.map((e) => `${e.title} @ ${e.area}`), ['METEOCAM. Activada la alerta en la provincia de Toledo @ Toledo']);
  assert.equal(events[0].approx, 'provincia');
  assert.equal(events[0].type, 'plan');
});

test('Castilla-La Mancha: sólo sus provincias, sacadas de la tabla de lugares', async () => {
  const xml = rss(clmItem('meteocam-x', 'METEOCAM. Toledo y Cuenca, como en Sevilla', '2026-11-02T10:00:00+01:00'));
  const { events } = await createClmPlansSource({ http: fakeHttp(() => xml), now: clock }).fetch();
  assert.deepEqual(events.map((e) => e.area).sort(), ['Cuenca', 'Toledo']);
});

// ---------- La Rioja ----------
const riojaItem = (slug, title, when, text) => `<item><title>${title}</title>
  <link>https://www.larioja.org/emergencias-112/es/noticias-sos-rioja/todas-noticias/noticias-sos/${slug}</link>
  <description><![CDATA[<div class="modelAgendaSos templateHtmlList"><div class="contentName"><!--[LINK]-->${title}<!--[/LINK]--></div><div class="fecha_sos">${when}</div><div class="contentText"><p class="cmParagraph"><span>${text}</span></p></div></div>]]></description>
  <pubDate>Tue, 27 Oct 2026 12:00:00 +0100</pubDate></item>`;
const RIOJA_CUT = riojaItem('averia-suministro-electrico-1a', 'Avería que afecta a suministro eléctrico y telefónico', '2/11/2026 a las 09:16 en Ventrosa',
  'Iberdrola informa a SOS Rioja 112 de una avería que afecta a Mansilla, Villavelayo, Ventrosa, Brieva y Las Viniegras.');
const RIOJA_BACK = riojaItem('restablecido-suministro-1b', 'Restablecido el suministro eléctrico', '2/11/2026 a las 11:00 en Ventrosa',
  'Iberdrola comunica que se ha restablecido el suministro eléctrico en Ventrosa.');
const RIOJA_OTHER = riojaItem('colision-1c', 'Colisión de un turismo con un patinete', '2/11/2026 a las 08:02 en Logroño', 'Un particular alerta a SOS RIOJA 112.');

test('La Rioja: la avería en los pueblos que cita, con la hora del suceso (no la del RSS)', async () => {
  const geocoder = fakeGeocoder({ Ventrosa: [42.16, -2.85], Brieva: [42.16, -2.88] });
  const src = createRiojaSosSource({ http: fakeHttp(() => rss(RIOJA_CUT + RIOJA_OTHER)), geocoder, now: clock });
  const { events, sourceTime } = await src.fetch();
  assert.deepEqual(events.map((e) => e.area).sort(), ['Brieva', 'Ventrosa']);
  assert.ok(events.every((e) => e.issued === Date.parse('2026-11-02T08:16:00Z')));
  assert.ok(geocoder.calls.every((c) => c.region === '17'));
  assert.match(events[0].url, /^https:\/\/www\.larioja\.org\/emergencias-112\//);
  assert.equal(sourceTime, Date.parse('2026-11-02T08:16:00Z'), 'la incidencia más reciente (las 08:02 o las 09:16), no el pubDate');
});

test('La Rioja: «Restablecido el suministro eléctrico» cierra la avería', async () => {
  const geocoder = fakeGeocoder({ Ventrosa: [42.16, -2.85], Brieva: [42.16, -2.88] });
  const { events } = await createRiojaSosSource({ http: fakeHttp(() => rss(RIOJA_BACK + RIOJA_CUT)), geocoder, now: clock }).fetch();
  assert.deepEqual(events.map((e) => e.area), [], 'la vuelta en Ventrosa cierra la avería entera, también en Brieva');
});

// ---------- Castilla y León ----------
const cylItem = (id, title, desc, date) => `<item><title>${title}</title><description>${desc}</description><pubDate>${date}</pubDate>
  <link><![CDATA[https://112.jcyl.es/web/jcyl/112/es/Plantilla100Detalle/1284178030391/Incidente/${id}/Emergencia?utm_source=suscripcion&utm_medium=rss]]></link></item>`;

test('Castilla y León: guarda el corte aunque el feed (de una sola entrada) ya publique otra cosa, y lo suelta al día', async () => {
  let feed = rss(cylItem('1285694676100', 'Sin suministro eléctrico varias localidades de la comarca',
    'Riaño (Le&amp;oacute;n) - El Centro Coordinador de Emergencias informa de que varias localidades est&amp;aacute;n sin suministro el&amp;eacute;ctrico...', 'Mon, 02 Nov 2026 10:00:00 GMT'));
  const geocoder = fakeGeocoder({ 'Riaño': [42.97, -5.0] });
  let now = NOW;
  const src = createCyl112Source({ http: fakeHttp(() => feed), geocoder, now: () => now });
  let { events } = await src.fetch();
  assert.equal(events.length, 1);
  assert.equal(events[0].area, 'Riaño');
  assert.match(events[0].description, /están sin suministro eléctrico/, 'entidades escapadas dos veces, decodificadas');
  assert.ok(!events[0].url.includes('utm_'), 'sin los parámetros de seguimiento');
  assert.deepEqual(geocoder.calls[0], { name: 'Riaño', region: '07', province: 'León' });

  feed = rss(cylItem('1285694676200', 'Rescate de una montañera en el pico San Millán (Burgos)', 'Santa Cruz del Valle Urbión (Burgos) - Rescate.', 'Mon, 02 Nov 2026 11:00:00 GMT'));
  ({ events } = await src.fetch());
  assert.equal(events.length, 1, 'el corte sigue aunque el feed ya no lo traiga');

  now += 25 * HOUR;
  ({ events } = await src.fetch());
  assert.equal(events.length, 0, 'a las 24 h sin noticias se deja de mostrar');
});

// ---------- Illes Balears ----------
const balearItem = (guid, title, date) => `<item><title>${title}</title><link>https://intranet.caib.es/pidip2front/jsp/es/ficha-convocatoria/${guid}</link>
  <enclosure url="https://intranet.caib.es/pidip2front/image?codi=x.jpeg" length="1" type="image/jpeg" /><pubDate>${date}</pubDate>
  <guid isPermaLink="false">${guid}</guid></item>`;
// Como el real: ISO-8859-1 (con tildes y eñes en ese juego de caracteres) y sólo títulos.
const balearFeed = (items) => new Uint8Array(Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>Comunicaciones GOIB - Sala de prensa</title>${items}</channel></rss>`, 'latin1'));
const BALEAR_ITEMS = [
  balearItem(1, 'Emergencias activa la alerta naranja por lluvias y tormentas en Ibiza y Formentera', 'Sun, 01 Nov 2026 12:04:00 +0100'),
  balearItem(2, 'Emergencias eleva a roja la alerta por lluvias y tormentas en Mallorca, Ibiza y Formentera y suspende las clases mañana', 'Mon, 02 Nov 2026 08:59:00 +0100'),
  balearItem(3, 'Reunión de seguimiento del CECOPI del Plan Meteobal y del Plan Inunbal', 'Mon, 02 Nov 2026 09:30:00 +0100'),
  balearItem(4, 'El Govern finaliza las excavaciones del V Plan de Fosas en Son Servera', 'Mon, 02 Nov 2026 10:00:00 +0100'),
  balearItem(5, 'Salut impulsa la investigación contra el cáncer con un convenio', 'Mon, 02 Nov 2026 12:39:00 +0100'),
];

test('Baleares: alertas por isla desde la sala de prensa del Govern (ISO-8859-1), enlazadas en www.caib.es', async () => {
  const src = createBalearsPremsaSource({ http: { bytes: async () => balearFeed(BALEAR_ITEMS.join('')) }, now: clock });
  const { events, sourceTime } = await src.fetch();
  assert.deepEqual(events.map((e) => `${e.area}:${e.severity}`).sort(), ['Formentera:muy alta', 'Ibiza:muy alta', 'Mallorca:muy alta'],
    'la roja sustituye a la naranja; la reunión del CECOPI, el Plan de Fosas y lo demás no son avisos');
  const mallorca = events.find((e) => e.area === 'Mallorca');
  assert.equal(mallorca.title, 'Emergencias eleva a roja la alerta por lluvias y tormentas en Mallorca, Ibiza y Formentera y suspende las clases mañana',
    'el título tal cual, con sus tildes y eñes');
  assert.equal(mallorca.url, 'https://www.caib.es/pidip2front/jsp/es/ficha-convocatoria/2');
  assert.equal(mallorca.approx, 'isla');
  assert.equal(mallorca.credit, 'Font de les dades: Govern de les Illes Balears');
  assert.equal(sourceTime, Date.parse('2026-11-02T11:39:00Z'), 'la nota más reciente, sea o no un aviso');
  assert.equal(src.interval, 900_000);
});

test('Baleares: «Decretado el fin de la emergencia» cierra las alertas de sus islas', async () => {
  const fin = balearItem(6, 'Decretado el fin de la emergencia en Ibiza, Formentera y Mallorca', 'Mon, 02 Nov 2026 12:00:00 +0100');
  const { events } = await createBalearsPremsaSource({ http: { bytes: async () => balearFeed(BALEAR_ITEMS.join('') + fin) }, now: clock }).fetch();
  assert.deepEqual(events, []);
  assert.equal(decodeXml(new Uint8Array(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><a>ñ</a>', 'utf8'))), '<?xml version="1.0" encoding="UTF-8"?><a>ñ</a>');
});

test('Baleares: un corte de luz caduca a las 24 h, como en las demás comunidades; un plan sigue', async () => {
  const feed = balearFeed([
    balearItem(10, 'Corte de luz en Menorca por la tormenta', 'Mon, 02 Nov 2026 08:00:00 +0100'),
    balearItem(11, 'Emergencias activa la alerta naranja por lluvias en Mallorca', 'Mon, 02 Nov 2026 08:00:00 +0100'),
  ].join(''));
  const at = Date.parse('2026-11-02T07:00:00Z');
  const fetchAt = (now) => createBalearsPremsaSource({ http: { bytes: async () => feed }, now: () => now }).fetch();
  const areas = async (now) => (await fetchAt(now)).events.map((e) => `${e.area}:${e.type}`).sort();
  assert.deepEqual(await areas(at + 23 * HOUR), ['Mallorca:plan', 'Menorca:apagon']);
  assert.deepEqual(await areas(at + 25 * HOUR), ['Mallorca:plan'], 'el corte, sin noticias de su fin, se deja de mostrar al día');
  assert.deepEqual(await areas(at + 97 * HOUR), [], 'el plan, a los cuatro días');
});

// ---------- Illes Balears en catalán: la secuencia real de la DANA de octubre de 2026 ----------
// Títulos tal cual del RSS en catalán (lang=ca, la URL del catálogo), con sus horas (CEST, +0200).
const DANA_ITEMS = [
  balearItem(101, "Emergències activa l'alerta taronja per pluges i tempestes a Eivissa i Formentera i demana precaució a la població", 'Fri, 17 Oct 2026 14:04:00 +0200'),
  balearItem(102, 'Reunió de seguiment del Comitè Tècnic Assessor del Pla Meteobal', 'Fri, 17 Oct 2026 22:07:00 +0200'),
  balearItem(103, "Emergències eleva a vermella l'alerta per pluges i tempestes a Mallorca, Eivissa i Formentera i suspèn les classes demà a les tres illes", 'Sat, 18 Oct 2026 19:59:00 +0200'),
  balearItem(104, "El Govern autoritza el teletreball per als empleats públics de la CAIB davant l'alerta vermella meteorològica d'aquest dilluns", 'Sat, 18 Oct 2026 22:02:00 +0200'),
  balearItem(105, "Emergències manté l'alerta vermella de Protecció Civil per pluges i tempestes a Eivissa, Formentera i Mallorca", 'Sun, 19 Oct 2026 12:45:00 +0200'),
  balearItem(106, 'Reunió de seguiment del CECOPI del Pla Meteobal i del Pla Inunbal', 'Sun, 19 Oct 2026 15:27:00 +0200'),
];
// Lo que radar-d1 vio que se colaba: una nota sanitaria posterior en Eivissa y su fin, sin isla.
const SARAMPIO = [
  balearItem(107, "Salut declara l'alerta sanitària per xarampió a Eivissa", 'Sun, 19 Oct 2026 13:30:00 +0200'),
  balearItem(108, "Salut dona per finalitzada l'alerta per xarampió", 'Sun, 19 Oct 2026 14:00:00 +0200'),
];
const REBAIXA = balearItem(109, "Emergències rebaixa els nivells d'alerta i confirma el retorn a les classes a partir de demà a Mallorca, Eivissa i Formentera", 'Sun, 19 Oct 2026 19:19:00 +0200');
const FINAL = balearItem(110, "Decretat el final de l'emergència a Eivissa, Formentera i Mallorca", 'Wed, 22 Oct 2026 17:01:00 +0200');
// El RSS va de lo más nuevo a lo más viejo.
const danaFeed = (items) => balearFeed([...items].reverse().join(''));
const balearsAt = async (items, iso) => {
  const src = createBalearsPremsaSource({ http: { bytes: async () => danaFeed(items) }, now: () => Date.parse(iso) });
  return (await src.fetch()).events.map((e) => `${e.area}:${e.severity}`).sort();
};

test('Baleares en catalán: la URL exacta del catálogo de datos.gob.es (lang=ca)', () => {
  const src = createBalearsPremsaSource({ http: {} });
  assert.equal(src.url, 'https://www.caib.es/pidip2front/pidipRSS?opcio=getRSS&grup=salaDePremsa&lang=ca');
});

test('Baleares en catalán: taronja, vermella en las tres islas, la rebaja las deja en alta y el final lo cierra todo', async () => {
  assert.deepEqual(await balearsAt(DANA_ITEMS.slice(0, 2), '2026-10-17T20:00:00Z'), ['Formentera:alta', 'Ibiza:alta']);
  assert.deepEqual(await balearsAt(DANA_ITEMS, '2026-10-19T13:00:00Z'), ['Formentera:muy alta', 'Ibiza:muy alta', 'Mallorca:muy alta'],
    'ni el teletrabajo ni las reuniones son avisos');
  assert.deepEqual(await balearsAt([...DANA_ITEMS, REBAIXA], '2026-10-19T19:30:00Z'), ['Formentera:alta', 'Ibiza:alta', 'Mallorca:alta']);
  assert.deepEqual(await balearsAt([...DANA_ITEMS, REBAIXA, FINAL], '2026-10-23T10:00:00Z'), []);
});

test('Baleares: una alerta sanitaria no sustituye a la roja por lluvias, y su fin sin isla no la cierra', async () => {
  assert.deepEqual(await balearsAt([...DANA_ITEMS, ...SARAMPIO], '2026-10-19T13:00:00Z'),
    ['Formentera:muy alta', 'Ibiza:muy alta', 'Mallorca:muy alta']);
});

test('Baleares: sólo se leen las 200 notas más recientes (el RSS trae unas 1.300)', () => {
  const xml = `<rss><channel><title>t</title>${'<item><title>a</title></item>'.repeat(5)}</channel></rss>`;
  const cut = firstItems(xml, 2);
  assert.equal(cut, '<rss><channel><title>t</title><item><title>a</title></item><item><title>a</title></item></channel></rss>');
  assert.equal(firstItems(xml, 50), xml, 'si trae menos, entero');
});

// ---------- Andalucía: lo que no es un corte de luz que mostrar ----------
const newsAt = (id, title, body, iso = '2026-11-02T09:00:00.000Z') => ({ id, title, subtitle: '', publication_date: iso, path: { uri: `https://x/${id}` }, body });

test('Andalucía: un simulacro (en el título) con el corte en el texto no es un corte; tampoco «cortes de luz» sin decir dónde', async () => {
  const news = andaluciaNews([
    newsAt('GeNews-400', 'La EMA realiza un simulacro de incendio forestal en Sierra Morena',
      '<p>Durante el ejercicio se ha simulado el corte de la JA-6100 y del suministro eléctrico en Cazalla de la Sierra.</p>'),
    newsAt('GeNews-401', 'El Centro de Coordinación gestiona más de 200 emergencias por el temporal',
      '<p>El resto se ha referido a incidencias de tráfico, además de anomalías en servicios básicos, por roturas de tuberías o cortes de luz.</p>'),
    newsAt('GeNews-402', 'Balance del temporal', '<p>No se han registrado cortes de luz en la provincia de Málaga.</p>'),
  ]);
  const geocoder = fakeGeocoder({ 'Cazalla de la Sierra': [37.93, -5.76], 'Málaga': [36.72, -4.42] });
  const { events } = await createAndaluciaEmergenciasSource({ http: fakeHttp(() => news), geocoder, now: clock }).fetch();
  assert.deepEqual(events, []);
  assert.deepEqual(geocoder.calls, [], 'ni siquiera se busca dónde');
});

test('Andalucía: «ha vuelto la luz» en un sitio que no se sabe situar no cierra los cortes de toda la comunidad', async () => {
  const news = andaluciaNews([
    newsAt('GeNews-410', 'Borrasca en Cádiz', '<p>Hay falta de suministro eléctrico en Espera.</p>', '2026-11-02T06:00:00.000Z'),
    newsAt('GeNews-411', 'Mejora la situación', '<p>Ya se ha restablecido el suministro eléctrico en Villanueva del Despiste.</p>', '2026-11-02T09:00:00.000Z'),
    newsAt('GeNews-412', 'Sigue la borrasca', '<p>Se ha restablecido el suministro eléctrico.</p>', '2026-11-02T10:00:00.000Z'),
  ]);
  const { events } = await createAndaluciaEmergenciasSource({ http: fakeHttp(() => news), geocoder: fakeGeocoder({ Espera: [36.87, -5.8] }), now: clock }).fetch();
  assert.deepEqual(events.map((e) => e.area), ['Espera']);
});

test('geocodificador: si CartoCiudad no responde, no se le pregunta más en esa lectura; y como mucho 30 lugares por lectura', async () => {
  const down = { calls: 0, async locate() { this.calls++; throw new Error('HTTP 503'); } };
  const news = andaluciaNews([newsAt('GeNews-420', 'Borrasca', '<p>Hay falta de suministro eléctrico en Espera, Arcos, Bornos, Villamartín y Prado del Rey.</p>')]);
  const { events } = await createAndaluciaEmergenciasSource({ http: fakeHttp(() => news), geocoder: down, now: clock }).fetch();
  assert.equal(down.calls, 1);
  assert.deepEqual(events.map((e) => `${e.area}:${e.approx}`), ['Andalucía:comunidad'], 'el corte se ve igual, en el centro de la comunidad');

  const towns = Array.from({ length: 40 }, (_, i) => `Pueblo${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  const many = andaluciaNews(towns.map((t, i) => newsAt(`GeNews-5${i}`, 'Borrasca', `<p>Hay falta de suministro eléctrico en ${t}.</p>`)));
  const geocoder = fakeGeocoder({});
  await createAndaluciaEmergenciasSource({ http: fakeHttp(() => many), geocoder, now: clock }).fetch();
  assert.equal(geocoder.calls.length, 30);
});

// ---------- Ids, Cataluña, topes y vigencia ----------
test('Castilla-La Mancha y La Rioja: un enlace acabado en «/» no deja a todos los avisos con el mismo id', () => {
  const clm = parseClmPlans(rss([
    clmItem('platecam-toledo/', 'PLATECAM, activado en la provincia de Toledo', '2026-11-02T10:07:53+01:00'),
    clmItem('meteocam-cuenca/', 'METEOCAM. Cuenca', '2026-11-02T10:00:00+01:00'),
  ].join(''))).notices;
  assert.deepEqual(clm.map((n) => n.id), ['platecam-toledo', 'meteocam-cuenca']);
  const rioja = parseRiojaSos(rss(riojaItem('averia-1/', 'Avería que afecta a suministro eléctrico', '2/11/2026 a las 09:16 en Ventrosa', 'Avería en Ventrosa.')
    + riojaItem('averia-2/', 'Avería que afecta a suministro eléctrico', '2/11/2026 a las 10:16 en Brieva', 'Avería en Brieva.'))).notices;
  assert.deepEqual(rioja.map((n) => n.id), ['averia-1', 'averia-2']);
});

test('Cataluña: sólo los planes con «SI»; si el campo cambia o falta, ninguno (mejor nada que todo activo)', () => {
  assert.deepEqual(parseCatalunaPlans([{ planom: 'INUNCAT', plafase: 'ALERTA' }, { planom: 'NEUCAT', plafase: 'ALERTA', plaactivat: 'true' }]), []);
  assert.equal(parseCatalunaPlans([{ planom: 'INUNCAT', plafase: 'ALERTA', plaactivat: 'Sí' }]).length, 1);
});

test('cada fuente descarga con su tope de tamaño (los feeds pesan de 2 KB a 800 KB)', async () => {
  const seen = [];
  const http = {
    text: async (url, opts) => { seen.push([url, opts.maxBytes]); return rss(''); },
    json: async (url, opts) => { seen.push([url, opts.maxBytes]); return url.includes('juntadeandalucia') ? andaluciaNews([]) : []; },
    bytes: async (url, opts) => { seen.push([url, opts.maxBytes]); return balearFeed(''); },
  };
  const geocoder = fakeGeocoder({});
  for (const src of [
    createCanariasAlertasSource({ http, now: clock }), createCatalunaPlansSource({ http }), createAndaluciaEmergenciasSource({ http, geocoder, now: clock }),
    createClmPlansSource({ http, now: clock }), createRiojaSosSource({ http, geocoder, now: clock }), createCyl112Source({ http, geocoder, now: clock }),
    createBalearsPremsaSource({ http, now: clock }),
  ]) await src.fetch();
  assert.equal(seen.length, 8, 'Cataluña lee también la ficha del conjunto');
  for (const [url, max] of seen) assert.ok(max > 0 && max <= 4 * 1024 * 1024, `${url}: ${max}`);
});

test('cada aviso lleva hasta cuándo está en vigor: así deja el mapa a su hora aunque la fuente caiga', async () => {
  const { events } = await createCanariasAlertasSource({ http: fakeHttp(() => CANARIAS_XML), now: clock }).fetch();
  for (const e of events) assert.equal(e.expires, e.issued + (e.power && !/PLATECA/.test(e.title) ? CUT_MAX_AGE : PLAN_MAX_AGE), e.title);
  assert.ok(events.length > 0);
});

test('Cataluña: cada lectura da sus planes por vigentes dos horas más (si la fuente cae, no se quedan para siempre)', async () => {
  const rows = [{ planom: 'INUNCAT', plafase: 'ALERTA', plaactivat: 'SI', fasedatahora: '02/11/2026 12:07' }];
  const src = createCatalunaPlansSource({ http: fakeHttp((url) => (url.includes('/api/views/') ? {} : rows)), now: clock });
  const { events } = await src.fetch();
  assert.equal(events[0].expires, NOW + 2 * HOUR);
});
