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
const tutorialLanguageButtons = tutorialModal
  ? tutorialModal.querySelectorAll(".tutorial-modal__language-button")
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
  updateTutorialLanguageButtons();
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

function updateTutorialLanguageButtons(lang = currentLanguage) {
  if (!tutorialLanguageButtons.length) return;
  tutorialLanguageButtons.forEach(button => {
    const buttonLang = button.dataset.language;
    const isActive = buttonLang === lang;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

const languageSelect = document.getElementById("language-select");

const supportedLanguages = ["en", "es", "zh"];
let currentLanguage = "en";
let currentSelection = null;

const translations = {
  en: {
    language: {
      label: "Language",
      options: { en: "English", es: "Español", zh: "中文" }
    },
    header: {
      title: "Community Flood Risk Dashboard",
      tagline: "Understand flood exposure, find shelters, and plan insurance coverage."
    },
    search: {
      label: "Search parcel name",
      placeholder: "Search parcel name…",
      button: "Search"
    },
    legend: {
      floodLayers: "Flood Zone Layers",
      instruction: "Select zones to display on the map.",
      zoneGuide: "Zone Guide",
      parcelTitle: "Parcel Value per sq. meter",
      zones: {
        VE: "VE — Coastal flood with wave action",
        AE: "AE — High risk (Base Flood Elevation)",
        AO: "AO — River/stream flood, depth 1-3 ft",
        A: "A — High risk (no Base Flood Elevation)",
        X: "X — Moderate or minimal risk"
      },
      shelter: "Shelters",
      parcelLowDefault: "Low",
      parcelHighDefault: "High",
      parcelUnavailable: "N/A",
      parcelValue: "{amount}/m²",
      parcelRange: "{start} – {end}/m²",
      parcelRangeUpper: "{start}+/m²"
    },
    zones: {
      labels: {
        VE: "Zone VE",
        AE: "Zone AE",
        AO: "Zone AO",
        A: "Zone A",
        X: "Zone X",
        parcel: "Parcel Value",
        shelter: "Shelters"
      },
      descriptions: {
        VE: "Very high coastal flood risk with wave action of 3 ft or more (coastal velocity zone).",
        AE: "High flood risk with Base Flood Elevation determined (1% annual chance flood).",
        AO: "Sloping terrain flood risk with sheet flow, average depths of 1 to 3 feet.",
        A: "High flood risk areas without detailed studies or Base Flood Elevation.",
        X: "Moderate-to-minimal flood risk; flooding is possible but less likely than in SFHA zones.",
        parcel: "Toggle parcel value layer.",
        shelter: "Toggle shelter locations."
      }
    },
    info: {
      riskTitle: "My Flood Risk",
      shelterTitle: "Where to Go During Flood",
      insuranceTitle: "Flood Insurance Guide",
      riskPlaceholder: "Click on the map to explore flood zone details for your location.",
      shelterPlaceholder: "We will list the nearest shelter and travel distance.",
      insurancePlaceholder: "Get a quick estimate of insurance needs based on your property value and flood risk."
    },
    tutorial: {
      title: "Welcome to the Flood Risk Dashboard",
      body:
        "<p>Click anywhere on the map to see the flood risk, the nearest shelter, and view flood insurance suggestions.</p>",
      action: "Got it",
      languageLabel: "Choose your language:",
      language: { en: "English", es: "Español", zh: "中文" }
    },
    footer: {
      sources:
        'Data sources: <a href="https://www.fema.gov/flood-maps" target="_blank" rel="noopener noreferrer">FEMA Flood Maps</a>, <a href="https://usvi-open-data-portal-upenn.hub.arcgis.com" target="_blank" rel="noopener noreferrer">USVI Open Data Portal</a>.'
    },
    risk: {
      noneHeading: "No mapped flood zone",
      noneDescription: "This point is outside the Special Flood Hazard Area. Flash flooding is still possible in extreme storms.",
      severity: {
        VE: "Severe coastal flood hazard",
        AE: "High flood hazard",
        AO: "Moderate flood hazard (sheet flow)",
        A: "Elevated flood hazard",
        X: "Lower flood hazard",
        none: "Minimal mapped flood hazard"
      },
      depthWithValue: '<p class="info-subtle">Estimated flood depth: <strong>{value} ft</strong></p>',
      depthUnavailable: '<p class="info-subtle">Estimated flood depth: <strong>Not available</strong></p>',
      bfeLabel: '<p class="info-subtle">Base Flood Elevation: <strong>{value} ft</strong></p>',
      tooltip: {
        none: "View explanation for areas outside mapped flood zones",
        zone: "View explanation for {zone}"
      },
      gaugeLabel: "Flood Risk Position",
      gaugeValue: {
        none: "Outside SFHA"
      },
      zoneLabelSuffix: "zone",
      gaugeZoneLabel: {
        none: "—"
      }
    },
    insurance: {
      premiumLabel: "Estimated annual premium for NFIP-level coverage in this zone:",
      premiumAmount: "{amount}/year",
      coverageText: 'Recommended building coverage: <span class="info-highlight">{amount}</span>. The National Flood Insurance Program currently caps residential building coverage at $250,000. Consider excess flood insurance if your replacement cost is higher.',
      recommendations: {
        VE: "Flood insurance is mandatory for federally backed mortgages. Prepare for storm surge and wave damage with elevated structures and coastal hardening.",
        AE: "<strong>Insurance is required in most cases. Elevate utilities above the Base Flood Elevation and plan for 1% annual chance floods.</strong>",
        AO: "Insurance strongly recommended. Consider grading or barriers to redirect shallow flooding away from the property.",
        A: "<strong>Insurance required for most mortgages. Request an elevation certificate to refine premiums and mitigation needs.</strong>",
        X: "<strong>Preferred risk policies are available. Insurance optional but still advised because 25% of flood claims originate in lower risk zones.</strong>",
        none: "Consider low-cost protection if near flood-prone areas. Maintain drainage and monitor future map updates."
      },
      selectedParcel: "Selected parcel:",
      calcLink: "How are these numbers calculated?"
    },
    shelter: {
      cardHeading: "The nearest shelter is:",
      distance: "Distance: {distance}",
      noDataTitle: "Shelter data not available",
      noDataDescription: "Please contact local emergency management for evacuation guidance.",
      navigate: "Navigate to Shelter"
    },
    format: {
      distance: "{km} km ({miles} mi)"
    },
    meters: {
      labels: {
        parcelValue: "Parcel Value",
        improvementValue: "Improvement Value",
        valuePerAcre: "Value per Acre"
      },
      unavailable: "N/A",
      perAcre: "{amount} / acre",
      percentile: "Percentile: {percent}%"
    },
    parcels: {
      unknown: "Parcel",
      tooltipTotal: "Total: {value}",
      tooltipPerSquare: "Per m²: {value}"
    },
    placeholders: {
      searchEnter: "Enter a parcel name to search.",
      searchLoading: "Parcel data is still loading. Please try again shortly.",
      searchNotFound: 'No parcel found matching "{query}".',
      searchUnable: "Unable to center on the selected parcel.",
      searchShowing: "Showing parcel: {name}"
    },
    buttons: {
      close: "Close"
    },
    calc: {
      title: "How We Estimate Flood Insurance",
      body:
        "<p>The annual premium shown is a simplified estimate to help compare relative risk between zones. We multiply the parcel's total value (land + improvements) by a zone-specific rate and clamp the result to a reasonable range.</p><ul><li>Premium = clamp(totalValue × rate, minimum $450, maximum $7,200)</li><li>Recommended building coverage = min(totalValue, $250,000)</li></ul><p>Zone rates used: VE 1.8%, AE 1.5%, AO 1.2%, A 1.2%, X 0.6%, and 0.4% if no mapped zone. These are heuristic placeholders and not official NFIP rates.</p><p>Actual premiums depend on many additional variables (elevation certificate, foundation type, first-floor height, flood openings, replacement cost, deductibles, private market options, etc.). Contact a licensed agent for a binding quote.</p>"
    }
  },
  es: {
    language: {
      label: "Idioma",
      options: { en: "Inglés", es: "Español", zh: "Chino" }
    },
    header: {
      title: "Panel de Riesgo de Inundaciones Comunitario",
      tagline: "Comprenda la exposición a inundaciones, encuentre refugios y planifique la cobertura de seguros."
    },
    search: {
      label: "Buscar nombre de parcela",
      placeholder: "Buscar nombre de parcela…",
      button: "Buscar"
    },
    legend: {
      floodLayers: "Capas de zonas de inundación",
      instruction: "Seleccione zonas para mostrarlas en el mapa.",
      zoneGuide: "Guía de zonas",
      parcelTitle: "Valor de la parcela por m²",
      zones: {
        VE: "VE — Inundación costera con oleaje",
        AE: "AE — Alto riesgo (Elevación de Inundación Base)",
        AO: "AO — Inundación fluvial, profundidad de 1 a 3 pies",
        A: "A — Alto riesgo (sin elevación base determinada)",
        X: "X — Riesgo moderado o mínimo"
      },
      shelter: "Refugios",
      parcelLowDefault: "Low",
      parcelHighDefault: "High",
      parcelUnavailable: "N/D",
      parcelValue: "{amount}/m²",
      parcelRange: "{start} – {end}/m²",
      parcelRangeUpper: "{start}+/m²"
    },
    zones: {
      labels: {
        VE: "Zona VE",
        AE: "Zona AE",
        AO: "Zona AO",
        A: "Zona A",
        X: "Zona X",
        parcel: "Valor de la parcela",
        shelter: "Refugios"
      },
      descriptions: {
        VE: "Riesgo de inundación costera muy alto con oleaje de 3 pies o más (zona de velocidad costera).",
        AE: "Alto riesgo de inundación con Elevación de Inundación Base determinada (inundación con probabilidad anual del 1%).",
        AO: "Riesgo de inundación en terreno inclinado con flujo laminar, profundidades promedio de 1 a 3 pies.",
        A: "Áreas de alto riesgo de inundación sin estudios detallados ni Elevación de Inundación Base.",
        X: "Riesgo moderado a mínimo; la inundación es posible pero menos probable que en las zonas SFHA.",
        parcel: "Activar la capa de valor de parcelas.",
        shelter: "Mostrar ubicaciones de refugios."
      }
    },
    info: {
      riskTitle: "Mi riesgo de inundación",
      shelterTitle: "Dónde ir durante una inundación",
      insuranceTitle: "Guía de seguro contra inundaciones",
      riskPlaceholder: "Haga clic en el mapa para explorar los detalles de la zona de inundación de su ubicación.",
      shelterPlaceholder: "Mostraremos el refugio más cercano y la distancia de viaje.",
      insurancePlaceholder: "Obtenga una estimación rápida de las necesidades de seguro según el valor de su propiedad y el riesgo de inundación."
    },
    tutorial: {
      title: "Bienvenido al panel de riesgo de inundaciones",
      body:
        "<p>Haga clic en cualquier lugar del mapa para ver el riesgo de inundación, el refugio más cercano y las sugerencias de seguro contra inundaciones.</p>",
      action: "Entendido",
      languageLabel: "Selecciona un idioma:",
      language: { en: "Inglés", es: "Español", zh: "Chino" }
    },
    footer: {
      sources:
        'Fuentes de datos: <a href="https://www.fema.gov/flood-maps" target="_blank" rel="noopener noreferrer">Mapas de inundación de FEMA</a>, <a href="https://usvi-open-data-portal-upenn.hub.arcgis.com" target="_blank" rel="noopener noreferrer">Portal de Datos Abiertos de USVI</a>.'
    },
    risk: {
      noneHeading: "Sin zona de inundación cartografiada",
      noneDescription: "Este punto está fuera del Área Especial de Peligro de Inundación. Las inundaciones repentinas siguen siendo posibles en tormentas extremas.",
      severity: {
        VE: "Peligro severo de inundación costera",
        AE: "Alto peligro de inundación",
        AO: "Peligro moderado de inundación (escorrentía)",
        A: "Peligro elevado de inundación",
        X: "Peligro bajo de inundación",
        none: "Peligro mínimo de inundación cartografiada"
      },
      depthWithValue: '<p class="info-subtle">Profundidad estimada de inundación: <strong>{value} ft</strong></p>',
      depthUnavailable: '<p class="info-subtle">Profundidad estimada de inundación: <strong>No disponible</strong></p>',
      bfeLabel: '<p class="info-subtle">Elevación base de inundación: <strong>{value} ft</strong></p>',
      tooltip: {
        none: "Ver explicación para áreas fuera de las zonas cartografiadas",
        zone: "Ver explicación de {zone}"
      },
      gaugeLabel: "Posición de riesgo de inundación",
      gaugeValue: {
        none: "Fuera de la SFHA"
      },
      zoneLabelSuffix: "zona",
      gaugeZoneLabel: {
        none: "—"
      }
    },
    insurance: {
      premiumLabel: "Prima anual estimada para cobertura NFIP en esta zona:",
      premiumAmount: "{amount}/año",
      coverageText: 'Cobertura recomendada del edificio: <span class="info-highlight">{amount}</span>. El Programa Nacional de Seguro contra Inundaciones limita la cobertura residencial del edificio a 250 000 USD. Considere un seguro adicional si el costo de reposición es mayor.',
      recommendations: {
        VE: "El seguro contra inundaciones es obligatorio para hipotecas respaldadas por el gobierno federal. Prepárese para marejadas y daños por oleaje elevando la estructura y reforzando la costa.",
        AE: "<strong>El seguro es obligatorio en la mayoría de los casos. Eleve las utilidades por encima de la Elevación de Inundación Base y planifique inundaciones con probabilidad anual del 1%.</strong>",
        AO: "Se recomienda encarecidamente contratar un seguro. Considere nivelar el terreno o instalar barreras para desviar el agua superficial poco profunda lejos de la propiedad.",
        A: "<strong>El seguro es exigido para la mayoría de las hipotecas. Solicite un certificado de elevación para ajustar las primas y las medidas de mitigación.</strong>",
        X: "<strong>Existen pólizas de riesgo preferente. El seguro es opcional, pero sigue siendo recomendable porque el 25% de los reclamos proviene de zonas de menor riesgo.</strong>",
        none: "Considere una protección de bajo costo si está cerca de zonas propensas a inundaciones. Mantenga el drenaje y supervise futuras actualizaciones del mapa."
      },
      selectedParcel: "Parcela seleccionada:",
      calcLink: "¿Cómo se calculan estas cifras?"
    },
    shelter: {
      cardHeading: "El refugio más cercano es:",
      distance: "Distancia: {distance}",
      noDataTitle: "Datos de refugios no disponibles",
      noDataDescription: "Comuníquese con la gestión de emergencias local para obtener instrucciones de evacuación.",
      navigate: "Cómo llegar al refugio"
    },
    format: {
      distance: "{km} km ({miles} mi)"
    },
    meters: {
      labels: {
        parcelValue: "Valor del terreno",
        improvementValue: "Valor de las mejoras",
        valuePerAcre: "Valor por acre"
      },
      unavailable: "N/D",
      perAcre: "{amount} / acre",
      percentile: "Percentil: {percent}%"
    },
    parcels: {
      unknown: "Parcela",
      tooltipTotal: "Total: {value}",
      tooltipPerSquare: "Por m²: {value}"
    },
    placeholders: {
      searchEnter: "Introduzca un nombre de parcela para buscar.",
      searchLoading: "Los datos de parcelas aún se están cargando. Vuelva a intentarlo en breve.",
      searchNotFound: 'No se encontró ninguna parcela que coincida con "{query}".',
      searchUnable: "No se puede centrar en la parcela seleccionada.",
      searchShowing: "Mostrando parcela: {name}"
    },
    buttons: {
      close: "Cerrar"
    },
    calc: {
      title: "Cómo estimamos el seguro contra inundaciones",
      body:
        "<p>La prima anual mostrada es una estimación simplificada para ayudar a comparar el riesgo relativo entre zonas. Multiplicamos el valor total de la parcela (terreno + mejoras) por una tasa específica de la zona y limitamos el resultado a un rango razonable.</p><ul><li>Prima = limitar(totalValue × tasa, mínimo 450 USD, máximo 7 200 USD)</li><li>Cobertura de edificio recomendada = min(totalValue, 250 000 USD)</li></ul><p>Tasas de zona utilizadas: VE 1,8 %, AE 1,5 %, AO 1,2 %, A 1,2 %, X 0,6 % y 0,4 % si no hay zona cartografiada. Son valores heurísticos y no tasas oficiales del NFIP.</p><p>Las primas reales dependen de muchas variables adicionales (certificado de elevación, tipo de cimentación, altura del primer piso, aberturas contra inundación, costo de reposición, deducibles, opciones del mercado privado, etc.). Consulte a un agente autorizado para obtener una cotización vinculante.</p>"
    }
  },
  zh: {
    language: {
      label: "语言",
      options: { en: "英语", es: "西班牙语", zh: "中文" }
    },
    header: {
      title: "社区洪水风险仪表盘",
      tagline: "了解洪水风险，查找避难所，并规划保险保障。"
    },
    search: {
      label: "搜索地块名称",
      placeholder: "搜索地块名称…",
      button: "搜索"
    },
    legend: {
      floodLayers: "洪水分区图层",
      instruction: "选择要在地图上显示的分区。",
      zoneGuide: "分区指南",
      parcelTitle: "地块每平方米价值",
      zones: {
        VE: "VE — 沿海洪水伴随波浪冲击",
        AE: "AE — 高风险",
        AO: "AO — 河流/溪流洪水",
        A: "A — 高风险（无基准洪水水位）",
        X: "X — 中等或最低风险"
      },
      shelter: "避难所",
      parcelLowDefault: "Low",
      parcelHighDefault: "High",
      parcelUnavailable: "暂无数据",
      parcelValue: "{amount}/平方米",
      parcelRange: "{start} – {end}/平方米",
      parcelRangeUpper: "{start}+ /平方米"
    },
    zones: {
      labels: {
        VE: "VE 区",
        AE: "AE 区",
        AO: "AO 区",
        A: "A 区",
        X: "X 区",
        parcel: "地块价值",
        shelter: "避难所"
      },
      descriptions: {
        VE: "非常高的沿海洪水风险，伴随 3 英尺以上的波浪作用（沿海速度区）。",
        AE: "具有基准洪水水位的高洪水风险（1% 年发生概率洪水）。",
        AO: "地势倾斜区域的洪水风险，浅层水流平均深度 1 至 3 英尺。",
        A: "无详细研究或基准洪水水位的高洪水风险区域。",
        X: "中等到较低的洪水风险；发生洪水的可能性低于 SFHA 区域。",
        parcel: "切换地块价值图层。",
        shelter: "切换避难所位置。"
      }
    },
    info: {
      riskTitle: "我的洪水风险",
      shelterTitle: "避难指南",
      insuranceTitle: "洪水保险指南",
      riskPlaceholder: "点击地图查看您所在位置的洪水分区信息。",
      shelterPlaceholder: "我们会列出最近的避难所及距离。",
      insurancePlaceholder: "根据您的房产价值和洪水风险快速估算保险需求。"
    },
    tutorial: {
      title: "欢迎使用洪水风险仪表盘",
      body:
        '<h3 style="color:#1B5E20;">简介</h3><p>该面板是面向维京群岛居民的数据可视化与交互平台。目标是为了帮助居民了解他们所处位置的洪水风险，找到避难所，并接受房屋洪水保险的建议。</p><h3 style="color:#1B5E20;">使用方法</h3><p>点击地图上的任何位置，或者搜索地点，右侧的信息面板会显示所选位置的：</p><ul><li>洪水风险等级</li><li>最近避难所及导航跳转</li><li>财产评估与洪水保险建议</li></ul>',
      action: "进入面板",
      languageLabel: "选择语言：",
      language: { en: "英语", es: "西班牙语", zh: "中文" }
    },
    footer: {
      sources:
        '数据来源：<a href="https://www.fema.gov/flood-maps" target="_blank" rel="noopener noreferrer">FEMA 洪水地图</a>、<a href="https://usvi-open-data-portal-upenn.hub.arcgis.com" target="_blank" rel="noopener noreferrer">美属维尔京群岛开放数据门户</a>。'
    },
    risk: {
      noneHeading: "无已绘制的洪水区",
      noneDescription: "该位置位于特别洪水危险区之外。极端降雨仍可能引发山洪。",
      severity: {
        VE: "严重的沿海洪水风险",
        AE: "高洪水风险",
        AO: "中等洪水风险",
        A: "较高洪水风险",
        X: "较低洪水风险",
        none: "洪水风险极低"
      },
      depthWithValue: '<p class="info-subtle">估算洪水深度：<strong>{value} 英尺</strong></p>',
      depthUnavailable: '<p class="info-subtle">估算洪水深度：<strong>暂无数据</strong></p>',
      bfeLabel: '<p class="info-subtle">基准洪水水位：<strong>{value} 英尺</strong></p>',
      tooltip: {
        none: "查看未绘制洪水区的说明",
        zone: "查看 {zone} 的说明"
      },
      gaugeLabel: "洪水风险位置",
      gaugeValue: {
        none: "位于特别洪水危险区外"
      },
      zoneLabelSuffix: "分区",
      gaugeZoneLabel: {
        none: "—"
      }
    },
    insurance: {
      premiumLabel: "该分区的 NFIP 年度保费估算：",
      premiumAmount: "{amount}/年",
      coverageText: '建议的建筑保险额度：<span class="info-highlight">{amount}</span>。国家洪水保险计划目前将住宅建筑保险额度上限设为 250,000 美元，如需更高的重置成本，请考虑额外洪水保险。',
      recommendations: {
        VE: "对于联邦支持的抵押贷款，必须购买洪水保险。通过抬高建筑并加固海岸来防范风暴潮与波浪损害。",
        AE: "<strong>大多数情况下都需要购买保险。将设备抬高到基准洪水水位之上，并为每年 1% 概率的洪水做好准备。</strong>",
        AO: "强烈建议购买保险。可考虑整平或设置屏障，以引导浅层水流远离房屋。",
        A: "<strong>大多数抵押贷款都要求投保。申请测高证书，以便更准确地估算保费和减灾需求。</strong>",
        X: "<strong>可选择优惠风险保单。虽然保险是可选的，但仍建议购买，因为 25% 的洪水理赔来自低风险区域。</strong>",
        none: "如果靠近易洪区域，可考虑低成本的防护措施。保持排水通畅并关注未来的地图更新。"
      },
      selectedParcel: "已选择的地块：",
      calcLink: "这些数值是如何计算的？"
    },
    shelter: {
      cardHeading: "最近的避难所：",
      distance: "距离：{distance}",
      noDataTitle: "暂无避难所数据",
      noDataDescription: "请联系当地应急管理部门获取撤离指引。",
      navigate: "导航到避难所"
    },
    format: {
      distance: "{km} 公里（{miles} 英里）"
    },
    meters: {
      labels: {
        parcelValue: "地块价值",
        improvementValue: "改良价值",
        valuePerAcre: "每英亩价值"
      },
      unavailable: "暂无数据",
      perAcre: "{amount}/英亩",
      percentile: "百分位：{percent}%"
    },
    parcels: {
      unknown: "地块",
      tooltipTotal: "总价值：{value}",
      tooltipPerSquare: "每平方米：{value}"
    },
    placeholders: {
      searchEnter: "请输入要搜索的地块名称。",
      searchLoading: "地块数据仍在加载中，请稍后再试。",
      searchNotFound: '未找到与“{query}”匹配的地块。',
      searchUnable: "无法定位到所选地块。",
      searchShowing: "正在显示地块：{name}"
    },
    buttons: {
      close: "关闭"
    },
    calc: {
      title: "我们如何估算洪水保险",
      body:
        "<p>显示的年度保费是一个简化估算，用于比较不同分区之间的相对风险。我们将地块的总价值（土地 + 改良）乘以分区专属费率，并将结果限制在合理范围内。</p><ul><li>保费 = 限制(totalValue × 费率，最低 450 美元，最高 7,200 美元)</li><li>建议建筑保险额度 = min(totalValue, 250,000 美元)</li></ul><p>使用的分区费率：VE 1.8%，AE 1.5%，AO 1.2%，A 1.2%，X 0.6%，无分区时为 0.4%。这些仅为经验估算，并非 NFIP 官方费率。</p><p>实际保费受更多因素影响（测高证书、地基类型、首层高度、防洪开口、重置成本、免赔额、私人市场方案等）。请联系持牌代理获取正式报价。</p>"
    }
  }
};

function getLocaleForLang(lang = currentLanguage) {
  if (lang === "es") return "es-ES";
  if (lang === "zh") return "zh-CN";
  return "en-US";
}

function formatNumber(value, options = {}) {
  const locale = getLocaleForLang();
  return new Intl.NumberFormat(locale, options).format(value);
}

function formatCurrency(value, options = {}) {
  const locale = getLocaleForLang();
  const formatterOptions = {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    ...options
  };
  return new Intl.NumberFormat(locale, formatterOptions).format(value);
}

function formatParcelAmount(value) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function translate(key, replacements = {}, lang = currentLanguage) {
  const languages = [lang, "en"];
  for (const lng of languages) {
    const source = translations[lng];
    if (!source) continue;
    const value = key.split(".").reduce((obj, part) => (obj && obj[part] !== undefined ? obj[part] : null), source);
    if (typeof value === "string") {
      let text = value;
      for (const [token, replacement] of Object.entries(replacements)) {
        const pattern = new RegExp(`{${token}}`, "g");
        text = text.replace(pattern, replacement);
      }
      return text;
    }
  }
  return key;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    el.textContent = translate(key);
  });

  document.querySelectorAll("[data-i18n-html]").forEach(el => {
    const key = el.getAttribute("data-i18n-html");
    if (!key) return;
    el.innerHTML = translate(key);
  });

  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    const key = el.getAttribute("data-i18n-title");
    if (!key) return;
    el.title = translate(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) return;
    el.setAttribute("placeholder", translate(key));
  });

  document.querySelectorAll("[data-i18n-aria-label]").forEach(el => {
    const key = el.getAttribute("data-i18n-aria-label");
    if (!key) return;
    el.setAttribute("aria-label", translate(key));
  });

  if (languageSelect) {
    languageSelect.querySelectorAll("option[data-i18n]").forEach(option => {
      const key = option.getAttribute("data-i18n");
      if (!key) return;
      option.textContent = translate(key);
    });
  }
}

