const proj4 = window.proj4;
if (!proj4) {
  throw new Error("Proj4 library is required but not loaded.");
}

const WGS84 = "EPSG:4326";

const projDefinitions = {
  "EPSG:32161":
    "+proj=lcc +lat_0=17.8333333333333 +lon_0=-66.4333333333333 +lat_1=18.4333333333333 +lat_2=18.0333333333333 +x_0=200000 +y_0=200000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  "EPSG:4269": "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs +type=crs",
  "CRS:84": "+proj=longlat +datum=WGS84 +no_defs +type=crs"
};

function ensureProjDefinition(code) {
  if (!code) return;
  if (!proj4.defs(code) && projDefinitions[code]) {
    proj4.defs(code, projDefinitions[code]);
  }
}

function parseCrs(geojson) {
  const crs = geojson?.crs?.properties?.name;
  if (!crs) return WGS84;
  const match = crs.match(/EPSG[:/]*(\d+)/i);
  if (match) {
    return `EPSG:${match[1]}`;
  }
  if (/CRS84/i.test(crs) || /OGC:1\.3:CRS84/i.test(crs)) {
    return "CRS:84";
  }
  return WGS84;
}

function createTransformer(fromCode) {
  if (!fromCode || fromCode === WGS84 || fromCode === "CRS:84" || fromCode === "EPSG:4326") {
    return coords => coords.slice(0, 2);
  }
  ensureProjDefinition(fromCode);
  return coords => {
    const [x, y] = coords;
    const [lon, lat] = proj4(fromCode, WGS84, [x, y]);
    return [lon, lat];
  };
}

function transformGeometry(geometry, transform) {
  if (!geometry) return geometry;

  const apply = coords => {
    if (typeof coords[0] === "number") {
      return transform(coords);
    }
    return coords.map(apply);
  };

  switch (geometry.type) {
    case "Point":
      return { ...geometry, coordinates: transform(geometry.coordinates) };
    case "MultiPoint":
    case "LineString":
      return { ...geometry, coordinates: geometry.coordinates.map(transform) };
    case "MultiLineString":
    case "Polygon":
      return { ...geometry, coordinates: geometry.coordinates.map(ring => ring.map(transform)) };
    case "MultiPolygon":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map(poly => poly.map(ring => ring.map(transform)))
      };
    default:
      return geometry;
  }
}

function normalizeFeatures(geojson) {
  const fromCode = parseCrs(geojson);
  const transformer = createTransformer(fromCode);
  return (geojson.features || []).map(feature => ({
    ...feature,
    geometry: transformGeometry(feature.geometry, transformer)
  }));
}

function geometryCentroid(geometry) {
  if (!geometry) return null;
  const accumulate = coords =>
    coords.reduce(
      (acc, pair) => {
        acc[0] += pair[0];
        acc[1] += pair[1];
        return acc;
      },
      [0, 0]
    );

  switch (geometry.type) {
    case "Point":
      return geometry.coordinates.slice(0, 2);
    case "MultiPoint": {
      const sum = accumulate(geometry.coordinates.map(coord => coord.slice(0, 2)));
      return [sum[0] / geometry.coordinates.length, sum[1] / geometry.coordinates.length];
    }
    case "LineString":
    case "Polygon": {
      const outer = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates;
      const clean = outer.filter(Boolean).map(pt => pt.slice(0, 2));
      if (!clean.length) return null;
      const sum = accumulate(clean);
      return [sum[0] / clean.length, sum[1] / clean.length];
    }
    case "MultiPolygon": {
      const centroids = geometry.coordinates
        .map(poly => {
          const outer = poly[0] || [];
          const clean = outer.filter(Boolean).map(pt => pt.slice(0, 2));
          if (!clean.length) return null;
          const sum = accumulate(clean);
          return [sum[0] / clean.length, sum[1] / clean.length];
        })
        .filter(Boolean);
      if (!centroids.length) return null;
      const sum = accumulate(centroids);
      return [sum[0] / centroids.length, sum[1] / centroids.length];
    }
    default:
      return null;
  }
}

function geometryBounds(geometry) {
  if (!geometry) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const update = coords => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    const lon = coords[0];
    const lat = coords[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };

  const walk = coords => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") {
      update(coords);
    } else {
      coords.forEach(walk);
    }
  };

  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
    case "LineString":
    case "MultiLineString":
    case "Polygon":
    case "MultiPolygon":
      walk(geometry.coordinates);
      break;
    default:
      return null;
  }

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) {
    return null;
  }
  return [minLon, minLat, maxLon, maxLat];
}

const infoPanel = {
  risk: document.querySelector("#risk-section .info-body"),
  shelter: document.querySelector("#shelter-section .info-body"),
  insurance: document.querySelector("#insurance-section .info-body")
};

const tutorialModal = document.getElementById("tutorial-modal");
const tutorialCloseButtons = tutorialModal
  ? tutorialModal.querySelectorAll('[data-tutorial-close]')
  : [];

const parcelSearchForm = document.getElementById("parcel-search-form");
const parcelSearchInput = document.getElementById("parcel-search-input");
const parcelSearchFeedback = document.getElementById("parcel-search-feedback");
const RISK_TOOLTIP_ALIGN_CLASSES = [
  "risk-summary__tooltip-content--align-left",
  "risk-summary__tooltip-content--align-right"
];

function showTutorialModal() {
  if (!tutorialModal) return;
  tutorialModal.classList.remove("hidden");
  tutorialModal.setAttribute("aria-hidden", "false");
  const actionButton = tutorialModal.querySelector(".tutorial-modal__action");
  if (actionButton) {
    actionButton.focus({ preventScroll: true });
  }
}

function hideTutorialModal() {
  if (!tutorialModal) return;
  tutorialModal.classList.add("hidden");
  tutorialModal.setAttribute("aria-hidden", "true");
}

const calcNoteHtml =
  '<div class="calc-note">'
  + '<a href="#" id="calc-note-link">How are these numbers calculated?</a>'
  + '</div>';

const insurancePlaceholderHtml =
  '<p class="info-placeholder">Get a quick estimate of insurance needs based on your property value and flood risk.</p>' + calcNoteHtml;

const legendRefs = {
  parcelMin: document.querySelector(".parcel-min"),
  parcelMax: document.querySelector(".parcel-max"),
  parcelGradient: document.querySelector(".parcel-gradient-bar")
};

const ACRE_IN_SQ_METERS = 4046.8564224;
const zoneRiskPercentScale = {
  VE: 0.95,
  AE: 0.8,
  AO: 0.65,
  A: 0.5,
  X: 0.3,
  none: 0.1
};
const WATER_ISLAND_TOKEN = "WATER ISLAND";
const WATER_ISLAND_SHELTER_NAME = "Water Island Station";

