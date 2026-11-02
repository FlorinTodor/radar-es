// Avisos oficiales sacados de las notas de prensa de los gobiernos de Madrid, Murcia, Cantabria y
// Galicia: cada fuente lee su formato tal y como lo publica (con sus rarezas) y, de todas las notas,
// sólo se quedan las que declaran o terminan un plan nombrándolo y las que hablan de un corte de luz.
// Sin red ni esperas: http y geocodificador falsos y el reloj de cada fuente fijado (`now`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCantabriaNewsSource, createGaliciaNewsSource, createMadridNewsSource, createMurciaNewsSource, parseMadridNews, pressNotices,
} from '../../server/adapters/outbound/sources/emergencias-oficiales.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 3_600_000;
const clock = () => NOW;
const fakeHttp = (byUrl) => ({
  text: async (url) => { const body = byUrl(url); if (body instanceof Error) throw body; return body; },
});
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
const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>RSS</title>${items}</channel></rss>`;
const at = (title, i = 0) => ({ id: String(i), at: NOW, title, url: null });

test('notas de prensa: sólo los planes con nombre, fase o color y los cortes de luz de ahora', () => {
  const titles = [
    'La Comunidad de Madrid activa su Plan Territorial de Protección Civil en fase de alerta ante la visita del Papa León XIV',
    'El Gobierno activa la situación 2 del PLATERCAN por el apagón que está afectando a todo el país',
    'El Gobierno desescala el PLATERCANT a su fase de preemergencia',
    'Corte de luz en Arganda del Rey y Rivas-Vaciamadrid',
    'Restablecido el suministro eléctrico en Alcobendas tras la avería',
    // No son avisos: un verbo, una alerta sanitaria, una inversión, un balance y un simulacro.
    'La Comunidad alerta de estafas telefónicas y mantiene la campaña de prevención',
    'Salud mantiene la alerta por la gripe y sube la vacunación',
    'La Comunidad de Madrid invierte para evitar cortes de luz en los hospitales',
    'El 112 de la Comunidad de Madrid gestiona en dos años 8 millones de llamadas, con acontecimientos como la DANA, el apagón o las lluvias más intensas en 135 años',
    'La Axega participa en un simulacro de incendio en un tren en el túnel de As Maceiras, en Redondela',
  ];
  const notices = pressNotices(titles.map(at), 'madrid');
  assert.deepEqual(notices.map((n) => n.title), titles.slice(0, 5));
  const [visita, platercan, desescala, corte, vuelve] = notices;
  assert.equal(visita.power, false);
  assert.equal(visita.severity, 'alta');
  assert.equal(platercan.power, true, 'un plan por un apagón también es un corte de luz');
  assert.equal(platercan.severity, 'muy alta');
  assert.equal(desescala.severity, 'alta');
  assert.deepEqual(corte.candidates, ['Arganda del Rey', 'Rivas-Vaciamadrid'], 'el nombre con guion entero');
  assert.equal(vuelve.end, true);
  assert.equal(vuelve.severity, 'baja');
});

// ---------- Comunidad de Madrid ----------
const madridItem = ({ path, title, pubDate, body }) => `<item><title>${title}</title><link>https://www.comunidad.madrid/noticias/${path}</link>
  <description><![CDATA[<span class="field field--name-title"><h1>${title}</h1></span>
    <div class="field field--name-body field--type-text-with-summary"><p>${body}</p><p>Segundo párrafo con más detalles.</p>
    <picture><img src="https://www.comunidad.madrid/sites/default/files/foto.jpg"></picture></div>]]></description>
  <pubDate>${pubDate}</pubDate><dc:creator>Prensa</dc:creator><guid isPermaLink="false">1</guid></item>`;
const MADRID_XML = rss([
  madridItem({
    path: '2026/11/02/comunidad-madrid-activa-platercam-fase-alerta-lluvias', pubDate: 'Fri, 30 Oct 2026 17:49:52 +0000',
    title: 'La Comunidad de Madrid activa el PLATERCAM en fase de alerta por lluvias en la Sierra Norte',
    body: 'La Agencia de Seguridad y Emergencias Madrid 112 ha activado el plan por las lluvias previstas.',
  }),
  madridItem({
    path: '2026/11/02/corte-luz-alcobendas', pubDate: 'Mon, 02 Nov 2026 10:30:00 +0000',
    title: 'Corte de luz en Alcobendas por una avería', body: 'Varios barrios de Alcobendas se han quedado sin luz esta mañana.',
  }),
  madridItem({
    path: '2026/11/02/diaz-ayuso-entrega-medalla', pubDate: 'Mon, 02 Nov 2026 09:00:00 +0000',
    title: 'Díaz Ayuso entrega la Medalla Internacional de la Comunidad de Madrid', body: 'Sin más.',
  }),
].join(''));

test('Madrid: la fecha de publicación es la del enlace si pubDate es de antes (cuándo se redactó); sólo el primer párrafo y sin fotos', () => {
  const { notices } = parseMadridNews(MADRID_XML);
  assert.equal(notices.length, 2);
  const plan = notices.find((n) => /PLATERCAM/.test(n.title));
  assert.equal(new Date(plan.at).toISOString(), '2026-11-01T23:00:00.000Z', 'el 2-11 a las 00:00 de Madrid, no el 30-10');
  assert.equal(plan.description, 'La Agencia de Seguridad y Emergencias Madrid 112 ha activado el plan por las lluvias previstas.');
  assert.ok(!JSON.stringify(notices).includes('foto.jpg'));
  assert.equal(notices.find((n) => n.power).at, Date.parse('2026-11-02T10:30:00Z'), 'si pubDate es más nueva, pubDate');
});

test('Madrid: el corte en su pueblo (CartoCiudad, comunidad 13) y el plan en el centro de la comunidad; la ficha da la hora a la que se leyó', async () => {
  const geocoder = fakeGeocoder({ Alcobendas: [40.54, -3.64] });
  const src = createMadridNewsSource({ http: fakeHttp(() => MADRID_XML), geocoder, now: clock });
  const { events, sourceTime } = await src.fetch();
  assert.equal(sourceTime, null, 'su aviso legal pide la fecha de extracción: la de lectura');
  const cut = events.find((e) => e.power);
  assert.equal(cut.area, 'Alcobendas');
  assert.equal(cut.approx, 'municipio');
  assert.deepEqual(geocoder.calls.map((c) => c.region), ['13']);
  const plan = events.find((e) => e.type === 'plan');
  assert.equal(plan.area, 'Comunidad de Madrid');
  assert.equal(plan.approx, 'comunidad');
  assert.equal(plan.credit, 'Fuente: Comunidad de Madrid');
  assert.equal(plan.url, 'https://www.comunidad.madrid/noticias/2026/11/02/comunidad-madrid-activa-platercam-fase-alerta-lluvias');
});

// ---------- Región de Murcia ----------
const murciaRow = ({ id, title, date, hour, lead, category }) => `<resultado><FECHANOTICIA>${date}</FECHANOTICIA><TITULO>${title}</TITULO>
  <ENTRADILLA>${lead}&#xd;