function updateZoneLayerTooltips() {
  for (const [zoneId, entry] of floodZoneLayers.entries()) {
    const labelText = translate(`zones.labels.${zoneId}`);
    const tooltipOptions = { direction: "top", offset: [0, -6], sticky: true };
    if (entry.layer && entry.layer.eachLayer) {
      entry.layer.eachLayer(featureLayer => {
        featureLayer.bindTooltip(labelText, tooltipOptions);
      });
    }
    const toggle = document.querySelector(`.layer-toggle[data-zone="${zoneId}"]`);
    if (toggle) {
      toggle.title = translate(`zones.descriptions.${zoneId}`);
    }
  }

  const parcelToggle = document.querySelector(".layer-toggle[data-layer='parcel']");
  if (parcelToggle) {
    parcelToggle.title = translate("zones.descriptions.parcel");
  }
  const shelterToggle = document.querySelector(".layer-toggle[data-layer='shelter']");
  if (shelterToggle) {
    shelterToggle.title = translate("zones.descriptions.shelter");
  }
}

function renderCurrentSelection() {
  if (!currentSelection) {
    showPlaceholder();
    return;
  }
  const { lonLat, parcelFeature, distanceKm } = currentSelection;
  if (!lonLat || !parcelFeature) {
    showPlaceholder();
    return;
  }
  const zoneResult = findFloodZone(lonLat);
  const shelterResult = findNearestShelter(lonLat, parcelFeature);
  const parcelResult = { feature: parcelFeature, distanceKm: distanceKm ?? 0 };
  renderRiskInfo(zoneResult);
  renderShelterInfo(shelterResult, parcelFeature);
  renderInsuranceInfo(zoneResult, parcelResult);
  renderShelterConnection(lonLat, shelterResult?.feature);
}

