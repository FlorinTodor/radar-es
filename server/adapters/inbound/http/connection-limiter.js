// Tope de conexiones en directo (SSE). Cada una recibe ~700 KB al abrirse y se queda abierta, así
// que sin tope abrir cientos sería un ataque barato. Se limitan el total, las abiertas por IP y las
// nuevas por IP y minuto. Por IP es generoso: en el móvil mucha gente comparte IP (CGNAT).
const MINUTE = 60_000;

/**
 * @param {{ maxTotal?: number, maxPerIp?: number, maxNewPerIpPerMinute?: number, now?: () => number }} [opts]
 */
export function createConnectionLimiter({ maxTotal = 2000, maxPerIp = 50, maxNewPerIpPerMinute = 60, now = Date.now } = {}) {
  const open = new Map();   // ip → conexiones abiertas
  const recent = new Map(); // ip → instantes de las conexiones nuevas del último minuto
  let total = 0;
  let lastSweep = now();

  return {
    /**
     * Reserva una conexión para `ip`.
     * @returns {(() => void) | null} función que la libera, o null si se rechaza
     */
    acquire(ip) {
      const t = now();
      if (t - lastSweep > MINUTE) {
        for (const [key, times] of recent) if (t - times[times.length - 1] >= MINUTE) recent.delete(key);
        lastSweep = t;
      }
      const times = (recent.get(ip) ?? []).filter((x) => t - x < MINUTE);
      if (total >= maxTotal || (open.get(ip) ?? 0) >= maxPerIp || times.length >= maxNewPerIpPerMinute) return null;
      times.push(t);
      recent.set(ip, times);
      open.set(ip, (open.get(ip) ?? 0) + 1);
      total++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total--;
        const n = open.get(ip) - 1;
        if (n) open.set(ip, n);
        else open.delete(ip);
      };
    },
    get total() { return total; },
  };
}
