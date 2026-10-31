// Autobuses que en el NAP sólo publican su horario GTFS: se muestran con posición estimada, agrupados
// en una fuente por empresa o por tipo para no llenar el panel de fuentes. Todos los conjuntos tienen
// la licencia del NAP ("Powered by MITRAMS"). Sólo se cogen las rutas de autobús de cada GTFS.
//
// Fuera, para no pintar dos veces el mismo autobús o porque no caben:
// - Los que ya llegan con GPS (País Vasco por MoveUskadi, EMT Málaga, EMT Fuenlabrada, Autobuses La
//   Unión) o con su propia fuente (ALSA, AMB, AUVASA).
// - EMT Madrid: su horario por frecuencias da cifras irreales al estimar (decenas de buses por línea).
// - Consorcios que repiten líneas de las empresas: CRTM interurbanos, Generalitat de Catalunya, red
//   andaluza (CTAN, con líneas de ALSA), Ibiza (líneas de ALSA) y Sagalés en Mallorca (está en TIB).
// - La Veloz, Albarracín y Cinco Villas: van dentro del conjunto del Gobierno de Aragón.
// - Xunta de Galicia: 148 MB comprimido, no cabe en memoria.
// - Los caducados (Interbus, Samar, Avanza Segovia, Tubasa, TUS Santander, Burgos…): volver a mirar
//   el NAP de vez en cuando.
//
// Cada fichero: [ficheroId, conjunto de datos del NAP, operador, filtros opcionales].

const ALSA_EN_GVA = /^(València - Alacant\/Elx|Les Marines - Alacant)$/;

