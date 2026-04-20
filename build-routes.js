#!/usr/bin/env node

/**
 * build-routes.js
 *
 * What it does:
 * - `node build-routes.js --seed`
 *   Regenerates preview route files directly from curated waypoint chains.
 *
 * - `node build-routes.js`
 *   Tries OSRM-compatible road routing first, then optional Mapbox, then
 *   gracefully falls back to preview seed geometry if no routed result is
 *   available.
 *
 * Optional env:
 * - `ROUTING_BACKEND=auto|osrm|mapbox|seed`
 * - `OSRM_BASE_URL=https://router.project-osrm.org`
 * - `OSRM_PROFILE=driving`
 * - `MAPBOX_ACCESS_TOKEN=...`
 * - `MAPBOX_PROFILE=driving`
 * - `ROUTING_TIMEOUT_MS=15000`
 */

const fs = require("fs/promises");
const https = require("https");
const path = require("path");

const SCRIPT_DIR = __dirname;
const ROUTES_DIR = path.join(SCRIPT_DIR, "routes");
const LOOPS_FILE = process.env.LOOPS_FILE || path.join(SCRIPT_DIR, "loops.json");
const WRITE_SEED_ONLY = process.argv.includes("--seed");

function parseDotEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadDotEnvConfig() {
  const merged = {};
  const envPaths = [
    path.join(SCRIPT_DIR, ".env"),
    path.join(process.cwd(), ".env")
  ];

  for (const envPath of envPaths) {
    try {
      const text = await fs.readFile(envPath, "utf8");
      Object.assign(merged, parseDotEnv(text));
    } catch {
      // Ignore missing .env files.
    }
  }

  return merged;
}

function getConfigValue(dotEnv, key, fallback = "") {
  return process.env[key] || dotEnv[key] || fallback;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadLoops() {
  const text = await fs.readFile(LOOPS_FILE, "utf8");
  const parsed = JSON.parse(text);
  const loops = Array.isArray(parsed) ? parsed : parsed.loops;

  if (!Array.isArray(loops) || loops.length === 0) {
    throw new Error(`No loops found in ${LOOPS_FILE}`);
  }

  return loops.map(loop => {
    if (!loop?.id) {
      throw new Error(`Loop entry is missing an id in ${LOOPS_FILE}`);
    }

    const coords = loop.waypoints || loop.routeGeometry;
    if (!Array.isArray(coords) || coords.length < 2) {
      throw new Error(`Loop ${loop.id} is missing usable waypoint coordinates in ${LOOPS_FILE}`);
    }

    return {
      id: loop.id,
      coords,
      routeFile: loop.routeFile || `/routes/${loop.id}.geojson`
    };
  });
}

function bboxFromCoords(coords) {
  const lngs = coords.map(([lng]) => lng);
  const lats = coords.map(([, lat]) => lat);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

function featureCollection(coords, properties) {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties,
        geometry: {
          type: "LineString",
          coordinates: coords
        }
      }
    ]
  };
}