&#xd;
Segundo párrafo de la entradilla</ENTRADILLA><ANTETITULO></ANTETITULO><CUERPO>&lt;p&gt;Cuerpo&lt;/p&gt;</CUERPO><IMAGEN_URL>https://www.carm.es/foto.jpg</IMAGEN_URL>
  <CATEGORIA>${category}</CATEGORIA><FECHA_VIGENCIA_DESDE>${date}</FECHA_VIGENCIA_DESDE><HORA_VIGENCIA_DESDE>${hour}</HORA_VIGENCIA_DESDE>
  <URL_NOTICIA_CARM>http://www.carm.es/web/pagina?IDCONTENIDO=${id}&amp;amp;IDTIPO=10&amp;amp;RASTRO=c$m</URL_NOTICIA_CARM><timestamp>1793659039977</timestamp></resultado>`;
const MURCIA_XML = `<?xml version="1.0" encoding="UTF-8"?><resultados>${[
  murciaRow({
    id: 126600, title: 'El Gobierno regional activa el PLATEMUR en fase de preemergencia por las lluvias', date: '02/11/2026', hour: '10:15',
    lead: 'La Dirección General de Seguridad Ciudadana y Emergencias pide precaución', category: 'Presidencia, Juventud, Acción Exterior y Emergencias',
  }),
  murciaRow({ id: 126503, title: 'La Filmoteca regional acoge la muestra CinePOLSKA', date: '02/11/2026', hour: '09:00', lead: 'Cine', category: 'Turismo, Cultura y Deportes' }),
].join('')}</resultados>`;

test('Murcia: el plan con la hora de su vigencia, la entradilla (primer párrafo) y el enlace sin escapar dos veces', async () => {
  const src = createMurciaNewsSource({ http: fakeHttp(() => MURCIA_XML), geocoder: fakeGeocoder({}), now: clock });
  const { events, sourceTime } = await src.fetch();
  assert.equal(events.length, 1);
  const [plan] = events;
  assert.equal(plan.issued, Date.parse('2026-11-02T09:15:00Z'), '10:15 en Madrid');
  assert.equal(sourceTime, Date.parse('2026-11-02T09:15:00Z'), 'la licencia pide la fecha de la última actualización');
  assert.equal(plan.description, 'La Dirección General de Seguridad Ciudadana y Emergencias pide precaución');
  assert.equal(plan.url, 'http://www.carm.es/web/pagina?IDCONTENIDO=126600&IDTIPO=10&RASTRO=c$m');
  assert.equal(plan.area, 'Región de Murcia');
  assert.equal(plan.severity, 'alta');
  assert.equal(plan.credit, 'Origen de los datos: Comunidad Autónoma de la Región de Murcia (CARM)');
  assert.ok(!JSON.stringify(events).includes('foto.jpg'));
});

