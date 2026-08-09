// lib/geo.js — geometria minima: distanza in linea d'aria tra due punti (haversine).
//
// RAGGIO_VICINO_KM è un parametro di PRODOTTO (non fisico): oggi è fisso a 25 km, in
// futuro diventerà una preferenza dell'utente. Tenuto qui come costante nominata e
// facilmente modificabile — chi la cambia non deve toccare la logica di calcolo.
export const RAGGIO_VICINO_KM = 25;

const RAGGIO_TERRA_KM = 6371; // questo invece è fisico, non si tocca

export function distanzaKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => typeof v !== "number" || !isFinite(v))) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return RAGGIO_TERRA_KM * c;
}