function pointWithinBounds(point, bounds) {
  if (!Array.isArray(point) || point.length < 2 || !Array.isArray(bounds) || bounds.length < 4) {
    return false;
  }
  const [lon, lat] = point;
  const [minLon, minLat, maxLon, maxLat] = bounds;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function markerPosition(percent) {
  const clamped = clampPercent(percent);
  if (clamped === null) return null;
  return Math.min(98.5, Math.max(1.5, clamped * 100));
}

function createPercentileRanker(values) {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) {
    return () => null;
  }
  if (sorted.length === 1) {
    return value => (Number.isFinite(value) ? 0.5 : null);
  }
  if (sorted[0] === sorted[sorted.length - 1]) {
    return value => (Number.isFinite(value) ? 0.5 : null);
  }
  return value => {
    if (!Number.isFinite(value)) return null;
    if (value <= sorted[0]) return 0;
    const lastIndex = sorted.length - 1;
    if (value >= sorted[lastIndex]) return 1;
    let low = 0;
    let high = lastIndex;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (sorted[mid] < value) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    let firstIndex = Math.max(0, low);
    while (firstIndex > 0 && sorted[firstIndex - 1] === value) {
      firstIndex -= 1;
    }
    let lastEqual = firstIndex;
    while (lastEqual + 1 < sorted.length && sorted[lastEqual + 1] === value) {
      lastEqual += 1;
    }
    if (sorted[firstIndex] === value) {
      const meanIndex = (firstIndex + lastEqual) / 2;
      return meanIndex / lastIndex;
    }
    const prevValue = sorted[firstIndex - 1];
    const nextValue = sorted[firstIndex];
    const span = nextValue - prevValue || 1;
    const fractionalIndex = firstIndex - 1 + (value - prevValue) / span;
    return fractionalIndex / lastIndex;
  };
}

function getZoneRiskPercent(zoneId) {
  return zoneRiskPercentScale[zoneId] ?? zoneRiskPercentScale.none;
}

const showPlaceholder = () => {
  infoPanel.risk.innerHTML =
    '<p class="info-placeholder">Click on the map to explore flood zone details for your location.</p>';
  infoPanel.shelter.innerHTML =
    '<p class="info-placeholder">We will list the nearest shelter and travel distance.</p>';
  infoPanel.insurance.innerHTML = insurancePlaceholderHtml;
  clearShelterConnection();
  updateShelterIcons(null);
  attachCalcModalHandlers();
};

const css = getComputedStyle(document.documentElement);

const floodZonesConfig = [
  {
    id: "VE",
    label: "Zone VE",
    color: css.getPropertyValue("--zone-ve").trim() || "#d95d39",
    file: "data/VE.geojson",
    description: "Very high coastal flood risk with wave action of 3 ft or more (coastal velocity zone).",
    defaultVisible: true
  },
  {
    id: "AE",
    label: "Zone AE",
    color: css.getPropertyValue("--zone-ae").trim() || "#f07918",
    file: "data/AE.geojson",
    description: "High flood risk with Base Flood Elevation determined (1% annual chance flood).",
    defaultVisible: true
  },
  {
    id: "AO",
    label: "Zone AO",
    color: css.getPropertyValue("--zone-ao").trim() || "#f4a261",
    file: "data/AO.geojson",
    description: "Sloping terrain flood risk with sheet flow, average depths of 1 to 3 feet.",
    defaultVisible: true
  },
  {
    id: "A",
    label: "Zone A",
    color: css.getPropertyValue("--zone-a").trim() || "#e9c46a",
    file: "data/A.geojson",
    description: "High flood risk areas without detailed studies or Base Flood Elevation.",
    defaultVisible: true
  },
  {
    id: "X",
    label: "Zone X",
    color: css.getPropertyValue("--zone-x").trim() || "#8ab17d",
    file: "data/X.geojson",
    description: "Moderate-to-minimal flood risk; flooding is possible but less likely than in SFHA zones.",
    defaultVisible: false
  }
];

const zoneConfigMap = new Map(floodZonesConfig.map(config => [config.id, config]));
const zonePriority = ["VE", "AE", "AO", "A", "X"];

const riskProfiles = {
  VE: {
    severity: "Severe coastal flood hazard",
    recommendation:
      "Flood insurance is mandatory for federally backed mortgages. Prepare for storm surge and wave damage with elevated structures and coastal hardening.",
    premiumRate: 0.018
  },
  AE: {
    severity: "High flood hazard",
    recommendation:
      "Insurance is required in most cases. Elevate utilities above the Base Flood Elevation and plan for 1% annual chance floods.",
    premiumRate: 0.015
  },
  AO: {
    severity: "Moderate flood hazard (sheet flow)",
    recommendation:
      "Insurance strongly recommended. Consider grading or barriers to redirect shallow flooding away from the property.",
    premiumRate: 0.012
  },
  A: {
    severity: "Elevated flood hazard",
    recommendation:
      "Insurance required for most mortgages. Request an elevation certificate to refine premiums and mitigation needs.",
    premiumRate: 0.012
  },
  X: {
    severity: "Lower flood hazard",
    recommendation:
      "Preferred risk policies are available. Insurance optional but still advised because 25% of flood claims originate in lower risk zones.",
    premiumRate: 0.006
  },
  none: {
    severity: "Minimal mapped flood hazard",
    recommendation:
      "Consider low-cost protection if near flood-prone areas. Maintain drainage and monitor future map updates.",
    premiumRate: 0.004
  }
};

const floodZoneLayers = new Map();
const zoneFeatureMap = new Map();

const dataStore = {
  shelterFeatures: [],
  shelterCollection: null,
  parcelCollection: null
};

const mapBounds = L.latLngBounds();
let selectionMarker = null;
let shelterLayer = null;
let shelterLayerVisible = true;
let parcelLayer = null;
let parcelLayerVisible = true;
let parcelBreaks = [];
let parcelStats = null;
let parcelBounds = null;
let parcelCentroid = null;
let shelterConnectionLayer = null;

showPlaceholder();

const parcelColorRamp = ["#f7fbff", "#c6dbef", "#6baed6", "#3182bd", "#08519c"];
const shelterIcon = L.icon({
  iconUrl: "picture/shelter.png",
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -24]
});
const shelterIconSmall = L.icon({
  iconUrl: "picture/shelter.png",
  iconSize: [14, 14],
  iconAnchor: [7, 14],
  popupAnchor: [0, -12]
});
const selectionIcon = L.icon({
  iconUrl: "picture/location.png",
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -24]
});

const map = L.map("map", { zoomSnap: 0 });
const MAPBOX_STYLE_URL =
  "https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/{z}/{x}/{y}@2x?access_token=pk.eyJ1IjoiamluaGVuZ2MiLCJhIjoiY21mZWNtczV2MDVlNjJqb2xjYzIzaG1vYyJ9.3RSRjdENKBwjuf8_hhAqUA";

