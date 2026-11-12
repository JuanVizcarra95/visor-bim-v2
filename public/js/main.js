const $ = id => document.getElementById(id);

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const worker = new Worker('/js/worker.js');
const BATCH = 1000;
const YIELD_EVERY = 1500;
const CAPTURE_MAX_WIDTH = 3840;
const segmentationCache = new Map();

let viewer;
let models = [];
let taskId = 0;
let qaData = [];
let parameterCatalog = new Map();
let activeSearchFilter = [];
let searchFilterEnabled = false;
let outsideFilterMode = 'context';
let lastThemeGroups = null;
let lastThemeMode = 'categorical';
let segmentLabelsEnabled = false;
let segmentLabelEntries = [];
let refreshStartedByThisPage = false;
let reloadAfterRefresh = false;
let sortDirection = 'asc';

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const setStatus = text => { if ($('status')) $('status').textContent = text; };
const modelByKey = key => models.find(entry => entry.key === key);

const docLoad = urn => new Promise((ok, bad) => 
  Autodesk.Viewing.Document.load(`urn:${urn}`, ok, (code, message) => bad(Error(message || `APS ${code}`)))
);

const treeOf = model => new Promise((ok, bad) => model.getObjectTree(ok, bad));
const bulk = (model, ids, options = {}) => new Promise((ok, bad) => model.getBulkProperties(ids, options, ok, bad));
const propsOf = (model, id) => new Promise((ok, bad) => model.getProperties(id, ok, bad));

function controls(enabled) {
  ['property', 'searchBtn', 'qaRun', 'reset'].forEach(id => {
    if ($(id)) $(id).disabled = !enabled;
  });
  if ($('propertyFilter')) $('propertyFilter').disabled = !enabled;
}

function downloadAec(document) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const result = document.downloadAecModelData?.(finish);
      if (result?.then) result.then(finish).catch(finish);
      else if (!document.downloadAecModelData) finish();
      setTimeout(finish, 10000);
    } catch {
      finish();
    }
  });
}

function sharedInfo(node) {
  const matrix = node.getAecModelData?.()?.refPointTransformation;
  if (!matrix || matrix.length < 12 || ![...matrix].every(Number.isFinite)) return null;
  const determinant = matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) 
                    - matrix[3] * (matrix[1] * matrix[8] - matrix[2] * matrix[7]) 
                    + matrix[6] * (matrix[1] * matrix[5] - matrix[2] * matrix[4]);
  return Math.abs(determinant) < 1e-10 ? null : { ref: new THREE.Vector3(matrix[9], matrix[10], matrix[11]) };
}

async function init() {
  try {
    if ($('loading')) $('loading').classList.remove('hidden');
    
    const response = await fetch('/api/token');
    const token = await response.json();
    if (!response.ok || !token.access_token) throw Error(token.error || 'No se obtuvo token APS');
    
    await new Promise(resolve => Autodesk.Viewing.Initializer({
      env: 'AutodeskProduction',
      api: 'streamingV2',
      getAccessToken: callback => callback(token.access_token, token.expires_in)
    }, resolve));
    
    viewer = new Autodesk.Viewing.GuiViewer3D($('viewer'), { extensions: [] });
    if (viewer.start()) throw Error('No se pudo iniciar WebGL');
    
    viewer.setQualityLevel(false, true); 
    viewer.prefs.set('edgeRendering', true); 
    viewer.prefs.set('envMapBackground', true); 
    viewer.setTheme('light-theme');
    viewer.setProgressiveRendering?.(true);
    if (viewer.impl && viewer.impl.setAOEnabled) viewer.impl.setAOEnabled(true);
    viewer.setGroundShadow?.(false);
    viewer.setGroundReflection?.(false);
    
    viewer.addEventListener(Autodesk.Viewing.AGGREGATE_SELECTION_CHANGED_EVENT, onSelection);
    viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, updateSegmentLabelPositions);
    window.addEventListener('resize', updateSegmentLabelPositions);
    
    await loadFederation();
  } catch (error) {
    console.error(error);
    setStatus(`Error: ${error.message}`);
    if ($('loading')) $('loading').textContent = error.message;
  }
}