function setLanguage(lang) {
  if (!translations[lang]) {
    lang = "en";
  }
  currentLanguage = lang;
  document.documentElement.lang = lang;
  document.title = translate("header.title");
  if (languageSelect && languageSelect.value !== lang) {
    languageSelect.value = lang;
  }
  updateTutorialLanguageButtons(lang);
  applyTranslations();
  updateZoneLayerTooltips();
  renderCurrentSelection();
  updateParcelLegend(parcelStats);
  if (parcelSearchFeedback) {
    parcelSearchFeedback.textContent = "";
    parcelSearchFeedback.classList.remove("search-feedback--error");
  }
}

function calcNoteHtml() {
  return (
    '<div class="calc-note">' +
    `<a href="#" id="calc-note-link">${translate("insurance.calcLink")}</a>` +
    "</div>"
  );
}

function insurancePlaceholderHtml() {
  return `<p class="info-placeholder">${translate("info.insurancePlaceholder")}</p>` + calcNoteHtml();
}

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
  infoPanel.risk.innerHTML = `
    <p class="info-placeholder">${translate("info.riskPlaceholder")}</p>
  `;
  infoPanel.shelter.innerHTML = `
    <p class="info-placeholder">${translate("info.shelterPlaceholder")}</p>
  `;
  infoPanel.insurance.innerHTML = insurancePlaceholderHtml();
  clearShelterConnection();
  updateShelterIcons(null);
  attachCalcModalHandlers();
};