L.tileLayer(MAPBOX_STYLE_URL, {
  maxZoom: 18,
  zoomOffset: -1,
  tileSize: 512,
  attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

map.setView([18.34, -64.9], 12);
map.on("click", handleMapClick);
map.on("zoomend", () => {
  if (parcelLayer) {
    parcelLayer.setStyle(parcelStyle);
  }
});

const ZONE_PANE = "zonePane";
const PARCEL_PANE = "parcelPane";
const CONNECTION_PANE = "connectionPane";
map.createPane(PARCEL_PANE);
map.getPane(PARCEL_PANE).style.zIndex = 410;
map.createPane(ZONE_PANE);
map.getPane(ZONE_PANE).style.zIndex = 430;
map.getPane(ZONE_PANE).style.pointerEvents = "none";
map.createPane(CONNECTION_PANE);
map.getPane(CONNECTION_PANE).style.zIndex = 440;
map.getPane(CONNECTION_PANE).style.pointerEvents = "none";

window.map = map;

function bringSelectionMarkerToFront() {
  if (selectionMarker && selectionMarker.bringToFront) {
    selectionMarker.bringToFront();
  }
}

function extendBoundsFromGeometry(geometry) {
  if (!geometry) return;
  const extend = coord => {
    if (!Array.isArray(coord) || coord.length < 2) return;
    const [lon, lat] = coord;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    mapBounds.extend([lat, lon]);
  };

  switch (geometry.type) {
    case "Point":
      extend(geometry.coordinates);
      break;
    case "MultiPoint":
    case "LineString":
      geometry.coordinates.forEach(extend);
      break;
    case "MultiLineString":
    case "Polygon":
      geometry.coordinates.forEach(ring => {
        if (Array.isArray(ring)) {
          ring.forEach(extend);
        }
      });
      break;
    case "MultiPolygon":
      geometry.coordinates.forEach(poly => {
        if (Array.isArray(poly)) {
          poly.forEach(ring => {
            if (Array.isArray(ring)) {
              ring.forEach(extend);
            }
          });
        }
      });
      break;
    default:
      break;
  }
}

function createZoneLayer(config, features) {
  const collection = { type: "FeatureCollection", features };
  return L.geoJSON(collection, {
    pane: ZONE_PANE,
    interactive: false,
    style: () => ({
      stroke: false,
      fillColor: config.color || "#999999",
      fillOpacity: config.id === "A" || config.id === "AO" ? 0.65 : 0.55
    }),
    onEachFeature: (_, layer) => {
      layer.bindTooltip(config.label, { direction: "top", offset: [0, -6], sticky: true });
    }
  });
}

function toggleZoneLayer(zoneId, visible) {
  const entry = floodZoneLayers.get(zoneId);
  if (!entry) return;
  entry.visible = visible;
    if (visible) {
      entry.layer.addTo(map);
      entry.layer.bringToFront();
      bringSelectionMarkerToFront();
    } else {
    entry.layer.remove();
  }
}

function getParcelColor(value) {
  if (!Number.isFinite(value) || !parcelBreaks.length) {
    return parcelColorRamp[Math.floor(parcelColorRamp.length / 2)] || "#3182bd";
  }
  for (let i = 0; i < parcelBreaks.length; i++) {
    if (value <= parcelBreaks[i]) {
      return parcelColorRamp[i];
    }
  }
  return parcelColorRamp[parcelColorRamp.length - 1];
}

function getParcelStrokeWidth() {
  const zoom = map.getZoom();
  if (!Number.isFinite(zoom)) return 0.6;
  if (zoom <= 10) return 0.04;
  if (zoom >= 18) return 0.6;
  return 0.04 + ((zoom - 10) / 8) * 0.56;
}

function parcelStyle(feature) {
  const valuePerSqMeter = Number(feature.properties?.valuePerSqMeter) || 0;
  return {
    color: "#2f4f4f",
    weight: getParcelStrokeWidth(),
    fillColor: getParcelColor(valuePerSqMeter),
    fillOpacity: 0.7
  };
}

function updateParcelLegend(stats) {
  if (!legendRefs.parcelMin || !legendRefs.parcelMax || !legendRefs.parcelGradient) return;
  if (!stats || !Number.isFinite(stats.min) || !Number.isFinite(stats.max)) {
    legendRefs.parcelMin.textContent = "N/A";
    legendRefs.parcelMax.textContent = "N/A";
    legendRefs.parcelGradient.style.background = `linear-gradient(to right, ${parcelColorRamp.join(", ")})`;
    legendRefs.parcelGradient.title = "";
    return;
  }

  legendRefs.parcelMin.textContent = `$${stats.min.toFixed(2)}/m²`;
  legendRefs.parcelMax.textContent = `$${stats.max.toFixed(2)}/m²`;
  legendRefs.parcelGradient.style.background = `linear-gradient(to right, ${parcelColorRamp.join(", ")})`;

  const stops = [stats.min, ...parcelBreaks, stats.max];
  const ranges = [];
  for (let i = 0; i < parcelColorRamp.length; i++) {
    const start = stops[i];
    const end = stops[i + 1];
    if (i === parcelColorRamp.length - 1) {
      ranges.push(`$${start.toFixed(2)}+/m²`);
    } else {
      ranges.push(`$${start.toFixed(2)} – $${end.toFixed(2)}/m²`);
    }
  }
  legendRefs.parcelGradient.title = ranges.join("\n");
}

function toggleParcelLayer(visible) {
  parcelLayerVisible = visible;
  if (!parcelLayer) return;
  if (visible) {
    parcelLayer.addTo(map);
    parcelLayer.bringToFront();
    parcelLayer.setStyle(parcelStyle);
  } else {
    parcelLayer.remove();
  }
  bringSelectionMarkerToFront();
  ensureParcelToggle();
}

function toggleShelterLayer(visible) {
  shelterLayerVisible = visible;
  if (!shelterLayer) return;
  if (visible) {
    shelterLayer.addTo(map);
    bringSelectionMarkerToFront();
  } else {
    shelterLayer.remove();
  }
  ensureShelterToggle();
}

function attachLayerToggle(container, config) {
  const label = document.createElement("label");
  label.className = "layer-toggle";
  label.dataset.zone = config.id;
  label.title = config.description;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.zone = config.id;
  input.checked = !!config.defaultVisible;

  const swatch = document.createElement("span");
  swatch.className = "layer-toggle__swatch";
  swatch.style.background = config.color || "#cccccc";
  swatch.setAttribute("aria-hidden", "true");

  const span = document.createElement("span");
  span.textContent = config.label;

  label.append(input, swatch, span);
  container.append(label);

  input.addEventListener("change", event => {
    toggleZoneLayer(config.id, event.target.checked);
  });

  return label;
}

function ensureParcelToggle() {
  const container = document.getElementById("layer-toggles");
  if (!container) return;

  let label = container.querySelector("[data-layer='parcel']");
  if (label) {
    container.removeChild(label);
  } else {
    label = document.createElement("label");
    label.className = "layer-toggle";
    label.dataset.layer = "parcel";
    label.title = "Toggle parcel value visualization";
    const input = document.createElement("input");
    input.type = "checkbox";
    const swatch = document.createElement("span");
    swatch.className = "layer-toggle__swatch";
    swatch.style.background = "linear-gradient(to right, #f7fbff, #c6dbef, #6baed6, #3182bd, #08519c)";
    swatch.setAttribute("aria-hidden", "true");
    const span = document.createElement("span");
    span.textContent = "Parcel Value";
    label.append(input, swatch, span);
    input.addEventListener("change", event => {
      toggleParcelLayer(event.target.checked);
    });
  }

  container.append(label);

  const input = label.querySelector("input");
  input.checked = parcelLayerVisible && !!parcelLayer;
  input.disabled = !parcelLayer;
}

function ensureShelterToggle() {
  const container = document.getElementById("layer-toggles");
  if (!container) return;

  let label = container.querySelector("[data-layer='shelter']");
  if (label) {
    container.removeChild(label);
  } else {
    label = document.createElement("label");
    label.className = "layer-toggle";
    label.dataset.layer = "shelter";
    label.title = "Toggle shelter locations";
    const input = document.createElement("input");
    input.type = "checkbox";
    const swatch = document.createElement("span");
    swatch.className = "layer-toggle__swatch layer-toggle__swatch--icon";
    swatch.style.backgroundImage = 'url("picture/shelter.png")';
    swatch.setAttribute("aria-hidden", "true");
    const span = document.createElement("span");
    span.textContent = "Shelters";
    label.append(input, swatch, span);
    input.addEventListener("change", event => {
      toggleShelterLayer(event.target.checked);
    });
  }

  container.append(label);

  const input = label.querySelector("input");
  input.checked = shelterLayerVisible && !!shelterLayer;
  input.disabled = !shelterLayer;
}

function updateShelterIcons(activeFeature) {
  if (!shelterLayer) return;
  shelterLayer.eachLayer(layer => {
    if (!layer.setIcon) return;
    if (!activeFeature) {
      layer.setIcon(shelterIcon);
      if (layer.setZIndexOffset) layer.setZIndexOffset(0);
      return;
    }

    if (layer.feature === activeFeature) {
      layer.setIcon(shelterIcon);
      if (layer.bringToFront) layer.bringToFront();
      if (layer.setZIndexOffset) layer.setZIndexOffset(1000);
    } else {
      layer.setIcon(shelterIconSmall);
      if (layer.setZIndexOffset) layer.setZIndexOffset(0);
    }
  });
}

function clearShelterConnection() {
  if (shelterConnectionLayer) {
    shelterConnectionLayer.remove();
    shelterConnectionLayer = null;
  }
}

function getShelterLonLat(feature) {
  if (!feature?.geometry) return null;
  const geom = feature.geometry;
  if (geom.type === "Point") {
    const coords = geom.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      return [coords[0], coords[1]];
    }
  } else if (geom.type === "MultiPoint" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
    const coords = geom.coordinates[0];
    if (Array.isArray(coords) && coords.length >= 2) {
      return [coords[0], coords[1]];
    }
  }
  return null;
}

function getParcelLonLat(parcelFeature) {
  if (!parcelFeature) return null;
  const centroid = parcelFeature.properties?.__centroid;
  if (
    Array.isArray(centroid) &&
    centroid.length >= 2 &&
    Number.isFinite(centroid[0]) &&
    Number.isFinite(centroid[1])
  ) {
    return centroid;
  }
  const lon = Number(parcelFeature.properties?.LONGITUDE);
  const lat = Number(parcelFeature.properties?.LATITUDE);
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    return [lon, lat];
  }
  if (parcelFeature.geometry) {
    const computed = geometryCentroid(parcelFeature.geometry);
    if (
      computed &&
      Number.isFinite(computed[0]) &&
      Number.isFinite(computed[1])
    ) {
      return computed;
    }
  }
  return null;
}