async function loadFederation() {
  const response = await fetch('/api/models');
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'No hay modelos');
  
  for (const entry of models) {
    try { viewer.unloadModel(entry.model); } catch {}
  }
  
  models = [];
  segmentationCache.clear();
  clearSegmentLabels();
  
  const list = [...(data.models || [])].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  if (!list.length) throw Error('No hay modelos publicados');

  const prepared = [];
  for (const info of list) {
    const document = await docLoad(info.urn);
    const node = document.getRoot().getDefaultGeometry();
    if (!node) continue;
    await downloadAec(document);
    prepared.push({ info, document, node, shared: sharedInfo(node) });
  }
  
  const valid = prepared.filter(item => item.shared);
  if (!valid.length) throw Error('Ningún modelo contiene una referencia de coordenadas compartidas válida');

  const reference = valid[0];
  const globalOffset = reference.shared.ref.clone();
  let withoutCoordinates = 0;
  
  for (let index = 0; index < prepared.length; index++) {
    const item = prepared[index];
    const options = { keepCurrentModels: index > 0, preserveView: index > 0, applyRefPoint: !!item.shared, globalOffset };
    const model = await viewer.loadDocumentNode(item.document, item.node, options);
    const coordinateDelta = item.shared ? item.shared.ref.distanceTo(globalOffset) : null;
    
    models.push({
      key: String(model.id), model, name: item.info.name, visible: true, leaves: null,
      hasSharedCoordinates: !!item.shared, referencePoint: item.shared ? item.shared.ref.clone() : null, coordinateDelta, referenceModel: item === reference
    });
    if (!item.shared) withoutCoordinates++;
    await frame();
  }
  
  viewer.fitToView();
  await indexParameters();
  renderFiles();
  controls(true);
  
  if ($('loading')) $('loading').classList.add('hidden');
  const coordinateMessage = withoutCoordinates ? ` · ${withoutCoordinates} sin coordenadas compartidas válidas` : '';
  setStatus(`${models.length} modelo(s) federado(s) por coordenadas compartidas${coordinateMessage}`);
}

async function leavesOf(entry) {
  if (entry.leaves) return entry.leaves;
  const tree = await treeOf(entry.model);
  const ids = [];
  tree.enumNodeChildren(tree.getRootId(), id => { if (!tree.getChildCount(id)) ids.push(id); }, true);
  return entry.leaves = ids;
}

// Generación de filtros nativos usando optgroup
function refreshSelect(selectId, filterId, firstValue, label) {
  const select = $(selectId);
  const previous = select.value;
  const filterVal = $(filterId)?.value.trim().toLocaleLowerCase('es') || '';
  let html = `<option value="${firstValue}">${label}</option>`;
  
  const sortedCatalog = [...parameterCatalog].sort(([a], [b]) => a.localeCompare(b, 'es'));
  
  for (const [category, names] of sortedCatalog) {
    const filtered = [...names]
      .filter(name => !filterVal || name.toLocaleLowerCase('es').includes(filterVal) || category.toLocaleLowerCase('es').includes(filterVal))
      .sort((a, b) => a.localeCompare(b, 'es'));
      
    if (filtered.length) {
      html += `<optgroup label="${esc(category)}">`;
      html += filtered.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      html += `</optgroup>`;
    }
  }
  select.innerHTML = html;
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

function setupParameterFilters() {
  const filters = [
    ['searchProperty', 'searchPropertyFilter', '*', 'Todas las propiedades'],
    ['property', 'propertyFilter', '', 'Segmentar por parámetro…'],
    ['qaProperty', 'qaPropertyFilter', '', 'Seleccionar parámetro…']
  ];
  filters.forEach(([select, filter, value, label]) => {
    if ($(filter)) $(filter).oninput = () => refreshSelect(select, filter, value, label);
  });
}

async function indexParameters() {
  parameterCatalog = new Map();
  for (const entry of models) {
    const leaves = await leavesOf(entry);
    const step = Math.max(1, Math.ceil(leaves.length / 600));
    const sample = leaves.filter((_, index) => index % step === 0).slice(0, 600);
    
    for (let start = 0; start < sample.length; start += BATCH) {
      const rows = await bulk(entry.model, sample.slice(start, start + BATCH));
      rows.forEach(row => {
        (row.properties || []).forEach(property => {
          if (!property.displayName || property.hidden || property.displayName.startsWith('__')) return;
          const category = property.displayCategory || 'General';
          if (!parameterCatalog.has(category)) parameterCatalog.set(category, new Set());
          parameterCatalog.get(category).add(property.displayName);
        });
      });
    }
    await frame();
  }
  refreshSelect('searchProperty', 'searchPropertyFilter', '*', 'Todas las propiedades');
  refreshSelect('property', 'propertyFilter', '', 'Segmentar por parámetro…');
  refreshSelect('qaProperty', 'qaPropertyFilter', '', 'Seleccionar parámetro…');
}

function parseBooleanData(v) {
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  const norm = String(v).toLowerCase().trim();
  if (norm === 'true' || norm === 'yes') return 'Sí';
  if (norm === 'false' || norm === 'no') return 'No';
  return v;
}

// Arquitectura STREAMING: Resuelve el colapso en móviles enviando lotes al worker.
async function runWorkerStream(action, payload, button = null, busy = 'Procesando…') {
  const run = ++taskId;
  const old = button?.textContent || '';
  if (button) { button.disabled = true; button.textContent = busy; }
  controls(false);
  
  try {
    worker.postMessage({ action: 'initStream', streamAction: action, payload });
    const scope = action === 'segmentation' && searchFilterEnabled ? activeSearchFilter : null;
    let totalItems = 0;

    for (const entry of models) {
      const ids = scope ? scope.filter(item => item.modelKey === entry.key).map(item => item.dbId) : await leavesOf(entry);
      const prop = payload.propName || payload.prop || '*';
        
      for (let start = 0; start < ids.length; start += BATCH) {
        if (run !== taskId) throw Error('cancel');
        const rows = await bulk(entry.model, ids.slice(start, start + BATCH), prop && prop !== '*' ? { propFilter: [prop] } : {});
        
        const chunk = rows.map(row => {
          let val = null;
          let text = "";
          if (prop === '*') {
              text = (row.name || "") + " " + (row.properties || []).map(p => parseBooleanData(p.displayValue)).join(" ");
          } else {
              const p = (row.properties || []).find(x => x.displayName === prop);
              val = p ? parseBooleanData(p.displayValue) : null;
          }
          return { modelKey: entry.key, modelName: entry.name, dbId: row.dbId, name: row.name || `Elemento ${row.dbId}`, v: val, t: text };
        });

        worker.postMessage({ action: 'chunkStream', items: chunk });
        totalItems += chunk.length;
        setStatus(`Analizando ${totalItems.toLocaleString('es-PE')} elementos…`);
        await frame();
      }
    }
    worker.postMessage({ action: 'endStream' });
  } catch (error) {
    controls(true);
    if (button) button.textContent = old;
    if (error.message !== 'cancel') setStatus(`Error: ${error.message}`);
  }
}

function clearVisuals() {
  viewer.clearSelection();
  viewer.setGhosting?.(true);
  try { viewer.impl.visibilityManager?.aggregateIsolate?.([]); } catch {}
  viewer.showAll();
  models.forEach(entry => {
    viewer.clearThemingColors(entry.model);
    try { viewer.showModel(entry.model); } catch {}
  });
  viewer.impl.invalidate(true, true, true);
}

function groupByModel(items) {
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.modelKey)) grouped.set(item.modelKey, []);
    grouped.get(item.modelKey).push(item.dbId);
  }
  return grouped;
}