// ---------- Cantabria ----------
const cantabriaItem = (id, title, day) => `<item><title>${title}</title><link>https://www.cantabria.es/web/comunicados/detalle/-/journal_content/56_INSTANCE_DETALLE/16413/${id}</link><modDate>${day}</modDate><categorias>Gobierno|Vivir en Cantabria</categorias></item>`;
const CANTABRIA_XML = rss([
  cantabriaItem(161433300, 'El Gobierno activa la situación 2 del PLATERCAN por el apagón', '2026-11-02'),
  cantabriaItem(161433217, 'Buruaga interés público PSIR Santander Castro Urdiales', '2026-11-02'),
].join(''));

test('Cantabria: sin hora, la nota del día cuenta desde que se lee hasta el mediodía; la ficha sólo da el día', async () => {
  const morning = Date.parse('2026-11-02T08:00:00Z');
  let now = morning;
  const src = createCantabriaNewsSource({ http: fakeHttp(() => CANTABRIA_XML), geocoder: fakeGeocoder({}), now: () => now });
  let { events } = await src.fetch();
  assert.equal(events.length, 1);
  assert.equal(events[0].issued, morning, 'antes del mediodía, la hora a la que se leyó');
  assert.equal(events[0].issuedDayOnly, true);
  assert.equal(events[0].power, true);
  assert.equal(events[0].severity, 'muy alta');
  assert.equal(events[0].area, 'Cantabria');
  now = Date.parse('2026-11-02T20:00:00Z');
  ({ events } = await src.fetch());
  assert.equal(events[0].issued, Date.parse('2026-11-02T11:00:00Z'), 'después, el mediodía de Madrid');
  now += 4 * 24 * HOUR;
  ({ events } = await src.fetch());
  assert.equal(events.length, 0, 'un plan sin noticias de su fin se deja de ver a los 4 días');
});

// ---------- Galicia ----------
const galiciaItem = (nova, title, date) => `<item><title><![CDATA[${title}]]></title>
  <link>https://www.xunta.gal/es/notas-de-prensa/-/nova/${nova}/titulo</link>
  <description><![CDATA[<p>Primer párrafo de ${nova}</p><p>Segundo párrafo</p>]]></description>
  <guid>https://www.xunta.gal/es/notas-de-prensa/-/nova/${nova}/titulo</guid>
  <enclosure url="https://www.xunta.gal/foto.jpg" type="image/jpeg" length="1"/><pubDate>${date}</pubDate></item>`;
const GALICIA_EMERX = rss(galiciaItem('029960', 'La Xunta activa hoy la alerta naranja por lluvia en el interior de A Coruña y en el centro y montaña de Lugo', 'Mon, 2 Nov 2026 09:00:00 +0100'));
const GALICIA_ALL = rss([
  galiciaItem('029961', 'Sin luz varios barrios de Vigo por una avería en la red', 'Mon, 2 Nov 2026 11:00:00 +0100'),
  galiciaItem('029962', 'Rueda participa en los actos de la Fiesta Nacional de España', 'Mon, 2 Nov 2026 11:30:00 +0100'),
].join(''));

test('Galicia: lee el RSS de Emergencias y el general; la alerta en sus provincias y el corte en su ciudad', async () => {
  const geocoder = fakeGeocoder({ Vigo: [42.23, -8.72] });
  const src = createGaliciaNewsSource({ http: fakeHttp((url) => (url.includes('Emerxencias') ? GALICIA_EMERX : GALICIA_ALL)), geocoder, now: clock });
  const { events } = await src.fetch();
  const alert = events.filter((e) => e.type === 'plan').map((e) => `${e.area}:${e.approx}`).sort();
  assert.deepEqual(alert, ['A Coruña:provincia', 'Lugo:provincia']);
  const cut = events.find((e) => e.power);
  assert.equal(cut.area, 'Vigo');
  assert.equal(cut.description, 'Primer párrafo de 029961');
  assert.equal(cut.credit, 'Fuente: Xunta de Galicia');
  assert.deepEqual(geocoder.calls.map((c) => c.region), ['12']);
  assert.ok(!JSON.stringify(events).includes('foto.jpg'));
});

test('Galicia: el corte se queda aunque el RSS general ya no lo traiga, y si uno de los dos falla se lee el otro', async () => {
  let all = GALICIA_ALL;
  const src = createGaliciaNewsSource({ http: fakeHttp((url) => (url.includes('Emerxencias') ? GALICIA_EMERX : all)), geocoder: fakeGeocoder({ Vigo: [42.23, -8.72] }), now: clock });
  await src.fetch();
  all = new Error('503');
  const { events } = await src.fetch();
  assert.ok(events.some((e) => e.power && e.area === 'Vigo'), 'guardado de la lectura anterior');
  assert.ok(events.some((e) => e.type === 'plan'));
  const down = createGaliciaNewsSource({ http: fakeHttp(() => new Error('503')), geocoder: fakeGeocoder({}), now: clock });
  await assert.rejects(down.fetch(), /503/, 'si fallan los dos, la fuente da error');
});