function renderShelterConnection(selectionLonLat, shelterFeature) {
  clearShelterConnection();
  if (!selectionLonLat || !shelterFeature) return;
  const shelterLonLat = getShelterLonLat(shelterFeature);
  if (!shelterLonLat) return;

  const startLatLng = [selectionLonLat[1], selectionLonLat[0]];
  const endLatLng = [shelterLonLat[1], shelterLonLat[0]];
  const linePoints = [startLatLng, endLatLng];

  shelterConnectionLayer = L.polyline(linePoints, {
    color: "#ff3b30",
    weight: 1.5,
    opacity: 0.9,
    pane: CONNECTION_PANE,
    smoothFactor: 1.2
  }).addTo(map);
  bringSelectionMarkerToFront();
}

async function loadFloodZones() {
  const container = document.getElementById("layer-toggles");
  container.innerHTML = "";

  for (const config of floodZonesConfig) {
    try {
      const response = await fetch(config.file);
      if (!response.ok) {
        throw new Error(`Failed to load ${config.file}`);
      }
      const geojson = await response.json();
      const normalized = normalizeFeatures(geojson).filter(f => f.geometry);
      const features = normalized.map(f => {
        const bounds = geometryBounds(f.geometry);
        return {
          ...f,
          properties: { ...f.properties, __zoneId: config.id, __bounds: bounds }
        };
      });

      zoneFeatureMap.set(config.id, features);

      for (const feature of features) {
        extendBoundsFromGeometry(feature.geometry);
      }

      const layer = createZoneLayer(config, features);
      floodZoneLayers.set(config.id, {
        layer,
        features,
        description: config.description,
        visible: !!config.defaultVisible
      });

      if (config.defaultVisible) {
        layer.addTo(map);
        layer.bringToFront();
      }
    } catch (error) {
      console.error(error);
    }

    const toggle = attachLayerToggle(container, config);
    const input = toggle.querySelector("input");
    const entry = floodZoneLayers.get(config.id);
    if (!entry) {
      input.checked = false;
      input.disabled = true;
    } else {
      input.checked = !!entry.visible;
    }
  }

  ensureShelterToggle();
  ensureParcelToggle();
}

async function loadShelters() {
  try {
    const response = await fetch("data/shelter.geojson");
    if (!response.ok) {
      throw new Error("Unable to load shelter data.");
    }
    const geojson = await response.json();
    const normalized = normalizeFeatures(geojson).filter(f => f.geometry);

    dataStore.shelterFeatures = normalized;
    dataStore.shelterCollection = { type: "FeatureCollection", features: normalized };

    for (const feature of normalized) {
      extendBoundsFromGeometry(feature.geometry);
    }

    if (shelterLayer) {
      shelterLayer.remove();
      shelterLayer = null;
    }

    if (normalized.length) {
      shelterLayer = L.geoJSON(dataStore.shelterCollection, {
        pointToLayer: (feature, latlng) => L.marker(latlng, { icon: shelterIcon }),
        onEachFeature: (feature, layer) => {
          const name = feature.properties?.Name || "Shelter";
          layer.bindTooltip(name, { direction: "top", offset: [0, -8] });
        }
      });

      if (shelterLayerVisible) {
        shelterLayer.addTo(map);
        bringSelectionMarkerToFront();
      }
    } else {
      shelterLayerVisible = false;
    }

    ensureShelterToggle();
    updateShelterIcons(null);
  } catch (error) {
    console.error(error);
    ensureShelterToggle();
  }
}