function applyFilterVisibility(items) {
  clearIsolationOnly();
  const grouped = groupByModel(items);
  const aggregate = [];
  for (const entry of models) {
    const ids = grouped.get(entry.key) || [];
    if (ids.length) aggregate.push({ model: entry.model, ids });
  }
  viewer.setGhosting?.(outsideFilterMode === 'context');
  viewer.impl.visibilityManager?.aggregateIsolate?.(aggregate);
  viewer.impl.invalidate(true, true, true);
}

function clearIsolationOnly() {
  try { viewer.impl.visibilityManager?.aggregateIsolate?.([]); } catch {}
  viewer.showAll();
  models.forEach(entry => {
    try { viewer.showModel(entry.model); } catch {}
  });
}

function ensureFilterToggle() {
  let control = $('filterViewControl');
  if (!control) {
    control = document.createElement('div');
    control.id = 'filterViewControl';
    control.className = 'filter-view-control';
    control.innerHTML = `
      <span class="hint">Visualización del filtro</span>
      <label class="filter-switch"><input id="filterViewToggle" type="checkbox"><span class="filter-slider"></span></label>
      <span id="filterViewLabel"></span>
    `;
    $('searchSummary')?.insertAdjacentElement('afterend', control);
    $('filterViewToggle').onchange = event => {
      outsideFilterMode = event.currentTarget.checked ? 'hide' : 'context';
      updateFilterToggle();
      if (searchFilterEnabled && $('isolate').checked) applyFilterVisibility(activeSearchFilter);
    };
  }
  updateFilterToggle();
}

function updateFilterToggle() {
  const control = $('filterViewControl');
  const toggle = $('filterViewToggle');
  const label = $('filterViewLabel');
  if (!control) return;
  control.hidden = !searchFilterEnabled;
  toggle.checked = outsideFilterMode === 'hide';
  label.textContent = outsideFilterMode === 'context' ? 'No filtrados: transparencia + hidden line' : 'No filtrados: ocultos';
}