/** @type {Array<{ id: string, name: string, credit?: string, feeds: Array<[number, number, string, object?]> }>} */
export const BUS_GROUPS = [
  {
    id: 'avanza', name: 'Avanza: autobuses urbanos',
    feeds: [[1170, 969, 'Avanza Ávila'], [1172, 971, 'Avanza Huesca'], [1173, 972, 'Avanza Mataró'], [1174, 973, 'Avanza Soria'],
      [1176, 975, 'Avanza Zaragoza'], [1586, 1387, 'Avanza Ourense']],
  },
  {
    id: 'sagales', name: 'Sagalés',
    feeds: [[2162, 1631, 'Sagalés Vic'], [2169, 1638, 'Sagalés Osona'], [2170, 1639, 'Manresa Bus'], [2171, 1640, 'Transgran'],
      [2172, 1641, 'Sagalés Costa'], [2173, 1642, 'Sagalés Mataró-St. Celoni'], [2202, 1671, 'Transbages'],
      [2203, 1672, 'Transports Castellà'], [2204, 1673, 'Sagalés (FyT)'], [2205, 1674, 'Sagalés Mataró-St. Celoni']],
  },
  {
    id: 'moventis', name: 'Moventis',
    feeds: [[1578, 1380, 'Moventis Casas'], [1581, 1383, 'Moventis Sarbus'], [1576, 1378, 'Moventis Sarfa']],
  },
  {
    id: 'grupo-ruiz', name: 'Grupo Ruiz (Unauto, Salamanca, Murcia, Empresa Ruiz)',
    feeds: [[1575, 1377, 'Unauto'], [1598, 1389, 'Salamanca de Transportes'], [1597, 1388, 'Transportes de Murcia'],
      [2426, 1677, 'Empresa Ruiz']],
  },
  {
    id: 'aisa', name: 'AISA',
    feeds: [[1599, 1390, 'AISA Ciudad Real y Seseña'], [2555, 1744, 'AISA Madrid']],
  },
  {
    id: 'vectalia', name: 'Vectalia: Alicante y Cáceres',
    feeds: [[1607, 1392, 'Vectalia Alicante'], [1493, 1292, 'Vectalia Cáceres']],
  },
  {
    // TMB pide citarla con la fecha de actualización (licencia de developer.tmb.cat).
    id: 'urbanos', name: 'Autobuses urbanos de ciudades', credit: 'Fuente: TMB',
    feeds: [[1328, 1127, 'TMB'], [1567, 1369, 'TUSSAM'], [1166, 965, 'EMT València'], [1564, 1367, 'Granada'],
      [1573, 1375, 'Aucorsa'], [1572, 1374, 'Castelló'], [1574, 1376, 'Tranvías de A Coruña'], [1295, 1094, 'Guaguas Municipales'],
      [1495, 1294, 'EMT Palma'], [1579, 1381, 'Autobusos de Lleida'], [1694, 1396, 'EMT Tarragona'], [1570, 1372, 'TMG Girona'],
      [2427, 1678, 'Urbanos de Linares'], [2083, 1559, 'Aranda de Duero'], [1177, 976, 'Villavesas (Pamplona)'],
      [1788, 1517, 'Reus Transport']],
  },
  {
    id: 'autonomicos', name: 'Autobuses interurbanos autonómicos e insulares',
    feeds: [[1178, 977, 'CTA Asturias'], [1560, 1363, 'Cantabria'], [1164, 963, 'Navarra'], [2077, 1553, 'La Rioja'],
      [2078, 1554, 'La Rioja metropolitano'], [2080, 1556, 'La Rioja rural'], [2554, 1743, 'Aragón'], [1272, 1071, 'TIB Mallorca'],
      [1363, 1162, 'Menorca'], [1331, 1130, 'TITSA'], [1526, 1325, 'Comunitat Valenciana', { excludeAgency: ALSA_EN_GVA }]],
  },
  {
    id: 'otros', name: 'Otras empresas de autobús',
    feeds: [[2428, 1679, 'Autoperiferia'], [2429, 1680, 'Empresa Martín'], [1983, 1523, 'Direxis Masats'],
      // Los urbanos de Castellbisbal (CS1–CS4) ya vienen en el GTFS de AMB.
      [1984, 1524, 'Direxis TGO', { excludeRoute: /^CS\d$/ }],
      [1577, 1379, 'Pujol'], [1580, 1382, 'TCC Barcelona'], [2160, 1630, 'Autocorb'], [2009, 1525, 'Cots Alsina'],
      [1969, 1522, 'Eixbus'], [2556, 1745, 'Montferri'], [1231, 1030, 'Lurraldebus Lasarte'], [1199, 998, 'Irunbus'],
      [1169, 968, 'Autocares Baraza'], [2069, 1545, 'Autocares Costa'], [1843, 1518, 'Autocares Rías Baixas'],
      [2207, 1676, 'Empresa Gilsanz'], [2072, 1548, 'Lázara'], [2074, 1550, 'Rodil'], [2076, 1552, 'Autocares Medina'],
      [2075, 1551, 'Taxitur'], [2070, 1546, 'Autocares Álvarez'], [2073, 1549, 'Viagón'], [2081, 1557, 'Autocares Galán Gómez'],
      [2082, 1558, 'Autocares J Cristeto'], [2071, 1547, 'Ancebus'], [2153, 1629, 'Autobuses Vega de Tirados'],
      [2151, 1627, 'Arroyobus'], [2117, 1593, 'La Hispano del Cid'], [2079, 1555, 'Pérez Cubero']],
  },
];

/** Fuentes de posición estimada por horario, una por grupo. */
export function busGroupSources(deps, createGtfsScheduleSource) {
  return BUS_GROUPS.map((g) => createGtfsScheduleSource(deps, {
    id: `bus-${g.id}`,
    name: `${g.name} (posición estimada según horario)`,
    mode: 'bus',
    interval: 60_000,
    // Además de "Powered by MITRAMS", cada operador del grupo (y lo que pida alguno, como TMB).
    credit: [g.credit, g.feeds.map(([, , operator]) => operator).join(', ')].filter(Boolean).join(' · '),
    feeds: g.feeds.map(([ficheroId, dataset, operator, filter]) => ({ ficheroId, dataset, operator, ...filter })),
  }));
}