async function loadParcelValues() {
  try {
    const response = await fetch("data/parcel_value.geojson");
    if (!response.ok) {
      throw new Error("Unable to load parcel value data.");
    }
    const geojson = await response.json();
    const normalized = normalizeFeatures(geojson).filter(f => f.geometry);

    parcelBounds = L.latLngBounds();
    parcelCentroid = null;
    let centroidLonSum = 0;
    let centroidLatSum = 0;
    let centroidCount = 0;
    const metricDistributions = {
      totalValue: [],
      improvementValue: [],
      valuePerAcre: []
    };

    const parcels = normalized
      .map(feature => {
        const landValue = Number(feature.properties?.Land_Value) || 0;
        const improvementValue = Number(feature.properties?.Improved_V) || 0;
        const totalValue = landValue + improvementValue;
        const centroid = geometryCentroid(feature.geometry);
        const fallbackLon = Number(feature.properties?.LONGITUDE);
        const fallbackLat = Number(feature.properties?.LATITUDE);
        const centroidCoords =
          centroid && Number.isFinite(centroid[0]) && Number.isFinite(centroid[1])
            ? centroid
            : Number.isFinite(fallbackLon) && Number.isFinite(fallbackLat)
            ? [fallbackLon, fallbackLat]
            : null;

        if (!feature.geometry) return null;

        const areaSqMeters = Number(feature.properties?.SHAPE_Area) || 0;
        const valuePerSqMeter = areaSqMeters > 0 ? totalValue / areaSqMeters : 0;
        const acres = areaSqMeters > 0 ? areaSqMeters / ACRE_IN_SQ_METERS : 0;
        const valuePerAcre = acres > 0 ? totalValue / acres : 0;

        metricDistributions.totalValue.push(totalValue);
        metricDistributions.improvementValue.push(improvementValue);
        metricDistributions.valuePerAcre.push(valuePerAcre);

        const bounds = geometryBounds(feature.geometry);

        return {
          ...feature,
          properties: {
            ...feature.properties,
            landValue,
            improvementValue,
            totalValue,
            valuePerSqMeter,
            valuePerAcre,
            displayName: feature.properties?.Name || "Unnamed Parcel",
            __centroid: centroidCoords,
            __bounds: bounds
          }
        };
      })
      .filter(Boolean);

    dataStore.parcelCollection = { type: "FeatureCollection", features: parcels };

    for (const feature of parcels) {
      const centroid = feature.properties?.__centroid;
      if (centroid && Number.isFinite(centroid[0]) && Number.isFinite(centroid[1])) {
        const latLng = [centroid[1], centroid[0]];
        parcelBounds.extend(latLng);
        centroidLonSum += centroid[0];
        centroidLatSum += centroid[1];
        centroidCount += 1;
      } else if (feature.geometry) {
        const geomCentroid = geometryCentroid(feature.geometry);
        if (geomCentroid && Number.isFinite(geomCentroid[0]) && Number.isFinite(geomCentroid[1])) {
          parcelBounds.extend([geomCentroid[1], geomCentroid[0]]);
          centroidLonSum += geomCentroid[0];
          centroidLatSum += geomCentroid[1];
          centroidCount += 1;
        }
      }
    }

    if (centroidCount > 0) {
      parcelCentroid = [centroidLatSum / centroidCount, centroidLonSum / centroidCount];
    }

    const values = parcels
      .map(f => Number(f.properties?.valuePerSqMeter) || 0)
      .filter(v => {
        if (!(v > 0 && Number.isFinite(v))) return false;
        return v >= 0.1 && v <= 5000;
      })
      .sort((a, b) => a - b);

    if (values.length) {
      parcelStats = { min: values[0], max: values[values.length - 1] };
      const quantiles = [0.2, 0.4, 0.6, 0.8];
      parcelBreaks = quantiles.map(q => {
        const index = Math.min(values.length - 1, Math.floor(q * (values.length - 1)));
        return values[index];
      });
    } else {
      parcelStats = null;
      parcelBreaks = [];
    }

    updateParcelLegend(parcelStats);

    if (parcelLayer) {
      parcelLayer.remove();
      parcelLayer = null;
    }

    if (parcels.length) {
      parcelLayer = L.geoJSON(dataStore.parcelCollection, {
        pane: PARCEL_PANE,
        onEachFeature: (feature, layer) => {
          const name = feature.properties?.displayName || "Parcel";
          const totalValue = Number(feature.properties?.totalValue) || 0;
          const valuePerSqMeter = Number(feature.properties?.valuePerSqMeter) || 0;
          layer.bindTooltip(
            `${name}<br>${currencyFormatter.format(totalValue)} total<br>$${valuePerSqMeter.toFixed(2)} / m²`,
            { direction: "top", offset: [0, -6], sticky: true }
          );
        },
        style: parcelStyle
      });

      parcelLayer.setStyle(parcelStyle);

      if (parcelLayerVisible) {
        parcelLayer.addTo(map);
        parcelLayer.bringToFront();
        bringSelectionMarkerToFront();
      }
    } else {
      parcelLayerVisible = false;
    }

    ensureParcelToggle();
    const parcelToggleInput = document.querySelector("[data-layer='parcel'] input");
    if (parcelToggleInput) {
      parcelToggleInput.checked = parcelLayerVisible && !!parcelLayer;
      parcelToggleInput.disabled = !parcelLayer;
    }

    for (const feature of normalized) {
      extendBoundsFromGeometry(feature.geometry);
    }

    const percentileRankers = {
      totalValue: createPercentileRanker(metricDistributions.totalValue),
      improvementValue: createPercentileRanker(metricDistributions.improvementValue),
      valuePerAcre: createPercentileRanker(metricDistributions.valuePerAcre)
    };

    for (const feature of parcels) {
      const props = feature.properties || {};
      props.percentiles = {
        totalValue: percentileRankers.totalValue(props.totalValue),
        improvementValue: percentileRankers.improvementValue(props.improvementValue),
        valuePerAcre: percentileRankers.valuePerAcre(props.valuePerAcre)
      };
      feature.properties = props;
    }

  } catch (error) {
    console.error(error);
    ensureParcelToggle();
  }
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

const formatDistance = km => {
  const miles = km * 0.621371;
  return `${km.toFixed(2)} km (${miles.toFixed(2)} mi)`;
};

const findFloodZone = point => {
  for (const zoneId of zonePriority) {
    const features = zoneFeatureMap.get(zoneId) || [];
    for (const feature of features) {
      const bounds = feature.properties?.__bounds;
      if (bounds && !pointWithinBounds(point, bounds)) {
        continue;
      }
      if (pointInPolygon(point, feature)) {
        return {
          zoneId,
          description: zoneConfigMap.get(zoneId)?.description ?? "",
          feature
        };
      }
    }
  }
  return null;
};

const findNearestShelter = (point, parcelFeature) => {
  if (!dataStore.shelterFeatures.length) return null;

  const legalDescription = parcelFeature?.properties?.Tax_Legal_;
  const isWaterIslandParcel =
    typeof legalDescription === "string" &&
    legalDescription.toUpperCase().includes(WATER_ISLAND_TOKEN);

  let waterIslandShelter = null;
  let closest = null;
  for (const feature of dataStore.shelterFeatures) {
    const name = (feature.properties?.Name || "").trim();
    if (name.toUpperCase() === WATER_ISLAND_SHELTER_NAME.toUpperCase()) {
      waterIslandShelter = feature;
      if (!isWaterIslandParcel) {
        continue;
      }
    }

    const [lon, lat] = feature.geometry.coordinates;
    const distanceKm = haversine(point[0], point[1], lon, lat);
    if (!closest || distanceKm < closest.distanceKm) {
      closest = { feature, distanceKm };
    }
  }

  if (isWaterIslandParcel && waterIslandShelter) {
    const [lon, lat] = waterIslandShelter.geometry.coordinates;
    return { feature: waterIslandShelter, distanceKm: haversine(point[0], point[1], lon, lat) };
  }

  if (!closest && isWaterIslandParcel && waterIslandShelter) {
    const [lon, lat] = waterIslandShelter.geometry.coordinates;
    return { feature: waterIslandShelter, distanceKm: haversine(point[0], point[1], lon, lat) };
  }

  if (!closest && waterIslandShelter && !isWaterIslandParcel) {
    return null;
  }

  return closest;
};

const findParcelAtPoint = point => {
  if (!dataStore.parcelCollection || dataStore.parcelCollection.features.length === 0) {
    return null;
  }

  for (const feature of dataStore.parcelCollection.features) {
    const bounds = feature.properties?.__bounds;
    if (bounds && !pointWithinBounds(point, bounds)) {
      continue;
    }
    if (pointInPolygon(point, feature)) {
      const centroid = feature.properties?.__centroid;
      let distanceKm = 0;
      if (centroid && centroid.length >= 2) {
        distanceKm = haversine(point[0], point[1], centroid[0], centroid[1]);
      }
      return { feature, distanceKm };
    }
  }

  return null;
};

const renderRiskInfo = zoneResult => {
  const zoneId = zoneResult?.zoneId ?? "none";
  const profile = riskProfiles[zoneId] ?? riskProfiles.none;
  const clampedRisk = clampPercent(getZoneRiskPercent(zoneId));

  let elevationDetails = "";
  let description = "";

  if (zoneResult?.feature) {
    const feature = zoneResult.feature;
    description = zoneResult.description ?? "";
    const baseFloodElevation = Number(feature.properties?.STATIC_BFE);
    const depth = Number(feature.properties?.DEPTH);
    const hasBfe = Number.isFinite(baseFloodElevation) && baseFloodElevation > -9000;
    const hasDepth = Number.isFinite(depth) && depth !== -9999;

    const depthLabel =
      hasBfe || !hasDepth
        ? hasBfe
          ? ""
          : `<p class="info-subtle">Estimated flood depth: <strong>Not available</strong></p>`
        : `<p class="info-subtle">Estimated flood depth: <strong>${depth} ft</strong></p>`;

    const bfeLabel = hasBfe
      ? `<p class="info-subtle">Base Flood Elevation: <strong>${baseFloodElevation} ft</strong></p>`
      : "";

    elevationDetails = `${depthLabel}${bfeLabel}`;
  }

  let summaryTitle;
  let summaryDescription;
  if (zoneId === "none") {
    summaryTitle = "No mapped flood zone";
    summaryDescription =
      "This point is outside the Special Flood Hazard Area. Flash flooding is still possible in extreme storms.";
  } else {
    summaryTitle = `${zoneId} &mdash; ${profile.severity}`;
    summaryDescription = description || "";
  }

  const tooltipLabel =
    zoneId === "none"
      ? "View explanation for areas outside mapped flood zones"
      : `View explanation for ${zoneId} zone`;
  const tooltipHtml = summaryDescription
    ? `
        <span class="risk-summary__tooltip">
          <button
            type="button"
            class="risk-summary__tooltip-trigger"
            aria-label="${tooltipLabel}"
          >
            <img src="picture/question.png" class="risk-summary__tooltip-icon" alt="" aria-hidden="true">
          </button>
          <span class="risk-summary__tooltip-content">${summaryDescription}</span>
        </span>
      `
    : "";

  const summaryHtml = `
    <div class="risk-summary">
      <h3 class="risk-summary__title">
        <span class="risk-summary__title-text">${summaryTitle}</span>
        ${tooltipHtml}
      </h3>
    </div>
  `;

  const riskGaugeHtml =
    clampedRisk === null
      ? ""
      : createRiskGauge({
          label: "Flood Risk Position",
          valueDisplay: zoneId === "none" ? "Outside SFHA" : `${zoneId} zone`,
          zoneId,
          percent: clampedRisk,
          summaryHtml,
          footnote: null
        });

  const riskPanelContent = riskGaugeHtml || summaryHtml;
  infoPanel.risk.innerHTML = `
    <div class="risk-panel">
      ${riskPanelContent}
    </div>
    ${elevationDetails}
  `;

  attachRiskTooltipHandlers(infoPanel.risk);
};

const renderShelterInfo = (shelterResult, parcelFeature) => {
  if (!shelterResult) {
    infoPanel.shelter.innerHTML = `
      <div class="metric-card">
        <strong>Shelter data not available</strong>
        <span>Please contact local emergency management for evacuation guidance.</span>
      </div>
    `;
    clearShelterConnection();
    updateShelterIcons(null);
    return;
  }

  const {
    feature: {
      properties: { Name }
    },
    distanceKm
  } = shelterResult;

  const distanceLabel = formatDistance(distanceKm);
  let navigationButtonHtml = "";

  const shelterLonLat = getShelterLonLat(shelterResult.feature);
  if (shelterLonLat) {
    const [shelterLon, shelterLat] = shelterLonLat;
    const originLabel = parcelFeature?.properties?.displayName
      ? `${parcelFeature.properties.displayName}, USVI Stthomas`
      : "USVI Stthomas";
    const destinationLabel = `${Name}, USVI Stthomas`;
    const navigationUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      originLabel
    )}&destination=${encodeURIComponent(
      `${shelterLat.toFixed(6)},${shelterLon.toFixed(6)}`
    )}&destination_place_id=&origin_place_id=&travelmode=driving&query=${encodeURIComponent(
      `${destinationLabel}`
    )}`;
    navigationButtonHtml = `
      <a
        class="shelter-nav-button"
        href="${navigationUrl}"
        target="_blank"
        rel="noopener noreferrer"
      >
        Navigate to Shelter
      </a>
    `;
  }

  infoPanel.shelter.innerHTML = `
    <div class="metric-card">
      <span>The nearest shelter is:</span>
      <strong>${Name}</strong>
      <span>Distance: ${distanceLabel}</span>
    </div>
    ${navigationButtonHtml}
  `;

  updateShelterIcons(shelterResult.feature);
};

function createGradientMeter({ label, valueDisplay, percent, gradientKey, footnote }) {
  const clamped = clampPercent(percent);
  const marker = markerPosition(clamped);
  if (clamped === null || marker === null) return "";
  const percentLabel = Math.round(clamped * 100);

  let footnoteHtml;
  if (typeof footnote === "string") {
    footnoteHtml = footnote;
  } else if (footnote === null) {
    footnoteHtml = "";
  } else {
    footnoteHtml = `<p class="meter-card__percent">Percentile: ${percentLabel}%</p>`;
  }

  const safeLabel = label ?? "";
  const safeValue = valueDisplay ?? "";
  const gradientClass = gradientKey || "value";

  return `
    <div class="meter-card">
      <div class="meter-card__header">
        <span class="meter-card__label">${safeLabel}</span>
        <span class="meter-card__value">${safeValue}</span>
      </div>
      <div class="gradient-meter">
        <div class="gradient-meter__bar gradient-meter__bar--${gradientClass}">
          <span class="gradient-meter__marker" style="left: ${marker}%;"></span>
        </div>
      </div>
      ${footnoteHtml}
    </div>
  `;
}

function createRiskGauge({ label, valueDisplay, zoneId, percent, summaryHtml, footnote }) {
  const clamped = clampPercent(percent);
  if (clamped === null) return "";
  const safeFootnote = typeof footnote === "string" ? footnote.trim() : "";
  const zoneText = zoneId === "none" ? "N/A" : zoneId;
  const zoneNeedleAngles = {
    VE: -72,
    AE: -36,
    AO: 0,
    A: 36,
    X: 72,
    none: 84
  };
  const fallbackAngle = (clamped * 180 - 90);
  const targetAngle = zoneNeedleAngles[zoneId] ?? fallbackAngle;
  const needleAngle = targetAngle.toFixed(2);

  const footnoteHtml = safeFootnote ? `<p class="risk-gauge__footnote">${safeFootnote}</p>` : "";

  return `
    <div class="risk-gauge-card" role="group">
      <div class="risk-gauge-card__body">
        <div class="risk-gauge">
          <div class="risk-gauge__dial">
            <svg class="risk-gauge__svg" viewBox="0 0 200 120" aria-hidden="true" focusable="false">
              <path class="risk-gauge__segment risk-gauge__segment--ve" d="M10 100 A90 90 0 0 1 27.19 47.1" />
              <path class="risk-gauge__segment risk-gauge__segment--ae" d="M27.19 47.1 A90 90 0 0 1 72.19 14.4" />
              <path class="risk-gauge__segment risk-gauge__segment--ao" d="M72.19 14.4 A90 90 0 0 1 127.81 14.4" />
              <path class="risk-gauge__segment risk-gauge__segment--a" d="M127.81 14.4 A90 90 0 0 1 172.81 47.1" />
              <path class="risk-gauge__segment risk-gauge__segment--x" d="M172.81 47.1 A90 90 0 0 1 190 100" />
            </svg>
            <div class="risk-gauge__needle" style="--needle-angle: ${needleAngle}deg;"></div>
            <div class="risk-gauge__hub"></div>
            <div class="risk-gauge__zone">${zoneText}</div>
          </div>
        </div>
      </div>
      <div class="risk-gauge-card__summary">
        ${summaryHtml ?? ""}
      </div>
      ${footnoteHtml}
    </div>
  `;
}

function renderPropertyMeters(parcelFeature) {
  if (!parcelFeature) return "";
  const props = parcelFeature.properties || {};
  const percentiles = props.percentiles || {};

  const totalValue = Number(props.totalValue);
  const improvementValue = Number(props.improvementValue);
  const valuePerAcre = Number(props.valuePerAcre);

  const cards = [
    {
      label: "Parcel Value",
      valueDisplay: Number.isFinite(totalValue) ? currencyFormatter.format(totalValue) : "N/A",
      percent: percentiles.totalValue,
      gradientKey: "risk"
    },
    {
      label: "Improvement Value",
      valueDisplay: Number.isFinite(improvementValue) ? currencyFormatter.format(improvementValue) : "N/A",
      percent: percentiles.improvementValue,
      gradientKey: "risk"
    },
    {
      label: "Value per Acre",
      valueDisplay: Number.isFinite(valuePerAcre)
        ? `${currencyFormatter.format(valuePerAcre)} / acre`
        : "N/A",
      percent: percentiles.valuePerAcre,
      gradientKey: "risk"
    }
  ]
    .map(item => createGradientMeter(item))
    .filter(Boolean)
    .join("");

  return cards ? `<div class="meter-collection">${cards}</div>` : "";
}

const renderInsuranceInfo = (zoneResult, parcelResult) => {
  const zoneId = zoneResult?.zoneId ?? "none";
  const profile = riskProfiles[zoneId] ?? riskProfiles.none;

  const parcelFeature = parcelResult?.feature;
  const rawPropertyValue = Number(parcelFeature?.properties?.totalValue);

  if (!parcelFeature || !Number.isFinite(rawPropertyValue) || rawPropertyValue <= 0) {
    infoPanel.insurance.innerHTML = insurancePlaceholderHtml;
    attachCalcModalHandlers();
    return;
  }

  let propertyValue = rawPropertyValue;
  const propertyName = parcelFeature.properties?.displayName;

  let fallbackNotice = "";

  if (propertyName) {
    fallbackNotice = `
      <p class="info-subtle">Selected parcel: <strong>${propertyName}</strong></p>
    `;
  }

  const estimatedPremium = Math.min(Math.max(propertyValue * profile.premiumRate, 450), 7200);
  const recommendedCoverage = Math.min(propertyValue, 250000);
  const propertyMetersHtml = renderPropertyMeters(parcelFeature);
  let insuranceRecommendationHtml = "";
  if (profile.recommendation) {
    const trimmedRecommendation = profile.recommendation.trim();
    const needsEmphasis =
      trimmedRecommendation.startsWith("Insurance is required in most cases") ||
      trimmedRecommendation.startsWith("Preferred risk policies are available");
    const recommendationContent = needsEmphasis
      ? `<strong>${profile.recommendation}</strong>`
      : profile.recommendation;
    insuranceRecommendationHtml = `<p>${recommendationContent}</p>`;
  }

  infoPanel.insurance.innerHTML = `
    <div class="metric-card">
      ${fallbackNotice}
      <span>Estimated annual premium for NFIP-level coverage in this zone:</span>
      <strong>${currencyFormatter.format(estimatedPremium)}/year</strong>
    </div>
    ${propertyMetersHtml}
    <p>Recommended building coverage: <span class="info-highlight">${currencyFormatter.format(
      recommendedCoverage
    )}</span>. The National Flood Insurance Program currently caps residential building coverage at $250,000. Consider excess flood insurance if your replacement cost is higher.</p>
    ${insuranceRecommendationHtml}
    ${calcNoteHtml}
  `;

  attachCalcModalHandlers();
};

function attachCalcModalHandlers() {
  const link = document.getElementById('calc-note-link');
  const modal = document.getElementById('calc-modal');
  if (!modal) return;
  const closeTargets = modal.querySelectorAll('[data-calc-close]');

  function open() {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }
  function close() {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  if (link) {
    link.addEventListener('click', (e) => { e.preventDefault(); open(); });
  }
  closeTargets.forEach(el => el.addEventListener('click', close));
}

function updateRiskTooltipPosition(tooltip) {
  if (!tooltip) return;
  const content = tooltip.querySelector(".risk-summary__tooltip-content");
  if (!content) return;
  content.classList.remove(...RISK_TOOLTIP_ALIGN_CLASSES);

  const boundary = tooltip.closest(".info-section") || tooltip.parentElement;
  const boundaryRect = boundary ? boundary.getBoundingClientRect() : { left: 0, right: window.innerWidth };
  const contentRect = content.getBoundingClientRect();
  const margin = 12;

  if (contentRect.right > boundaryRect.right - margin) {
    content.classList.add("risk-summary__tooltip-content--align-right");
  } else if (contentRect.left < boundaryRect.left + margin) {
    content.classList.add("risk-summary__tooltip-content--align-left");
  }
}

function attachRiskTooltipHandlers(container) {
  if (!container) return;
  const tooltips = container.querySelectorAll(".risk-summary__tooltip");
  tooltips.forEach(tooltip => {
    const trigger = tooltip.querySelector(".risk-summary__tooltip-trigger");
    const content = tooltip.querySelector(".risk-summary__tooltip-content");
    if (!trigger || !content) return;

    const open = () => {
      tooltip.classList.add("is-active");
      requestAnimationFrame(() => updateRiskTooltipPosition(tooltip));
    };

    const close = () => {
      tooltip.classList.remove("is-active");
      content.classList.remove(...RISK_TOOLTIP_ALIGN_CLASSES);
    };

    trigger.addEventListener("mouseenter", open);
    trigger.addEventListener("focus", open);
    trigger.addEventListener("blur", close);
    tooltip.addEventListener("mouseleave", close);
    trigger.addEventListener("keydown", event => {
      if (event.key === "Escape" || event.key === "Esc") {
        close();
        trigger.blur();
      }
    });
  });
}

function setParcelSearchFeedback(message, isError = false) {
  if (!parcelSearchFeedback) return;
  parcelSearchFeedback.textContent = message;
  parcelSearchFeedback.classList.toggle("search-feedback--error", !!isError);
}

function findParcelByName(query) {
  if (
    !query ||
    !dataStore.parcelCollection ||
    !Array.isArray(dataStore.parcelCollection.features)
  ) {
    return null;
  }
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return null;
  const candidates = [];
  for (const feature of dataStore.parcelCollection.features) {
    const name = (feature.properties?.displayName || "").trim();
    if (!name) continue;
    const lowerName = name.toLowerCase();
    const index = lowerName.indexOf(normalizedQuery);
    if (index === -1) continue;
    let rank = index;
    if (lowerName === normalizedQuery) {
      rank = -2;
    } else if (index === 0) {
      rank = -1;
    }
    candidates.push({ feature, rank, length: name.length });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.length - b.length;
  });
  return candidates[0].feature;
}

function selectParcelFeature(parcelFeature) {
  if (!parcelFeature) return false;
  const lonLat = getParcelLonLat(parcelFeature);
  if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) {
    return false;
  }
  updateSelectionMarker(lonLat);
  bringSelectionMarkerToFront();

  const targetLatLng = [lonLat[1], lonLat[0]];
  const currentZoom = map.getZoom ? map.getZoom() : 12;
  const desiredZoom = currentZoom < 16 ? 16 : currentZoom;
  if (map.flyTo) {
    map.flyTo(targetLatLng, desiredZoom, { duration: 0.6 });
  } else {
    map.setView(targetLatLng, desiredZoom);
  }

  const zoneResult = findFloodZone(lonLat);
  const shelterResult = findNearestShelter(lonLat, parcelFeature);
  const parcelResult = { feature: parcelFeature, distanceKm: 0 };

  renderRiskInfo(zoneResult);
  renderShelterInfo(shelterResult, parcelFeature);
  renderInsuranceInfo(zoneResult, parcelResult);
  renderShelterConnection(lonLat, shelterResult?.feature);
  return true;
}

function handleParcelSearch(event) {
  event.preventDefault();
  if (!parcelSearchInput) return;
  const query = parcelSearchInput.value.trim();
  if (!query) {
    setParcelSearchFeedback("Enter a parcel name to search.", true);
    return;
  }
  if (!dataStore.parcelCollection || !dataStore.parcelCollection.features?.length) {
    setParcelSearchFeedback("Parcel data is still loading. Please try again shortly.", true);
    return;
  }
  const match = findParcelByName(query);
  if (!match) {
    setParcelSearchFeedback(`No parcel found matching "${query}".`, true);
    return;
  }
  const success = selectParcelFeature(match);
  if (!success) {
    setParcelSearchFeedback("Unable to center on the selected parcel.", true);
    return;
  }
  setParcelSearchFeedback(`Showing parcel: ${match.properties?.displayName || ""}`, false);
}

function pointInRing(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, feature) {
  const geom = feature.geometry;
  if (geom.type === "Polygon") {
    const rings = geom.coordinates;
    if (!pointInRing(point, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(point, rings[i])) return false;
    }
    return true;
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      const rings = poly;
      if (!pointInRing(point, rings[0])) continue;
      let inHole = false;
      for (let i = 1; i < rings.length; i++) {
        if (pointInRing(point, rings[i])) inHole = true;
      }
      if (!inHole) return true;
    }
  }
  return false;
}

function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function updateSelectionMarker(lonLat) {
  const [lon, lat] = lonLat;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const latLng = [lat, lon];
  if (!selectionMarker) {
    selectionMarker = L.marker(latLng, { icon: selectionIcon }).addTo(map);
  } else {
    selectionMarker.setLatLng(latLng);
  }
}

function handleMapClick(event) {
  if (!event?.latlng) return;
  const { lat, lng } = event.latlng;
  const lonLat = [lng, lat];

  const parcelResult = findParcelAtPoint(lonLat);

  if (!parcelResult) {
    if (selectionMarker) {
      selectionMarker.remove();
      selectionMarker = null;
    }
    showPlaceholder();
    return;
  }

  updateSelectionMarker(lonLat);

  const zoneResult = findFloodZone(lonLat);
  const shelterResult = findNearestShelter(lonLat, parcelResult.feature);

  renderRiskInfo(zoneResult);
  renderShelterInfo(shelterResult, parcelResult.feature);
  renderInsuranceInfo(zoneResult, parcelResult);
  renderShelterConnection(lonLat, shelterResult?.feature);
}

if (parcelSearchForm) {
  parcelSearchForm.addEventListener("submit", handleParcelSearch);
}

if (parcelSearchInput) {
  parcelSearchInput.addEventListener("input", () => setParcelSearchFeedback("", false));
}

if (tutorialModal) {
  tutorialCloseButtons.forEach(btn => btn.addEventListener("click", hideTutorialModal));
  tutorialModal.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Esc") {
      hideTutorialModal();
    }
  });
}

showTutorialModal();

async function init() {
  try {
    await Promise.all([loadFloodZones(), loadShelters(), loadParcelValues()]);
    if (parcelBounds && parcelBounds.isValid()) {
      map.fitBounds(parcelBounds.pad(0.05));
    } else if (parcelCentroid) {
      map.setView(parcelCentroid, map.getZoom() || 12);
    } else if (mapBounds.isValid()) {
      map.fitBounds(mapBounds, { padding: [32, 32] });
    }
  } catch (error) {
    console.error(error);
    ensureParcelToggle();
  }
}

init();