function interpolateColor(value, min, max) {
  const t = max === min ? 0.5 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  let a, b, u;
  if (t <= 0.5) { a = [255, 0, 0]; b = [255, 255, 0]; u = t * 2; } 
  else { a = [255, 255, 0]; b = [0, 80, 255]; u = (t - 0.5) * 2; }
  return a.map((x, index) => Math.round(x + (b[index] - x) * u));
}

function clearSegmentLabels() {
  segmentLabelEntries = [];
  const layer = $('segmentLabels');
  if (layer) layer.textContent = '';
}

function groupWorldCenter(elements) {
  const total = new THREE.Box3();
  const box = new THREE.Box3();
  let valid = false;
  
  for (const element of elements) {
    const entry = modelByKey(element.modelKey);
    if (!entry) continue;
    
    const tree = entry.model.getInstanceTree();
    const fragments = entry.model.getFragmentList();
    if (!tree || !fragments) continue;
    
    tree.enumNodeFragments(element.dbId, fragId => {
      box.makeEmpty();
      fragments.getWorldBounds(fragId, box);
      if (!box.isEmpty()) { total.union(box); valid = true; }
    }, true);
  }
  return valid ? total.getCenter(new THREE.Vector3()) : null;
}

function updateSegmentLabelPositions() {
  if (!segmentLabelsEnabled || !viewer) return;
  const layer = $('segmentLabels');
  if (!layer) return;
  
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  
  for (const item of segmentLabelEntries) {
    const point = viewer.worldToClient(item.world);
    const visible = point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 5 && point.y >= 5 && point.x <= width - 5 && point.y <= height - 5;
    
    item.element.hidden = !visible;
    if (visible) { item.element.style.left = `${point.x}px`; item.element.style.top = `${point.y}px`; }
  }
}

async function renderSegmentLabels(groups) {
  clearSegmentLabels();
  const layer = $('segmentLabels');
  if (!segmentLabelsEnabled || !layer || !groups?.length) return;
  
  const candidates = [...groups].sort((a, b) => b[1].elements.length - a[1].elements.length);
  
  for (let index = 0; index < candidates.length; index++) {
    const [value, group] = candidates[index];
    const world = groupWorldCenter(group.elements);
    if (!world) continue;
    
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'segment-label';
    label.style.setProperty('--label-color', group.hex || '#248bd6');
    label.textContent = value;
    label.title = `${value} · ${group.elements.length} elemento(s). Clic para seleccionar y acercar.`;
    label.onclick = event => { event.stopPropagation(); selectLegendGroup(value, group.elements); };
    
    layer.appendChild(label);
    segmentLabelEntries.push({ element: label, world, value, color: group.hex || '#248bd6' });
    if (index % 12 === 0) await frame();
  }
  updateSegmentLabelPositions();
}

async function theme(groups, mode) {
  clearSegmentLabels();
  clearVisuals();
  lastThemeGroups = groups;
  lastThemeMode = mode;
  $('legend').textContent = '';
  
  const palette = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#ffe119', '#800000', '#a9a9a9'];
  const numbers = groups.filter(([value, g]) => value !== 'Sin asignar' && Number.isFinite(g.n)).map(([, g]) => g.n);
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const all = [];
  let painted = 0;
  
  for (let index = 0; index < groups.length; index++) {
    const [value, group] = groups[index];
    let rgb, hex;
    
    if (value === 'Sin asignar') { rgb = [119, 119, 119]; hex = '#777777'; } 
    else if (mode === 'continuous' && Number.isFinite(group.n)) {
      rgb = interpolateColor(group.n, min, max);
      hex = '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('');
    } else {
      hex = palette[index % Number($('palette').value)];
      rgb = [1, 3, 5].map(position => parseInt(hex.slice(position, position + 2), 16));
    }
    
    group.hex = hex;
    const vector = new THREE.Vector4(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, value === 'Sin asignar' ? 1 : 0.9);
    
    for (const element of group.elements) {
      const entry = modelByKey(element.modelKey);
      if (entry) entry.model.setThemingColor(element.dbId, vector);
      all.push(element);
      if (++painted % YIELD_EVERY === 0) await frame();
    }
    
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.title = `Seleccionar ${group.elements.length} elementos de ${value}`;
    row.tabIndex = 0;
    row.innerHTML = `<i class="swatch" style="background:${hex}"></i><span>${esc(value)}</span><span class="badge">${group.elements.length}</span>`;
    
    const selectGroup = () => selectLegendGroup(value, group.elements);
    row.onclick = selectGroup;
    row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectGroup(); } };
    $('legend').appendChild(row);
  }
  
  if ($('isolate').checked) {
    if (searchFilterEnabled) applyFilterVisibility(activeSearchFilter);
    else applyFilterVisibility(all);
  }
  if (segmentLabelsEnabled) await renderSegmentLabels(groups);
  viewer.impl.invalidate(true, true, true);
}