function safeJsonParse(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON returned for ${label}: ${err.message}`);
  }
}

async function requestJson(url, label, timeoutMs) {
  if (typeof fetch === "function") {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${label} request failed: ${res.status} ${text}`);
      }
      return safeJsonParse(text, label);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode || 500) >= 400) {
          reject(new Error(`${label} request failed: ${res.statusCode} ${text}`));
          return;
        }
        try {
          resolve(safeJsonParse(text, label));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${label} request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function buildRoutingProviders(config) {
  if (WRITE_SEED_ONLY || config.routingBackend === "seed") {
    return [];
  }

  const providers = [];

  if (config.routingBackend === "auto" || config.routingBackend === "osrm") {
    providers.push({
      name: "osrm",
      source: "osrm",
      profile: config.osrmProfile,
      baseUrl: normalizeBaseUrl(config.osrmBaseUrl)
    });
  }

  if ((config.routingBackend === "auto" || config.routingBackend === "mapbox") && config.mapboxToken) {
    providers.push({
      name: "mapbox",
      source: "mapbox-directions",
      profile: config.mapboxProfile,
      token: config.mapboxToken
    });
  }

  return providers;
}

function appendSegmentCoords(existingCoords, nextCoords) {
  if (!existingCoords.length) return [...nextCoords];
  if (!nextCoords.length) return existingCoords;

  const [lastLng, lastLat] = existingCoords[existingCoords.length - 1];
  const [firstLng, firstLat] = nextCoords[0];
  const startsAtSamePoint = lastLng === firstLng && lastLat === firstLat;

  return startsAtSamePoint
    ? existingCoords.concat(nextCoords.slice(1))
    : existingCoords.concat(nextCoords);
}

function buildRouteResult(route, options) {
  const coords = options.coords;
  return {
    coords,
    distanceM: options.distanceM ?? null,
    durationS: options.durationS ?? null,
    routeStatus: options.routeStatus,
    source: options.source,
    profile: options.profile || null,
    bbox: bboxFromCoords(coords),
    waypointCount: route.coords.length,
    generatedAt: new Date().toISOString()
  };
}

function buildSeedRouteResult(route) {
  return buildRouteResult(route, {
    coords: route.coords,
    distanceM: null,
    durationS: null,
    routeStatus: "preview",
    source: "editorial-seed"
  });
}

function buildGeoJSON(route, routeResult) {
  return featureCollection(routeResult.coords, {
    route_id: route.id,
    route_status: routeResult.routeStatus,
    source: routeResult.source,
    profile: routeResult.profile,
    distance_m: routeResult.distanceM,
    duration_s: routeResult.durationS,
    bbox: routeResult.bbox,
    waypoint_count: routeResult.waypointCount,
    generated_at: routeResult.generatedAt
  });
}

function buildOsrmSegmentUrl(provider, from, to) {
  const coordString = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  return `${provider.baseUrl}/route/v1/${provider.profile}/${coordString}?overview=full&geometries=geojson&steps=false`;
}

function buildMapboxSegmentUrl(provider, from, to) {
  const coordString = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  return (
    `https://api.mapbox.com/directions/v5/mapbox/${provider.profile}/${coordString}` +
    `?overview=full&geometries=geojson&steps=false&access_token=${provider.token}`
  );
}

async function requestOsrmSegment(provider, from, to, timeoutMs, routeId, segmentIndex) {
  const url = buildOsrmSegmentUrl(provider, from, to);
  const label = `OSRM route ${routeId} segment ${segmentIndex + 1}`;
  const data = await requestJson(url, label, timeoutMs);

  if (data?.code && data.code !== "Ok") {
    throw new Error(`${label} returned ${data.code}`);
  }

  const best = data?.routes?.[0];
  const coords = best?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error(`${label} returned no usable LineString geometry`);
  }

  return {
    coords,
    distanceM: best.distance ?? null,
    durationS: best.duration ?? null
  };
}

async function requestMapboxSegment(provider, from, to, timeoutMs, routeId, segmentIndex) {
  const url = buildMapboxSegmentUrl(provider, from, to);
  const label = `Mapbox route ${routeId} segment ${segmentIndex + 1}`;
  const data = await requestJson(url, label, timeoutMs);
  const best = data?.routes?.[0];
  const coords = best?.geometry?.coordinates;

  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error(`${label} returned no usable LineString geometry`);
  }

  return {
    coords,
    distanceM: best.distance ?? null,
    durationS: best.duration ?? null
  };
}

async function requestSegment(provider, from, to, timeoutMs, routeId, segmentIndex) {
  if (provider.name === "osrm") {
    return requestOsrmSegment(provider, from, to, timeoutMs, routeId, segmentIndex);
  }
  if (provider.name === "mapbox") {
    return requestMapboxSegment(provider, from, to, timeoutMs, routeId, segmentIndex);
  }
  throw new Error(`Unsupported routing provider: ${provider.name}`);
}

async function buildOfficialRouteResult(route, provider, timeoutMs) {
  let mergedCoords = [];
  let totalDistanceM = 0;
  let totalDurationS = 0;

  for (let i = 0; i < route.coords.length - 1; i += 1) {
    const from = route.coords[i];
    const to = route.coords[i + 1];
    const segment = await requestSegment(provider, from, to, timeoutMs, route.id, i);

    mergedCoords = appendSegmentCoords(mergedCoords, segment.coords);
    totalDistanceM += Number(segment.distanceM) || 0;
    totalDurationS += Number(segment.durationS) || 0;
  }

  if (mergedCoords.length < 2) {
    throw new Error(`Provider ${provider.name} returned no usable geometry for ${route.id}`);
  }

  return buildRouteResult(route, {
    coords: mergedCoords,
    distanceM: Math.round(totalDistanceM),
    durationS: Math.round(totalDurationS),
    routeStatus: "official",
    source: provider.source,
    profile: provider.profile
  });
}

