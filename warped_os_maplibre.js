// warped_os_maplibre.js
// Port of Bill Chadwick's warped_os2.js for MapLibre GL JS using addProtocol.
// Requires proj4.js to be loaded first.

// EPSG:27700 (OSGB36 / British National Grid), with a Helmert shift to WGS84
proj4.defs(
  "EPSG:27700",
  "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 " +
  "+ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 " +
  "+units=m +no_defs"
);

const TILE_SIZE = 256;
const MIN_ZOOM = 6;
const MAX_ZOOM = 16; // OS zooms 10-13 are high cost MasterMap, so limit to 25K.
const TOP_LEFT_EASTING = -238375.0;
const TOP_LEFT_NORTHING = 1376256.0;
const URL_SKELETON = "https://api.os.uk/maps/raster/v1/zxy/{layer}/{z}/{x}/{y}.png?key={key}";

// OS zoom levels from Google zoom level. OS 6 & 7 are 1:50K, 8 & 9 are 1:25K
var O_ZOOM_FROM_GZOOM = [
  0, 0, 0, 0, 0, 
  0, 0, 0, 1, 2, 
  3, 4, 5, 6, 7, 
  8, 9, 10, 11, 12,
  13, 13, 13, 13
];

const O_ZOOM_FROM_GZOOM_50K = [
  0, 0, 0, 0, 0, 
  0, 0, 0, 1, 2, 
  6, 6, 6, 6, 7, 
  7, 7, 10, 11, 12,
  13, 13, 13, 13
];

// index by OS zoom
const OS_LAYERS = [
  "Leisure_27700", "Leisure_27700", "Leisure_27700", "Leisure_27700",
  "Leisure_27700", "Leisure_27700", "Leisure_27700", "Leisure_27700",
  "Leisure_27700", "Leisure_27700",
  "Outdoor_27700", "Outdoor_27700", "Outdoor_27700", "Outdoor_27700" // 10-13 are high cost MasterMap
];

// index by OS zoom to get metres per pixel
const OS_RESOLUTIONS = [
  3199999.999496063, 1599999.9997480316, 799999.9998740158, 399999.9999370079,
  199999.99996850395, 99999.99998425198, 49999.99999212599, 24999.999996062994,
  12499.999998031497, 6249.9999990157485, 3124.9999995078742, 1562.4999997539371,
  781.2499998769686, 390.6249999384843
].map(r => r * 0.00028);

const EARTH_RADIUS = 6378137.0;
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS;

/**
 * Least squares best fit affine transform from ground control points.
 * From Mapping Hacks #33.
 * gcps: [{source:{x,y}, dest:{x,y}}, ...] (three or more)
 * Returns [xOffset, xScale, xRotation, yOffset, yRotation, yScale] or null.
 */
function affineFromGcps(gcps) {
  const n = gcps.length;
  if (n < 3) return null;

  let sum_x = 0, sum_y = 0, sum_xy = 0, sum_xx = 0, sum_yy = 0;
  let sum_Lon = 0, sum_Lonx = 0, sum_Lony = 0;
  let sum_Lat = 0, sum_Latx = 0, sum_Laty = 0;

  for (const g of gcps) {
    const sx = g.source.x, sy = g.source.y, dx = g.dest.x, dy = g.dest.y;
    sum_x += sx;
    sum_y += sy;
    sum_xy += sx * sy;
    sum_xx += sx * sx;
    sum_yy += sy * sy;
    sum_Lon += dx;
    sum_Lonx += dx * sx;
    sum_Lony += dx * sy;
    sum_Lat += dy;
    sum_Latx += dy * sx;
    sum_Laty += dy * sy;
  }

  const divisor = n * (sum_xx * sum_yy - sum_xy * sum_xy)
    + 2 * sum_x * sum_y * sum_xy - sum_y * sum_y * sum_xx
    - sum_x * sum_x * sum_yy;

  if (divisor === 0.0) return null;

  const a = new Array(6);

  a[0] = (sum_Lon * (sum_xx * sum_yy - sum_xy * sum_xy)
        + sum_Lonx * (sum_y * sum_xy - sum_x * sum_yy)
        + sum_Lony * (sum_x * sum_xy - sum_y * sum_xx)) / divisor;

  a[3] = (sum_Lat * (sum_xx * sum_yy - sum_xy * sum_xy)
        + sum_Latx * (sum_y * sum_xy - sum_x * sum_yy)
        + sum_Laty * (sum_x * sum_xy - sum_y * sum_xx)) / divisor;

  a[1] = (sum_Lon * (sum_y * sum_xy - sum_x * sum_yy)
        + sum_Lonx * (n * sum_yy - sum_y * sum_y)
        + sum_Lony * (sum_x * sum_y - sum_xy * n)) / divisor;

  a[2] = (sum_Lon * (sum_x * sum_xy - sum_y * sum_xx)
        + sum_Lonx * (sum_x * sum_y - n * sum_xy)
        + sum_Lony * (n * sum_xx - sum_x * sum_x)) / divisor;

  a[4] = (sum_Lat * (sum_y * sum_xy - sum_x * sum_yy)
        + sum_Latx * (n * sum_yy - sum_y * sum_y)
        + sum_Laty * (sum_x * sum_y - sum_xy * n)) / divisor;

  a[5] = (sum_Lat * (sum_x * sum_xy - sum_y * sum_xx)
        + sum_Latx * (sum_x * sum_y - n * sum_xy)
        + sum_Laty * (n * sum_xx - sum_x * sum_x)) / divisor;

  a[0] += 0.5 * a[1] + 0.5 * a[2];
  a[3] += 0.5 * a[4] + 0.5 * a[5];

  return a;
}