function selectLegendGroup(value, elements) {
  const grouped = groupByModel(elements);
  const aggregate = [];
  
  for (const entry of models) {
    const ids = grouped.get(entry.key) || [];
    if (ids.length) aggregate.push({ model: entry.model, ids });
  }
  
  viewer.clearSelection();
  if (viewer.impl.selector?.setAggregateSelection) {
    viewer.impl.selector.setAggregateSelection(aggregate);
  } else {
    for (const item of aggregate) viewer.select(item.ids, item.model);
  }
  
  if (aggregate.length === 1) viewer.fitToView(aggregate[0].ids, aggregate[0].model);
  else viewer.fitToView();
  
  setStatus(`${value}: ${elements.length.toLocaleString('es-PE')} elemento(s) seleccionados`);
}

function selectItem(item) {
  const entry = modelByKey(item.modelKey);
  if (!entry) return;
  viewer.clearSelection();
  viewer.select([item.dbId], entry.model);
  viewer.fitToView([item.dbId], entry.model);
}

function setupVirtualScroll(containerId, data, renderFn, rowHeight = 35) {
  const container = $(containerId);
  const content = container.querySelector('.vs-content');
  container.onscroll = null;
  content.innerHTML = '';
  
  if (!data || !data.length) { content.style.height = '0px'; return; }
  content.style.height = `${data.length * rowHeight}px`;
  
  const renderChunk = () => {
    const start = Math.max(0, Math.floor(container.scrollTop / rowHeight) - 5);
    const end = Math.min(data.length, Math.ceil((container.scrollTop + container.clientHeight) / rowHeight) + 5);
    content.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const el = renderFn(data[i]);
      el.style.position = 'absolute';
      el.style.top = `${i * rowHeight}px`;
      el.style.width = '100%';
      fragment.appendChild(el);
    }
    content.appendChild(fragment);
  };
  container.onscroll = () => requestAnimationFrame(renderChunk);
  renderChunk();
}

function renderQuality(data) {
  qaData = data.rows || [];
  if ($('qaKpis')) {
    $('qaKpis').innerHTML = `
      <div class="kpi"><b>${data.kpis.total}</b>Elementos</div>
      <div class="kpi"><b>${data.kpis.completitud}%</b>Completitud</div>
      <div class="kpi"><b>${data.kpis.unicos}</b>Únicos</div>
      <div class="kpi"><b>${data.kpis.vacios}</b>Vacíos</div>
    `;
  }
  if ($('qaSummary')) $('qaSummary').textContent = `${qaData.length.toLocaleString('es-PE')} resultados`;
  
  setupVirtualScroll('qaResults', qaData, (item) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.textContent = item.isGroup ? `${item.value} · ${item.count}` : `${item.name || 'Elemento'} · ${item.value || 'Vacío'}${item.count ? ` · ${item.count} repeticiones` : ''}`;
    if (!item.isGroup) row.onclick = () => selectItem(item);
    return row;
  });
  
  if ($('qaExport')) $('qaExport').disabled = !qaData.length;
  setStatus('Auditoría completada');
  controls(true);
  if ($('qaRun')) $('qaRun').textContent = 'Analizar auditoría';
}

worker.onmessage = async ({ data }) => {
  if (data.action === 'searchDone') {
    activeSearchFilter = data.matches;
    searchFilterEnabled = true;
    segmentationCache.clear();
    $('searchSummary').textContent = `Filtro activo: ${data.matches.length.toLocaleString('es-PE')} elementos. La segmentación se aplicará solo a estos resultados.`;
    ensureFilterToggle();
    if ($('isolate').checked) applyFilterVisibility(activeSearchFilter);
    $('searchBtn').textContent = 'Buscar';
    setStatus('Filtro primario aplicado');
    controls(true);
  } else if (data.action === 'segmentDone') {
    if (data.cacheKey) segmentationCache.set(data.cacheKey, data);
    const valid = data.groups.filter(([value]) => value !== 'Sin asignar');
    const numericRatio = valid.length ? valid.filter(([, g]) => Number.isFinite(g.n)).length / valid.length : 0;
    
    let mode = $('colorMode')?.value || 'auto';
    if (mode === 'auto') mode = numericRatio >= 0.8 ? 'continuous' : 'categorical';
    if (mode === 'continuous' && numericRatio < 0.8) mode = 'categorical';
    
    valid.sort(mode === 'continuous' ? (a, b) => a[1].n - b[1].n : (a, b) => a[0].localeCompare(b[0], 'es', { numeric: true }));
    const empty = data.groups.find(([value]) => value === 'Sin asignar');
    if (empty) valid.push(empty);
    
    await theme(valid, mode);
    setStatus(`Segmentación completada sobre ${data.total.toLocaleString('es-PE')} elementos`);
    controls(true);
  } else if (data.action === 'qaDone') {
    renderQuality(data);
  }
};