const css = getComputedStyle(document.documentElement);

const floodZonesConfig = [
  {
    id: "VE",
    color: css.getPropertyValue("--zone-ve").trim() || "#d95d39",
    file: "data/VE.geojson",
    defaultVisible: true
  },
  {
    id: "AE",
    color: css.getPropertyValue("--zone-ae").trim() || "#f07918",
    file: "data/AE.geojson",
    defaultVisible: true
  },
  {
    id: "AO",
    color: css.getPropertyValue("--zone-ao").trim() || "#f4a261",
    file: "data/AO.geojson",
    defaultVisible: true
  },
  {
    id: "A",
    color: css.getPropertyValue("--zone-a").trim() || "#e9c46a",
    file: "data/A.geojson",
    defaultVisible: true
  },
  {
    id: "X",
    color: css.getPropertyValue("--zone-x").trim() || "#8ab17d",
    file: "data/X.geojson",
    defaultVisible: false
  }
];

const zoneConfigMap = new Map(floodZonesConfig.map(config => [config.id, config]));
const zonePriority = ["VE", "AE", "AO", "A", "X"];

const riskProfiles = {
  VE: { premiumRate: 0.018 },
  AE: { premiumRate: 0.015 },
  AO: { premiumRate: 0.012 },
  A: { premiumRate: 0.012 },
  X: { premiumRate: 0.006 },
  none: { premiumRate: 0.004 }
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
      layer.bindTooltip(translate(`zones.labels.${config.id}`), {
        direction: "top",
        offset: [0, -6],
        sticky: true
      });
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
    legendRefs.parcelMin.textContent = translate("legend.parcelUnavailable");
    legendRefs.parcelMax.textContent = translate("legend.parcelUnavailable");
    legendRefs.parcelGradient.style.background = `linear-gradient(to right, ${parcelColorRamp.join(", ")})`;
    legendRefs.parcelGradient.title = "";
    return;
  }

  const minLabel = translate("legend.parcelValue", { amount: formatParcelAmount(stats.min) });
  const maxLabel = translate("legend.parcelValue", { amount: formatParcelAmount(stats.max) });

  legendRefs.parcelMin.textContent = minLabel;
  legendRefs.parcelMax.textContent = maxLabel;
  legendRefs.parcelGradient.style.background = `linear-gradient(to right, ${parcelColorRamp.join(", ")})`;

  const stops = [stats.min, ...parcelBreaks, stats.max];
  const ranges = [];
  for (let i = 0; i < parcelColorRamp.length; i++) {
    const start = stops[i];
    const end = stops[i + 1];
    if (i === parcelColorRamp.length - 1) {
      const startAmount = formatParcelAmount(start);
      ranges.push(translate("legend.parcelRangeUpper", { start: startAmount }));
    } else {
      const startAmount = formatParcelAmount(start);
      const endAmount = formatParcelAmount(end);
      ranges.push(translate("legend.parcelRange", { start: startAmount, end: endAmount }));
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
  label.dataset.i18nTitle = `zones.descriptions.${config.id}`;
  label.title = translate(label.dataset.i18nTitle);

  const input = document.createElement("input");
  input.type = "checkbox";
  input.dataset.zone = config.id;
  input.checked = !!config.defaultVisible;

  const swatch = document.createElement("span");
  swatch.className = "layer-toggle__swatch";
  swatch.style.background = config.color || "#cccccc";
  swatch.setAttribute("aria-hidden", "true");

  const span = document.createElement("span");
  span.dataset.i18n = `zones.labels.${config.id}`;
  span.textContent = translate(`zones.labels.${config.id}`);

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
    label.dataset.i18nTitle = "zones.descriptions.parcel";
    label.title = translate("zones.descriptions.parcel");
    const input = document.createElement("input");
    input.type = "checkbox";
    const swatch = document.createElement("span");
    swatch.className = "layer-toggle__swatch";
    swatch.style.background = "linear-gradient(to right, #f7fbff, #c6dbef, #6baed6, #3182bd, #08519c)";
    swatch.setAttribute("aria-hidden", "true");
    const span = document.createElement("span");
    span.dataset.i18n = "zones.labels.parcel";
    span.textContent = translate("zones.labels.parcel");
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
    label.dataset.i18nTitle = "zones.descriptions.shelter";
    label.title = translate("zones.descriptions.shelter");
    const input = document.createElement("input");
    input.type = "checkbox";
    const swatch = document.createElement("span");
    swatch.className = "layer-toggle__swatch layer-toggle__swatch--icon";
    swatch.style.backgroundImage = 'url("picture/shelter.png")';
    swatch.setAttribute("aria-hidden", "true");
    const span = document.createElement("span");
    span.dataset.i18n = "zones.labels.shelter";
    span.textContent = translate("zones.labels.shelter");
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
  updateZoneLayerTooltips();
  applyTranslations();
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
          const name = feature.properties?.displayName || translate("parcels.unknown");
          const totalValue = Number(feature.properties?.totalValue);
          const valuePerSqMeter = Number(feature.properties?.valuePerSqMeter);
          const totalLine = Number.isFinite(totalValue)
            ? translate("parcels.tooltipTotal", { value: formatCurrency(totalValue) })
            : translate("parcels.tooltipTotal", { value: translate("meters.unavailable") });
          const perSquareValue = Number.isFinite(valuePerSqMeter)
            ? translate("legend.parcelValue", { amount: formatParcelAmount(valuePerSqMeter) })
            : translate("meters.unavailable");
          const perSquareLine = translate("parcels.tooltipPerSquare", { value: perSquareValue });

          layer.bindTooltip(
            `${name}<br>${totalLine}<br>${perSquareLine}`,
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

const formatDistance = km => {
  const miles = km * 0.621371;
  const kmText = formatNumber(km, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const milesText = formatNumber(miles, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return translate("format.distance", { km: kmText, miles: milesText });
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
          description: translate(`zones.descriptions.${zoneId}`),
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

  if (zoneResult?.feature) {
    const feature = zoneResult.feature;
    const baseFloodElevation = Number(feature.properties?.STATIC_BFE);
    const depth = Number(feature.properties?.DEPTH);
    const hasBfe = Number.isFinite(baseFloodElevation) && baseFloodElevation > -9000;
    const hasDepth = Number.isFinite(depth) && depth !== -9999;

    const depthLabel = !hasBfe
      ? hasDepth
        ? translate("risk.depthWithValue", { value: depth })
        : translate("risk.depthUnavailable")
      : "";

    const bfeLabel = hasBfe
      ? translate("risk.bfeLabel", { value: baseFloodElevation })
      : "";

    elevationDetails = `${depthLabel}${bfeLabel}`;
  }

  let summaryTitle;
  let summaryDescription;
  if (zoneId === "none") {
    summaryTitle = translate("risk.noneHeading");
    summaryDescription = translate("risk.noneDescription");
  } else {
    const severityText = translate(`risk.severity.${zoneId}`);
    summaryTitle = `${zoneId} &mdash; ${severityText}`;
    summaryDescription = translate(`zones.descriptions.${zoneId}`);
  }

  const zoneLabel = translate(`zones.labels.${zoneId}`);
  const tooltipLabel =
    zoneId === "none"
      ? translate("risk.tooltip.none")
      : translate("risk.tooltip.zone", { zone: zoneLabel });
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
          label: translate("risk.gaugeLabel"),
          valueDisplay:
            zoneId === "none"
              ? translate("risk.gaugeValue.none")
              : `${zoneId} ${translate("risk.zoneLabelSuffix")}`,
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
        <strong>${translate("shelter.noDataTitle")}</strong>
        <span>${translate("shelter.noDataDescription")}</span>
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
        ${translate("shelter.navigate")}
      </a>
    `;
  }

  infoPanel.shelter.innerHTML = `
    <div class="metric-card">
      <span>${translate("shelter.cardHeading")}</span>
      <strong>${Name}</strong>
      <span>${translate("shelter.distance", { distance: distanceLabel })}</span>
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
    footnoteHtml = `<p class="meter-card__percent">${translate("meters.percentile", {
      percent: percentLabel
    })}</p>`;
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
  const zoneText = zoneId === "none" ? translate("risk.gaugeZoneLabel.none") : zoneId;
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
  const unavailableLabel = translate("meters.unavailable");

  const cards = [
    {
      label: translate("meters.labels.parcelValue"),
      valueDisplay: Number.isFinite(totalValue) ? formatCurrency(totalValue) : unavailableLabel,
      percent: percentiles.totalValue,
      gradientKey: "risk"
    },
    {
      label: translate("meters.labels.improvementValue"),
      valueDisplay: Number.isFinite(improvementValue) ? formatCurrency(improvementValue) : unavailableLabel,
      percent: percentiles.improvementValue,
      gradientKey: "risk"
    },
    {
      label: translate("meters.labels.valuePerAcre"),
      valueDisplay: Number.isFinite(valuePerAcre)
        ? translate("meters.perAcre", { amount: formatCurrency(valuePerAcre) })
        : unavailableLabel,
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
    infoPanel.insurance.innerHTML = insurancePlaceholderHtml();
    attachCalcModalHandlers();
    return;
  }

  let propertyValue = rawPropertyValue;
  const propertyName = parcelFeature.properties?.displayName;

  let fallbackNotice = "";

  if (propertyName) {
    fallbackNotice = `
      <p class="info-subtle">${translate("insurance.selectedParcel")} <strong>${propertyName}</strong></p>
    `;
  }

  const estimatedPremium = Math.min(Math.max(propertyValue * profile.premiumRate, 450), 7200);
  const recommendedCoverage = Math.min(propertyValue, 250000);
  const propertyMetersHtml = renderPropertyMeters(parcelFeature);
  const premiumLabel = translate("insurance.premiumLabel");
  const coverageText = translate("insurance.coverageText", {
    amount: formatCurrency(recommendedCoverage)
  });
  const recommendationHtml = translate(`insurance.recommendations.${zoneId}`);
  const premiumAmountText = translate("insurance.premiumAmount", {
    amount: formatCurrency(estimatedPremium)
  });

  infoPanel.insurance.innerHTML = `
    <div class="metric-card">
      ${fallbackNotice}
      <span>${premiumLabel}</span>
      <strong>${premiumAmountText}</strong>
    </div>
    ${propertyMetersHtml}
    <p>${coverageText}</p>
    ${recommendationHtml ? `<p>${recommendationHtml}</p>` : ""}
    ${calcNoteHtml()}
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
  currentSelection = {
    lonLat,
    parcelFeature,
    distanceKm: 0
  };
  return true;
}

function handleParcelSearch(event) {
  event.preventDefault();
  if (!parcelSearchInput) return;
  const query = parcelSearchInput.value.trim();
  if (!query) {
    setParcelSearchFeedback(translate("placeholders.searchEnter"), true);
    return;
  }
  if (!dataStore.parcelCollection || !dataStore.parcelCollection.features?.length) {
    setParcelSearchFeedback(translate("placeholders.searchLoading"), true);
    return;
  }
  const match = findParcelByName(query);
  if (!match) {
    setParcelSearchFeedback(translate("placeholders.searchNotFound", { query }), true);
    return;
  }
  const success = selectParcelFeature(match);
  if (!success) {
    setParcelSearchFeedback(translate("placeholders.searchUnable"), true);
    return;
  }
  setParcelSearchFeedback(
    translate("placeholders.searchShowing", { name: match.properties?.displayName || "" }),
    false
  );
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
    currentSelection = null;
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
  currentSelection = {
    lonLat,
    parcelFeature: parcelResult.feature,
    distanceKm: parcelResult.distanceKm
  };
}

if (parcelSearchForm) {
  parcelSearchForm.addEventListener("submit", handleParcelSearch);
}

if (parcelSearchInput) {
  parcelSearchInput.addEventListener("input", () => setParcelSearchFeedback("", false));
}

if (tutorialModal) {
  tutorialCloseButtons.forEach(btn => btn.addEventListener("click", hideTutorialModal));
  tutorialLanguageButtons.forEach(button => {
    button.addEventListener("click", () => {
      const lang = button.dataset.language;
      if (lang) {
        setLanguage(lang);
      }
    });
  });
  tutorialModal.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Esc") {
      hideTutorialModal();
    }
  });
}

if (languageSelect) {
  languageSelect.addEventListener("change", event => setLanguage(event.target.value));
}

const browserLanguage = (navigator.language || "").toLowerCase();
let initialLanguage = "en";
if (browserLanguage.startsWith("es")) {
  initialLanguage = "es";
} else if (browserLanguage.startsWith("zh")) {
  initialLanguage = "zh";
}

setLanguage(initialLanguage);
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
