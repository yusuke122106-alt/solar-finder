/**
 * POST /api/scan
 *
 * Body : { bounds: { north, south, east, west } }
 *
 * Returns:
 *   { pins: [{ lat, lng, confidence, matchedLabel, address }] }
 *
 * Pipeline:
 *   1. Generate grid points over the bounding box
 *   2. For each point → Google Solar API  (find building centre)
 *   3. Deduplicate buildings
 *   4. For each building → Cloud Vision AI (detect solar panels)
 *   5. Keep only confirmed solar houses, filter companies
 *   6. Return ordered array (caller assigns 1-1 / 1-2 ... labels)
 */

const API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBcATWao1nEV93-vh2R8QiUjVpfo9NVegg';

const MAX_BUILDINGS = 25; // keep under Vercel function timeout

const SOLAR_KEYWORDS = [
  'solar panel', 'photovoltaic', 'solar cell', 'solar energy',
  'solar array', 'solar farm', 'solar power', 'solar module',
  'renewable energy', 'rooftop solar', 'pv system', 'solar', 'panel',
];

const COMPANY_RE =
  /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|公益社団法人|NPO法人|社会福祉法人|学校法人|宗教法人|工場|倉庫|事務所|病院|クリニック|銀行|ホテル|旅館|学校|幼稚園|保育園|役所|庁舎/;

// ── helpers ────────────────────────────────────────────────

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

async function batchAll(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── Solar API: find building centre ───────────────────────

async function findBuilding(lat, lng) {
  try {
    const url =
      `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
      `?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${API_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) return null;
    return {
      lat: data.center?.latitude  ?? lat,
      lng: data.center?.longitude ?? lng,
    };
  } catch {
    return null;
  }
}

// ── Nominatim: reverse geocode ────────────────────────────

async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`,
      { headers: { 'User-Agent': 'SolarFinderAPI/1.0' } },
    );
    const data = await res.json();
    return data?.display_name ?? `${lat.toFixed(5)},${lng.toFixed(5)}`;
  } catch {
    return `${lat.toFixed(5)},${lng.toFixed(5)}`;
  }
}

// ── Cloud Vision AI: detect solar panels ─────────────────

async function detectSolar(lat, lng) {
  const imageUri =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=20&size=640x640&maptype=satellite&key=${API_KEY}`;

  // In Node.js: fetch image → ArrayBuffer → base64 (no FileReader)
  let imagePayload;
  try {
    const imgRes  = await fetch(imageUri);
    if (!imgRes.ok) throw new Error(`static maps ${imgRes.status}`);
    const buf    = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buf).toString('base64');
    imagePayload = { content: base64 };
  } catch {
    imagePayload = { source: { imageUri } };
  }

  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: imagePayload,
            features: [
              { type: 'LABEL_DETECTION',     maxResults: 30 },
              { type: 'OBJECT_LOCALIZATION', maxResults: 15 },
              { type: 'IMAGE_PROPERTIES' },
            ],
          }],
        }),
      },
    );
    const data = await res.json();
    const r    = data.responses?.[0] ?? {};

    const items = [
      ...(r.labelAnnotations           ?? []).map(l => ({ name: l.description.toLowerCase(), score: l.score, display: l.description })),
      ...(r.localizedObjectAnnotations ?? []).map(o => ({ name: o.name.toLowerCase(),        score: o.score, display: o.name        })),
    ];

    let best = 0, bestLabel = '';
    for (const item of items) {
      if (SOLAR_KEYWORDS.some(kw => item.name.includes(kw) || kw.includes(item.name))) {
        if (item.score > best) { best = item.score; bestLabel = item.display; }
      }
    }

    // Color hint: dark blue / grey of solar panel glass
    let colorBoost = 0;
    for (const c of (r.imagePropertiesAnnotation?.dominantColors?.colors ?? [])) {
      const { red: rv, green: g, blue: b } = c.color;
      const f = c.pixelFraction ?? 0;
      if (rv < 80 && g < 80 && b > 60 && b < 180 && f > 0.05) colorBoost = Math.max(colorBoost, f * 0.5);
      if (Math.abs(rv - g) < 25 && Math.abs(g - b) < 25 && rv < 80 && f > 0.08) colorBoost = Math.max(colorBoost, f * 0.4);
    }

    const score = Math.min(1, best + colorBoost);
    return {
      hasSolar:     score > 0.2 || best > 0.15,
      confidence:   Math.round(score * 100),
      matchedLabel: bestLabel || (colorBoost > 0.1 ? '色彩パターン検出' : ''),
    };
  } catch {
    return { hasSolar: false, confidence: 0, matchedLabel: '' };
  }
}

// ── Request handler ───────────────────────────────────────

module.exports = async (req, res) => {
  // CORS headers (needed for web clients; React Native ignores them)
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { bounds } = req.body ?? {};
  if (!bounds?.north || bounds.north === undefined) {
    return res.status(400).json({ error: 'bounds { north, south, east, west } required' });
  }

  const { north, south, east, west } = bounds;

  // ── 1. Build grid of sample points ──────────────────────
  const latDiff = north - south;
  const lngDiff = east  - west;
  const latM    = latDiff * 111000;
  const lngM    = lngDiff * 111000 * Math.cos(south * Math.PI / 180);
  const sLat    = clamp(Math.round(latM / 40), 3, 12);
  const sLng    = clamp(Math.round(lngM / 40), 3, 12);

  const points = [];
  for (let i = 0; i <= sLat; i++)
    for (let j = 0; j <= sLng; j++)
      points.push({ lat: south + (latDiff / sLat) * i, lng: west + (lngDiff / sLng) * j });

  // ── 2. Find unique buildings (Solar API, concurrent) ────
  const seen      = new Set();
  const buildings = [];

  const buildingResults = await batchAll(points, async (pt) => {
    return findBuilding(pt.lat, pt.lng);
  }, 8);

  for (const b of buildingResults) {
    if (!b) continue;
    const key = `${b.lat.toFixed(5)},${b.lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    // rough proximity deduplicate
    let tooClose = false;
    for (const k of seen) {
      const [rl, rg] = k.split(',').map(Number);
      if (Math.abs(b.lat - rl) < 0.00008 && Math.abs(b.lng - rg) < 0.00008) { tooClose = true; break; }
    }
    if (tooClose) continue;
    seen.add(key);
    buildings.push(b);
    if (buildings.length >= MAX_BUILDINGS) break;
  }

  // ── 3. Vision AI + geocode for each building (concurrent) ─
  const pinData = [];

  await batchAll(buildings, async (b) => {
    const [address, vision] = await Promise.all([
      reverseGeocode(b.lat, b.lng),
      detectSolar(b.lat, b.lng),
    ]);

    if (!vision.hasSolar)       return; // no solar → skip
    if (COMPANY_RE.test(address)) return; // company → skip

    pinData.push({
      lat:          b.lat,
      lng:          b.lng,
      confidence:   vision.confidence,
      matchedLabel: vision.matchedLabel,
      address,
    });
  }, 5);

  // ── 4. Return ordered array (client assigns labels) ────
  return res.status(200).json({ pins: pinData });
};