$('searchBtn').onclick = () => {
  const query = $('query').value.trim();
  const op = $('operator').value;
  if (!query && !['empty', 'notEmpty'].includes(op)) return;
  activeSearchFilter = [];
  searchFilterEnabled = false;
  segmentationCache.clear();
  if($('results')) $('results').classList.remove('hidden');
  runWorkerStream('search', { prop: $('searchProperty').value || '*', q: query, op }, $('searchBtn'), 'Buscando…');
};

$('query').onkeydown = event => { if (event.key === 'Enter') $('searchBtn').click(); };

$('operator').onchange = (e) => {
    const isLogicOp = ['empty', 'notEmpty'].includes(e.target.value);
    $('query').disabled = isLogicOp;
    if (isLogicOp) $('query').value = '';
};

$('property').onchange = () => {
  const propName = $('property').value;
  if (!propName || propName === '*') return resetSegmentation();
  if (searchFilterEnabled && !activeSearchFilter.length) return setStatus('El filtro activo no tiene resultados');
  
  const signature = searchFilterEnabled ? activeSearchFilter.map(x => `${x.modelKey}:${x.dbId}`).join('|') : 'all';
  const cacheKey = `${propName}::${signature}`;
  const cached = segmentationCache.get(cacheKey);
  
  if (cached) return worker.onmessage({ data: cached });
  runWorkerStream('segmentation', { propName, cacheKey });
};

if ($('colorMode')) $('colorMode').onchange = () => { $('property').value && $('property').onchange(); };
if ($('palette')) $('palette').onchange = () => { $('property').value && $('property').onchange(); };

if ($('qaRun')) $('qaRun').onclick = () => {
  const propName = $('qaProperty').value;
  if (propName && propName !== '*') runWorkerStream('qualityAudit', { propName, rule: $('qaRule').value }, $('qaRun'), 'Analizando…');
};

