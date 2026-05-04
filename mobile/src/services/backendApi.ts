/**
 * backendApi.ts
 *
 * Sends the selection bounds to the Vercel backend (/api/scan),
 * receives raw solar pin data, assigns 1-1 / 1-2 … / 2-1 … labels,
 * and returns a SolarPin[] ready for the map.
 */

import { BoundingBox, SolarPin } from '../utils/types';

const BACKEND_URL = 'https://solar-finder.vercel.app/api/scan';

// ── Response type from /api/scan ──────────────────────────
interface RawPin {
  lat:          number;
  lng:          number;
  confidence:   number;
  matchedLabel: string;
  address:      string;
}

interface ScanResponse {
  pins:   RawPin[];
  error?: string;
}

// ── Label assignment: 50 pins per set ────────────────────
// Pin 1  → "1-1", pin 50 → "1-50", pin 51 → "2-1", ...
// Numbering is cumulative: pass the current counter so that
// multiple scans accumulate correctly within the same session.
export function assignLabels(
  rawPins: RawPin[],
  startCounter: number = 0,  // number of solar pins already placed
): SolarPin[] {
  return rawPins.map((raw, i) => {
    const n       = startCounter + i + 1;          // global pin number
    const setNum  = Math.ceil(n / 50);             // 1-based set  (1, 2, 3…)
    const itemNum = ((n - 1) % 50) + 1;            // 1-based item (1…50)
    return {
      uid:        `pin-${raw.lat.toFixed(6)}-${raw.lng.toFixed(6)}-${Date.now()}-${i}`,
      coordinate: { latitude: raw.lat, longitude: raw.lng },
      label:      `${setNum}-${itemNum}`,
      address:    raw.address,
      confidence: raw.confidence,
      matchedLabel: raw.matchedLabel,
    };
  });
}

// ── Main function ─────────────────────────────────────────
/**
 * POST the bounding box to /api/scan and return SolarPin[].
 *
 * @param bounds         The selected area (north/south/east/west)
 * @param existingCount  How many solar pins are already on the map
 *                       (used to continue the numbering sequence)
 */
export async function fetchSolarPins(
  bounds: BoundingBox,
  existingCount: number = 0,
): Promise<SolarPin[]> {
  const body = JSON.stringify({ bounds });

  const response = await fetch(BACKEND_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`API エラー ${response.status}: ${text}`);
  }

  const data: ScanResponse = await response.json();

  if (data.error) throw new Error(data.error);
  if (!Array.isArray(data.pins)) throw new Error('API から不正なレスポンスが返りました');

  // Assign set-numbered labels and return map-ready pins
  return assignLabels(data.pins, existingCount);
}