// Web Mercator (EPSG:3857) corner of a Google tile -> OS easting/northing, via proj4
function tileCornerToOs(z, tx, ty) {
  const size = (2 * ORIGIN_SHIFT) / (1 << z);          // tile width in metres
  const mx = -ORIGIN_SHIFT + tx * size;
  const my = ORIGIN_SHIFT - ty * size;
  const [east, north] = proj4("EPSG:3857", "EPSG:27700", [mx, my]);
  return { east, north };
}

async function fetchOsTile(url, signal) {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch (err) {
    if (err.name === "AbortError") throw err;
    return null;
  }
}

async function renderTile(z, x, y, key, layerOverride, signal) {
  const out = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);   // transparent by default

  if (z < MIN_ZOOM || z > MAX_ZOOM) return createImageBitmap(out);

  // OS coordinates of the four corners of the Google tile
  const oTl = tileCornerToOs(z, x, y);
  const oTr = tileCornerToOs(z, x + 1, y);
  const oBl = tileCornerToOs(z, x, y + 1);
  const oBr = tileCornerToOs(z, x + 1, y + 1);

  // containing bounds
  const osLeft = Math.min(oTl.east, oBl.east);
  const osRight = Math.max(oBr.east, oTr.east);
  const osTop = Math.max(oTl.north, oTr.north);
  const osBottom = Math.min(oBr.north, oBl.north);

  const oz = O_ZOOM_FROM_GZOOM[z];
  const res = OS_RESOLUTIONS[oz];
  const tileMeters = res * TILE_SIZE;
  const layer = layerOverride || OS_LAYERS[oz];

  // OS tiles needed to cover the Google tile
  const west = Math.floor((osLeft - TOP_LEFT_EASTING) / tileMeters);
  const east = Math.ceil((osRight - TOP_LEFT_EASTING) / tileMeters);
  const north = Math.floor((TOP_LEFT_NORTHING - osTop) / tileMeters);
  const south = Math.ceil((TOP_LEFT_NORTHING - osBottom) / tileMeters);

  const cols = east - west;
  const rows = south - north;
  if (cols <= 0 || rows <= 0) return createImageBitmap(out);

  // fetch all OS tiles in parallel (the browser HTTP cache handles repeats)
  const jobs = [];
  for (let e = west; e < east; e++) {
    for (let n = north; n < south; n++) {
      if (e < 0 || n < 0) continue;
      const url = URL_SKELETON
        .replace("{key}", key)
        .replace("{layer}", layer)
        .replace("{z}", oz)
        .replace("{x}", e)
        .replace("{y}", n);
      jobs.push(
        fetchOsTile(url, signal).then(bmp => ({ bmp, px: (e - west) * TILE_SIZE, py: (n - north) * TILE_SIZE }))
      );
    }
  }
  const tiles = await Promise.all(jobs);

  // stitch into a mosaic
  const mosaic = new OffscreenCanvas(cols * TILE_SIZE, rows * TILE_SIZE);
  const mctx = mosaic.getContext("2d");
  for (const t of tiles) {
    if (t.bmp) {
      mctx.drawImage(t.bmp, t.px, t.py, TILE_SIZE, TILE_SIZE);
      t.bmp.close();
    }
  }

  // affine transform from mosaic pixels to Google tile pixels
  const dWest = TOP_LEFT_EASTING + west * tileMeters;
  const dNorth = TOP_LEFT_NORTHING - north * tileMeters;
  const src = p => ({ x: (p.east - dWest) / res, y: (dNorth - p.north) / res });

  const mtx = affineFromGcps([
    { source: src(oTl), dest: { x: 0, y: 0 } },
    { source: src(oTr), dest: { x: TILE_SIZE, y: 0 } },
    { source: src(oBl), dest: { x: 0, y: TILE_SIZE } },
    { source: src(oBr), dest: { x: TILE_SIZE, y: TILE_SIZE } }
  ]);
  if (!mtx) return createImageBitmap(out);

  // same element order as the SVG matrix(m1, m4, m2, m5, m0, m3)
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(mtx[1], mtx[4], mtx[2], mtx[5], mtx[0], mtx[3]);
  ctx.drawImage(mosaic, 0, 0);

  return createImageBitmap(out);
}

/**
 * Register the warped OS protocol with MapLibre.
 * options.key:      OS Maps API key (required)
 * options.layer:    optional layer override, e.g. "Leisure_27700"
 * options.protocol: protocol name, default "wos"
 * options.lock50K:  true to use 50K mapping at more zoom levels, e.g. for 3d terrain drape
 */
function registerWarpedOs(maplibregl, options) {
  const protocol = options.protocol || "wos";
  if (options.lock50K) {
	  for (let i =0; i<O_ZOOM_FROM_GZOOM_50K.length;i++) {
		  O_ZOOM_FROM_GZOOM[i] = O_ZOOM_FROM_GZOOM_50K[i];
	  }
  }
  
  maplibregl.addProtocol(protocol, async (params, abortController) => {
    const m = /^[^:]+:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error("Bad tile URL: " + params.url);
    const [z, x, y] = m.slice(1).map(Number);
    const data = await renderTile(z, x, y, options.key, options.layer || null, abortController.signal);
    return { data };      // an ImageBitmap
  });
  return protocol;
}