if ($('qaExport')) $('qaExport').onclick = () => {
  if (!qaData.length) return;
  const keys = [...new Set(qaData.flatMap(Object.keys))];
  const csv = '\ufeff' + keys.join(',') + '\n' + qaData.map(row => keys.map(key => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'auditoria-calidad.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

async function onSelection(event) {
  const selection = event.selections?.find(x => x.dbIdArray?.length);
  if (!selection) return;
  const entry = models.find(x => x.model === selection.model);
  if (!entry) return;
  
  try {
    const data = await propsOf(entry.model, selection.dbIdArray[0]);
    const groups = new Map();
    
    (data.properties || []).forEach(property => {
      const category = property.displayCategory || 'General';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(property);
    });
    
    $('properties').innerHTML = `<div class="hint">${esc(entry.name)} · ${esc(data.name)}</div>` + 
      [...groups].map(([category, properties]) => 
        `<section class="group">
          <div class="ghead">${esc(category)}</div>
          ${properties.map(property => 
            `<div class="prow">
              <span class="pname">${esc(property.displayName)}</span>
              <span class="pval">${esc(parseBooleanData(property.displayValue))}${property.units ? ' ' + esc(property.units) : ''}</span>
            </div>`
          ).join('')}
        </section>`
      ).join('');
  } catch (error) {
    setStatus(`Error de propiedades: ${error.message}`);
  }
}

function resetSegmentation() {
  taskId++;
  clearSegmentLabels();
  clearVisuals();
  if ($('property')) $('property').value = '';
  if ($('propertyFilter')) $('propertyFilter').value = '';
  if ($('colorMode')) $('colorMode').value = 'auto';
  if ($('palette')) $('palette').value = '15';
  if ($('legend')) $('legend').textContent = '';
  lastThemeGroups = null;
  lastThemeMode = 'categorical';
}

function resetQuality() {
  qaData = [];
  if ($('qaProperty')) $('qaProperty').value = '';
  if ($('qaPropertyFilter')) $('qaPropertyFilter').value = '';
  if ($('qaRule')) $('qaRule').value = 'summary';
  if ($('qaSummary')) $('qaSummary').textContent = '';
  if ($('qaKpis')) $('qaKpis').textContent = '';
  const container = $('qaResults');
  if (container) { const content = container.querySelector('.vs-content'); if(content) content.innerHTML = ''; }
  if ($('qaExport')) $('qaExport').disabled = true;
}

function resetAll() {
  taskId++;
  activeSearchFilter = [];
  searchFilterEnabled = false;
  outsideFilterMode = 'context';
  segmentationCache.clear();
  
  if ($('query')) { $('query').value = ''; $('query').disabled = false; }
  if ($('searchProperty')) $('searchProperty').value = '*';
  if ($('searchPropertyFilter')) $('searchPropertyFilter').value = '';
  if ($('operator')) $('operator').value = 'contains';
  if ($('searchSummary')) $('searchSummary').textContent = '';
  if ($('results')) $('results').classList.add('hidden');
  
  updateFilterToggle();
  resetSegmentation();
  resetQuality();
  
  if ($('properties')) $('properties').innerHTML = '<div class="hint">Selecciona un elemento.</div>';
  if ($('isolate')) $('isolate').checked = true;
  
  segmentLabelsEnabled = false;
  if ($('showSegmentLabels')) $('showSegmentLabels').checked = false;
  
  clearSegmentLabels();
  viewer.clearSelection();
  viewer.setGhosting?.(true);
  viewer.showAll();
  viewer.fitToView();
  controls(true);
  setStatus('Vista y consultas restauradas completamente');
}

$('reset').onclick = resetAll;

if ($('isolate')) {
  $('isolate').onchange = () => {
    if ($('isolate').checked && searchFilterEnabled) applyFilterVisibility(activeSearchFilter);
    else { clearIsolationOnly(); viewer.setGhosting?.(true); viewer.impl.invalidate(true, true, true); }
  };
}

function loadCaptureImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

function triggerDownload(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function captureHighResolution() {
  const button = $('captureBtn');
  if (!viewer || !button) return;
  const original = button.textContent;
  button.textContent = 'Generando…';
  button.disabled = true;
  
  try {
    const host = viewer.container;
    const ratio = host.clientHeight / host.clientWidth;
    const width = CAPTURE_MAX_WIDTH;
    const height = Math.max(2160, Math.round(width * ratio));
    
    const result = await new Promise((resolve, reject) => { try { viewer.getScreenShot(width, height, resolve); } catch (error) { reject(error); } });
    const source = result instanceof Blob ? URL.createObjectURL(result) : result;
    const image = await loadCaptureImage(source);
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    
    if (segmentLabelsEnabled) {
      const scaleX = width / host.clientWidth;
      const scaleY = height / host.clientHeight;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.font = `600 ${Math.max(18, Math.round(9 * scaleX))}px Segoe UI,Arial`;
      
      for (const item of segmentLabelEntries) {
        if (item.element.hidden) continue;
        const point = viewer.worldToClient(item.world);
        if (!point) continue;
        
        const x = point.x * scaleX;
        const y = point.y * scaleY;
        const text = item.value;
        const pad = 6 * scaleX;
        const textWidth = context.measureText(text).width;
        const boxHeight = 20 * scaleY;
        
        context.fillStyle = 'rgba(18,21,25,.86)';
        context.fillRect(x - textWidth / 2 - pad, y - boxHeight / 2, textWidth + pad * 2, boxHeight);
        context.fillStyle = item.color;
        context.fillRect(x - textWidth / 2 - pad, y - boxHeight / 2, 3 * scaleX, boxHeight);
        context.fillStyle = '#fff';
        context.fillText(text, x, y);
      }
    }
    
    triggerDownload(canvas.toDataURL('image/png', 1), `visor-bim-${new Date().toISOString().replace(/[:.]/g, '-')}-4K.png`);
    if (result instanceof Blob) URL.revokeObjectURL(source);
    setStatus(`Captura guardada: ${width} × ${height} px`);
  } catch (error) {
    console.error(error);
    setStatus(`Error al capturar: ${error.message}`);
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

function setRefreshProgress(update) {
  const wrap = $("progressWrap");
  const bar = $("progressBar");
  const button = $("refreshBtn");
  
  if (wrap) wrap.classList.toggle("hidden", update.state === "idle" || update.state === "success" || update.state === "error");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(update.progress) || 0))}%`;
  if (update.message) setStatus(update.message);
  
  if (button) {
    const busy = ["preparing", "uploading", "translating"].includes(update.state);
    button.disabled = busy;
    button.textContent = busy ? "Actualizando…" : "Actualizar modelo";
  }
  
  if (update.state === "success" && reloadAfterRefresh) {
    reloadAfterRefresh = false;
    refreshStartedByThisPage = false;
    setTimeout(() => loadFederation().catch(error => setStatus(`Actualización terminada, pero no se pudo recargar: ${error.message}`)), 800);
  }
  if (update.state === "error") { reloadAfterRefresh = false; refreshStartedByThisPage = false; }
}

async function startModelRefresh() {
  const button = $("refreshBtn");
  if (!button) return;
  const key = window.prompt("Clave de actualización de modelos:");
  if (key === null) return;
  button.disabled = true;
  button.textContent = "Iniciando…";
  
  try {
    const response = await fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json", "X-Refresh-Key": key } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    refreshStartedByThisPage = true;
    reloadAfterRefresh = true;
    setStatus("Actualización incremental iniciada.");
  } catch (error) {
    setStatus(`No se pudo iniciar la actualización: ${error.message}`);
    button.disabled = false;
    button.textContent = "Actualizar modelo";
  }
}

function connectRefreshEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = event => { try { setRefreshProgress(JSON.parse(event.data)); } catch (error) {} };
  source.onerror = () => { if (refreshStartedByThisPage) setStatus("Reconectando con el progreso de actualización…"); };
  window.addEventListener("beforeunload", () => source.close(), { once: true });
}

function renderFiles() {
  if (!$('filesList')) return;
  $('filesList').textContent = '';
  
  const sortedModels = [...models].sort((a, b) => {
    return sortDirection === 'asc' ? a.name.localeCompare(b.name, 'es', { numeric: true }) : b.name.localeCompare(a.name, 'es', { numeric: true });
  });

  sortedModels.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const marker = entry.hasSharedCoordinates ? (entry.referenceModel ? '◎' : '●') : '⚠';
    const title = entry.referenceModel ? 'Referencia automática de globalOffset' : entry.hasSharedCoordinates ? 'Coordenadas compartidas válidas' : 'Sin referencia compartida válida';
    
    row.innerHTML = `
      <span title="${title}">${marker}</span>
      <label class="file-label"><input type="checkbox" class="model-toggle" ${entry.visible ? 'checked' : ''}><span class="file-name" title="${esc(entry.name)}">${esc(entry.name)}</span></label>
      <span class="file-actions"><button class="focus-btn">Enfocar</button></span>
    `;
    const checkbox = row.querySelector('.model-toggle');
    const focusBtn = row.querySelector('.focus-btn');
    checkbox.onchange = (e) => { entry.visible = e.target.checked; if (entry.visible) viewer.showModel(entry.model); else viewer.hideModel(entry.model); };
    focusBtn.onclick = () => viewer.fitToView(undefined, entry.model);
    $('filesList').appendChild(row);
  });
}

if ($('filesBtn')) $('filesBtn').onclick = () => { if ($('filesPanel')) $('filesPanel').classList.remove('hidden'); else $('filesDialog')?.showModal(); };
if ($('closeFiles')) $('closeFiles').onclick = () => { if ($('filesPanel')) $('filesPanel').classList.add('hidden'); else $('filesDialog')?.close(); };
if ($('sortFilesBtn')) $('sortFilesBtn').onclick = () => { sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'; $('sortFilesBtn').textContent = sortDirection === 'asc' ? 'Ordenar A-Z' : 'Ordenar Z-A'; renderFiles(); };
if ($('showAllModelsBtn')) $('showAllModelsBtn').onclick = () => { models.forEach(entry => { entry.visible = true; viewer.showModel(entry.model); }); renderFiles(); };
if ($('hideAllModelsBtn')) $('hideAllModelsBtn').onclick = () => { models.forEach(entry => { entry.visible = false; viewer.hideModel(entry.model); }); renderFiles(); };

function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const panes = [...document.querySelectorAll('.pane')];
  for (const tab of tabs) {
    tab.type = 'button';
    tab.onclick = () => {
      tabs.forEach(item => item.classList.toggle('active', item === tab));
      panes.forEach(pane => pane.classList.toggle('active', pane.id === tab.dataset.pane));
      if (tab.dataset.pane === 'props' && $('properties') && !$('properties').textContent.trim()) $('properties').innerHTML = '<div class="hint">Selecciona un elemento.</div>';
    };
  }
}

if ($('showSegmentLabels')) $('showSegmentLabels').onchange = async event => {
  segmentLabelsEnabled = event.currentTarget.checked;
  if (segmentLabelsEnabled && lastThemeGroups) await renderSegmentLabels(lastThemeGroups);
  else clearSegmentLabels();
};

// Activar Sidebar para Móviles
if ($('menuBtn')) $('menuBtn').onclick = () => { $('sidebar').classList.add('open'); $('scrim').classList.add('open'); };
if ($('scrim')) $('scrim').onclick = () => { $('sidebar').classList.remove('open'); $('scrim').classList.remove('open'); };

if ($('captureBtn')) $('captureBtn').onclick = captureHighResolution;
if ($("refreshBtn")) $("refreshBtn").onclick = startModelRefresh;

connectRefreshEvents();
setupTabs();
ensureFilterToggle();
setupParameterFilters();
init();