function getOutputPath(route) {
  const routeFile = route.routeFile || `/routes/${route.id}.geojson`;
  const relativePath = routeFile.startsWith("/") ? routeFile.slice(1) : routeFile;
  return path.join(SCRIPT_DIR, relativePath);
}

async function writeRouteFile(route, geojson) {
  const filePath = getOutputPath(route);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(geojson, null, 2) + "\n", "utf8");
  return filePath;
}

function buildManifestEntry(route, geojson) {
  const feature = geojson?.features?.[0] || {};
  const properties = feature.properties || {};
  const coords = feature.geometry?.coordinates || route.coords;

  return {
    id: route.id,
    routeFile: route.routeFile || `/routes/${route.id}.geojson`,
    routeStatus: properties.route_status || "preview",
    source: properties.source || "editorial-seed",
    distance_m: properties.distance_m ?? null,
    duration_s: properties.duration_s ?? null,
    bbox: properties.bbox || bboxFromCoords(coords),
    waypoint_count: properties.waypoint_count ?? route.coords.length,
    generated_at: properties.generated_at || new Date().toISOString(),
    coordinates: coords
  };
}

async function writeManifest(entries) {
  const manifestPath = path.join(ROUTES_DIR, "manifest.json");
  const payload = {
    generated_at: new Date().toISOString(),
    routes: entries
  };
  await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return manifestPath;
}

async function buildRouteGeoJSON(route, providers, timeoutMs) {
  for (const provider of providers) {
    try {
      const routed = await buildOfficialRouteResult(route, provider, timeoutMs);
      return buildGeoJSON(route, routed);
    } catch (err) {
      console.warn(`Routing fallback for ${route.id} via ${provider.name}: ${err.message}`);
    }
  }

  return buildGeoJSON(route, buildSeedRouteResult(route));
}

function printBuildMode(config, providers) {
  if (WRITE_SEED_ONLY || config.routingBackend === "seed") {
    console.log("Seed mode: writing preview route files from curated waypoint geometry.");
    return;
  }

  if (!providers.length) {
    console.log("No routing provider configured. Writing preview route files from curated waypoint geometry.");
    return;
  }

  const summary = providers.map(provider => {
    if (provider.name === "osrm") {
      return `${provider.name} (${provider.baseUrl})`;
    }
    return provider.name;
  });

  console.log(`Routing mode: ${summary.join(" -> ")} -> preview seed fallback`);
}

async function main() {
  await fs.mkdir(ROUTES_DIR, { recursive: true });

  const dotEnv = await loadDotEnvConfig();
  const config = {
    routingBackend: getConfigValue(dotEnv, "ROUTING_BACKEND", "auto").toLowerCase(),
    osrmBaseUrl: getConfigValue(dotEnv, "OSRM_BASE_URL", "https://router.project-osrm.org"),
    osrmProfile: getConfigValue(dotEnv, "OSRM_PROFILE", "driving"),
    mapboxProfile: getConfigValue(dotEnv, "MAPBOX_PROFILE", "driving"),
    mapboxToken: getConfigValue(dotEnv, "MAPBOX_ACCESS_TOKEN", getConfigValue(dotEnv, "MAPBOX_TOKEN", "")),
    timeoutMs: toPositiveNumber(getConfigValue(dotEnv, "ROUTING_TIMEOUT_MS", "15000"), 15000)
  };

  const routes = await loadLoops();
  const providers = buildRoutingProviders(config);

  printBuildMode(config, providers);

  const manifestEntries = [];

  for (const route of routes) {
    const geojson = await buildRouteGeoJSON(route, providers, config.timeoutMs);
    const out = await writeRouteFile(route, geojson);
    const manifestEntry = buildManifestEntry(route, geojson);
    manifestEntries.push(manifestEntry);
    console.log(`${manifestEntry.routeStatus} · ${manifestEntry.source} → ${out}`);
  }

  const manifestPath = await writeManifest(manifestEntries);
  console.log(`manifest → ${manifestPath}`);
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
