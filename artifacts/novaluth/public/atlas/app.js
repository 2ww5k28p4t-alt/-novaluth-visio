/* ================= Atlas des luthiers d'Europe ================= */
/* Configuration de la liaison avec NovaLuth.
   Renseignez apiBase avec l'origine de l'application NovaLuth (ex. "https://novaluth.com")
   pour que la carte affiche automatiquement les fiches validées et vérifie le rôle
   administrateur côté serveur. Laissé vide, la carte fonctionne en mode démonstration. */
const CONFIG = Object.assign({
  apiBase: '',
  cheminFiches: '/api/atlas/luthiers',
  cheminSession: '/api/atlas/session',
  cheminAdmin: '/api/atlas/luthiers',
  cheminConnexion: '/admin',
  intervalleSync: 120000
}, window.NOVALUTH_ATLAS || {});
const API_ON = !!CONFIG.apiBase;
const api = p => CONFIG.apiBase.replace(/\/$/, '') + p;


const INSTR = [
  { k: 'quatuor', l: 'Violon / quatuor', c: 'quatuor' },
  { k: 'guitare', l: 'Guitare', c: 'guitare' },
  { k: 'archets', l: 'Archets', c: 'archets' },
  { k: 'pincees', l: 'Autres cordes pincées', c: 'autre' },
  { k: 'anciens', l: 'Instruments anciens', c: 'autre' },
  { k: 'contrebasse', l: 'Contrebasse', c: 'autre' },
  { k: 'harpe', l: 'Harpe', c: 'autre' }
];
const SPECS = [
  { k: 'fabrication', l: 'Fabrication' },
  { k: 'reparation', l: 'Réparation' },
  { k: 'restauration', l: 'Restauration' },
  { k: 'expertise', l: 'Expertise' },
  { k: 'vente', l: 'Vente / location' }
];
const INSTR_LABEL = Object.fromEntries(INSTR.map(i => [i.k, i.l]));
const SPEC_LABEL = Object.fromEntries(SPECS.map(s => [s.k, s.l]));

const PAYS = ['Allemagne', 'Autriche', 'Belgique', 'Bulgarie', 'Croatie', 'Chypre', 'Danemark', 'Espagne', 'Estonie',
  'Finlande', 'France', 'Grèce', 'Hongrie', 'Irlande', 'Islande', 'Italie', 'Lettonie', 'Lituanie', 'Luxembourg',
  'Malte', 'Monaco', 'Norvège', 'Pays-Bas', 'Pologne', 'Portugal', 'Roumanie', 'Royaume-Uni', 'Serbie', 'Slovaquie',
  'Slovénie', 'Suède', 'Suisse', 'Tchéquie'];
const CC = { Allemagne: 'DE', Autriche: 'AT', Belgique: 'BE', Bulgarie: 'BG', Croatie: 'HR', Chypre: 'CY', Danemark: 'DK',
  Espagne: 'ES', Estonie: 'EE', Finlande: 'FI', France: 'FR', 'Grèce': 'GR', Hongrie: 'HU', Irlande: 'IE', Islande: 'IS',
  Italie: 'IT', Lettonie: 'LV', Lituanie: 'LT', Luxembourg: 'LU', Malte: 'MT', Monaco: 'MC', 'Norvège': 'NO',
  'Pays-Bas': 'NL', Pologne: 'PL', Portugal: 'PT', Roumanie: 'RO', 'Royaume-Uni': 'GB', Serbie: 'RS', Slovaquie: 'SK',
  'Slovénie': 'SI', 'Suède': 'SE', Suisse: 'CH', 'Tchéquie': 'CZ' };

const PAGE = 40;
const EUROPE = [[35.5, -10.5], [61.5, 30.5]];

const state = {
  base: [], manual: [], all: [],
  instr: new Set(), spec: new Set(), countries: new Set(),
  q: '', web: false, precise: false, shown: PAGE, selected: null,
  editing: null, picking: false, nextId: -1,
  admin: !API_ON, role: API_ON ? 'public' : 'demo', sync: null, syncing: false, syncErr: false
};
const markers = new Map();
let map, cluster, tileLayer, labelLayer, theme = 'light', lastFocus = null, pickMarker = null;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = s => (s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const colorOf = r => r.i?.includes('quatuor') ? 'quatuor' : r.i?.includes('guitare') ? 'guitare' : r.i?.includes('archets') ? 'archets' : 'autre';
const cleanUrl = u => {
  u = (u || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^\/+/, '');
};
const shortUrl = u => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

/* ---------- Thème ---------- */
const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_';
const TILES = { light: ESRI + 'Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', dark: ESRI + 'Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}' };
const LABELS = { light: ESRI + 'Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', dark: ESRI + 'Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}' };
function applyTheme(t) {
  theme = t;
  document.documentElement.dataset.theme = t;
  if (tileLayer) tileLayer.setUrl(TILES[t]);
  if (labelLayer) labelLayer.setUrl(LABELS[t]);
}

/* ---------- Toasts ---------- */
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 4200);
}

/* ---------- Initialisation ---------- */
async function init() {
  applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  $('#themeToggle').addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));
  $('#panelToggle').addEventListener('click', e => {
    const sb = $('#sidebar');
    const collapsed = sb.dataset.collapsed !== 'true';
    sb.dataset.collapsed = collapsed;
    e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  });
  if (window.matchMedia('(max-width: 900px)').matches) $('#sidebar').dataset.collapsed = 'true';

  map = L.map('map', { center: [48.5, 10], zoom: 4, minZoom: 3, maxZoom: 16, zoomControl: true, worldCopyJump: false });
  tileLayer = L.tileLayer(TILES[theme], {
    attribution: 'Fond de carte &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 16
  }).addTo(map);
  labelLayer = L.tileLayer(LABELS[theme], { maxZoom: 16, pane: 'shadowPane', opacity: 0.9 }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  const Recentrer = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const b = L.DomUtil.create('button', 'leaflet-bar recenter');
      b.type = 'button';
      b.title = 'Recentrer sur l’Europe';
      b.setAttribute('aria-label', 'Recentrer la carte sur l’Europe');
      b.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><path d="M12 1.8v3M12 19.2v3M22.2 12h-3M4.8 12h-3"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>';
      L.DomEvent.on(b, 'click', e => {
        L.DomEvent.stop(e);
        map.fitBounds(state.all.length ? L.latLngBounds(state.all.map(r => [r.lat, r.lon])).pad(0.08) : EUROPE, { maxZoom: 9, animate: true });
      });
      L.DomEvent.disableClickPropagation(b);
      return b;
    }
  });
  map.addControl(new Recentrer());

  cluster = L.markerClusterGroup({
    showCoverageOnHover: false, maxClusterRadius: 46, spiderfyOnMaxZoom: true, chunkedLoading: true,
    iconCreateFunction: c => {
      const n = c.getChildCount();
      const s = n < 10 ? 32 : n < 50 ? 38 : n < 200 ? 44 : 52;
      return L.divIcon({ html: `<div class="cl" style="width:${s}px;height:${s}px">${n}</div>`, className: '', iconSize: [s, s] });
    }
  });
  map.addLayer(cluster);
  map.on('moveend', () => { state.shown = PAGE; renderList(); });
  map.on('click', e => { if (state.picking) setPicked(e.latlng.lat, e.latlng.lng); });

  buildFormOptions();
  wireFilters();
  wireForm();
  wireData();
  wireSync();
  appliquerRole();

  await verifierSession();
  await synchroniser({ initial: true });

  map.fitBounds(state.all.length ? L.latLngBounds(state.all.map(r => [r.lat, r.lon])).pad(0.04) : EUROPE, { animate: false, maxZoom: 6 });
  $('#loader').classList.add('hidden');

  if (CONFIG.intervalleSync > 0) setInterval(() => synchroniser(), CONFIG.intervalleSync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) synchroniser(); });
}

/* ---------- Rôle : la saisie est réservée aux administrateurs ---------- */
function appliquerRole() {
  document.body.dataset.admin = state.admin ? 'true' : 'false';
  const chip = $('#roleChip');
  if (!API_ON) {
    chip.hidden = false;
    chip.className = 'role-chip demo';
    chip.textContent = 'Mode démonstration — saisie ouverte';
    chip.title = 'Renseignez CONFIG.apiBase dans app.js pour vérifier le rôle administrateur auprès de NovaLuth.';
  } else if (state.admin) {
    chip.hidden = false;
    chip.className = 'role-chip admin';
    chip.textContent = 'Administrateur NovaLuth';
    chip.title = 'Session administrateur vérifiée par NovaLuth.';
  } else {
    chip.hidden = true;
  }
  $('#adminLogin').hidden = !API_ON || state.admin;
}

async function verifierSession() {
  if (!API_ON) { state.admin = true; state.role = 'demo'; appliquerRole(); return; }
  try {
    const res = await fetch(api(CONFIG.cheminSession), { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(res.status);
    const j = await res.json();
    state.role = String(j.role || j.profil || 'public').toLowerCase();
    state.admin = ['admin', 'administrateur', 'administrator'].includes(state.role);
  } catch (e) {
    state.role = 'public';
    state.admin = false;
  }
  appliquerRole();
}

/* ---------- Synchronisation des fiches validées ---------- */
const VALIDES = ['publiee', 'publie', 'validee', 'valide', 'published', 'approved', 'verifiee', 'verifie'];
function estValidee(raw) {
  const st = fold(String(raw.statut ?? raw.status ?? raw.etat ?? ''));
  if (st) return VALIDES.includes(st);
  for (const k of ['valide', 'validee', 'publiee', 'published', 'approved', 'is_valid', 'isValid']) {
    if (raw[k] !== undefined) return raw[k] === true || raw[k] === 1 || fold(String(raw[k])) === 'true';
  }
  return true; // aucun indicateur : la source ne renvoie que des fiches déjà validées
}

async function synchroniser({ initial = false } = {}) {
  if (state.syncing) return;
  state.syncing = true; state.syncErr = false; majSync();
  try {
    const url = API_ON ? api(CONFIG.cheminFiches) : 'data/luthiers.json';
    const res = await fetch(url, API_ON ? { credentials: 'include', headers: { Accept: 'application/json' } } : {});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let data = await res.json();
    if (!Array.isArray(data)) data = data.fiches || data.data || data.items || data.results || [];
    const avant = state.base.length;
    state.base = data.filter(estValidee).map((raw, i) => {
      const rec = normalize(raw);
      if (!rec) return null;
      rec.id = 'nl-' + (raw.id ?? raw.uuid ?? raw.slug ?? `${rec.n}-${i}`);
      rec.m = false;
      rec.nl = API_ON;
      return rec;
    }).filter(Boolean);
    state.sync = new Date();
    const delta = state.base.length - avant;
    refresh({ fit: false });
    if (!initial && delta > 0) toast(`${delta} nouvelle${delta > 1 ? 's' : ''} fiche${delta > 1 ? 's' : ''} validée${delta > 1 ? 's' : ''} publiée${delta > 1 ? 's' : ''} sur la carte.`);
    if (!initial && delta < 0) toast(`${-delta} fiche${delta < -1 ? 's' : ''} retirée${delta < -1 ? 's' : ''} de la carte.`, 'warn');
  } catch (e) {
    state.syncErr = true;
    if (!initial) toast('Synchronisation NovaLuth impossible pour l’instant.', 'warn');
    if (initial) refresh({ fit: false });
  } finally {
    state.syncing = false;
    majSync();
  }
}

function majSync() {
  const el = $('#syncChip');
  if (!el) return;
  const dot = el.querySelector('.sdot');
  const txt = el.querySelector('.stxt');
  el.hidden = false;
  if (state.syncing) { el.dataset.st = 'busy'; txt.textContent = 'Synchronisation…'; }
  else if (state.syncErr) { el.dataset.st = 'err'; txt.textContent = API_ON ? 'NovaLuth injoignable' : 'Source locale indisponible'; }
  else if (!state.sync) { el.dataset.st = 'idle'; txt.textContent = 'En attente'; }
  else { el.dataset.st = 'ok'; txt.textContent = (API_ON ? 'NovaLuth · ' : 'Local · ') + depuis(state.sync); }
  el.title = API_ON
    ? 'Les fiches validées dans NovaLuth arrivent automatiquement sur la carte. Cliquez pour actualiser maintenant.'
    : 'Source locale data/luthiers.json. Cliquez pour recharger.';
  if (dot) dot.setAttribute('aria-hidden', 'true');
}

function depuis(d) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'à l’instant';
  if (s < 5400) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.round(s / 3600)} h`;
}

function wireSync() {
  $('#syncChip').addEventListener('click', () => synchroniser());
  $('#adminLogin').addEventListener('click', () => {
    window.open(api(CONFIG.cheminConnexion) + '?redirect=' + encodeURIComponent(location.href), '_blank', 'noopener');
  });
  setInterval(() => { if (state.sync && !state.syncing) majSync(); }, 60000);
}

/* ---------- Rafraîchissement global ---------- */
function refresh({ fit = true } = {}) {
  state.all = [...state.base, ...state.manual];
  document.body.dataset.empty = state.all.length ? 'false' : 'true';
  syncMarkers();
  buildFilters();
  buildSources();
  buildHeader();
  buildMyData();
  appliquerRole();
  apply(fit);
}

function buildHeader() {
  const n = state.all.length;
  if (!n) {
    $('#brandSub').textContent = 'Carte vierge — ajoutez votre première fiche';
    return;
  }
  const pays = new Set(state.all.map(r => r.p).filter(Boolean)).size;
  const src = new Set(state.all.map(r => r.as).filter(Boolean)).size;
  $('#brandSub').textContent = `${n} atelier${n > 1 ? 's' : ''} · ${pays} pays` + (src ? ` · ${src} annuaire${src > 1 ? 's' : ''}` : '');
}

/* ---------- Marqueurs ---------- */
function syncMarkers() {
  const ids = new Set(state.all.map(r => r.id));
  [...markers.keys()].forEach(id => { if (!ids.has(id)) { cluster.removeLayer(markers.get(id)); markers.delete(id); } });
  state.all.forEach(r => {
    if (markers.has(r.id)) return;
    const m = L.marker([r.lat, r.lon], {
      icon: L.divIcon({
        className: 'pin' + (r.m ? ' man' : ''),
        html: `<span style="background:var(--c-${colorOf(r)})"></span>`,
        iconSize: [13, 13], iconAnchor: [6, 6]
      }),
      title: r.n, alt: `${r.n}${r.v ? ', ' + r.v : ''}`, riseOnHover: true
    });
    m.bindPopup(() => popup(r), { closeButton: true, autoPanPadding: [24, 24], minWidth: 268 });
    m.on('popupopen', () => { state.selected = r.id; renderList(); wirePopup(r); });
    markers.set(r.id, m);
  });
}

function popup(r) {
  const tags = [...(r.i || []).map(k => `<span class="tag i">${esc(INSTR_LABEL[k] || k)}</span>`),
    ...(r.s || []).map(k => `<span class="tag">${esc(SPEC_LABEL[k] || k)}</span>`)].join('');
  const rows = [];
  if (r.a) rows.push(['Adresse', esc(r.a)]);
  else if (r.v) rows.push(['Localité', `${esc(r.v)} <em>(adresse non renseignée)</em>`]);
  if (r.t) rows.push(['Tél.', `<a href="tel:${esc(r.t.replace(/[^+\d]/g, ''))}">${esc(r.t)}</a>`]);
  if (r.e) rows.push(['Email', `<a href="mailto:${esc(r.e)}">${esc(r.e)}</a>`]);
  if (r.w) rows.push(['Site', `<a href="${esc(r.w)}" target="_blank" rel="noopener">${esc(shortUrl(r.w))}</a>`]);
  const src = r.su
    ? `Source : <a href="${esc(r.su)}" target="_blank" rel="noopener">${esc(r.as || 'annuaire')}</a>`
    : (r.as ? `Source : ${esc(r.as)}` : 'Fiche saisie manuellement');
  const badge = r.m ? '<span class="pbadge man">Saisie administrateur</span>'
    : (r.nl ? '<span class="pbadge ok">Fiche validée NovaLuth</span>' : '');
  const actions = state.admin
    ? `<div class="pop-actions"><button type="button" class="btn small ghost" data-edit="${esc(r.id)}">Modifier</button><button type="button" class="btn small ghost danger" data-del="${esc(r.id)}">Supprimer</button></div>`
    : '';
  return `<div class="pop">
    ${badge}
    <h3>${esc(r.n)}</h3>
    <div class="loc">${esc(r.v || '')}${r.v && r.p ? ' · ' : ''}${esc(r.p || '')}${r.g === 'ville' ? ' · <em>localisation au niveau de la ville</em>' : ''}</div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    <div class="src">${src}</div>
    ${actions}
  </div>`;
}

function wirePopup(r) {
  const el = document.querySelector('.leaflet-popup-content');
  if (!el) return;
  el.querySelector('[data-edit]')?.addEventListener('click', () => openForm(r));
  el.querySelector('[data-del]')?.addEventListener('click', () => removeEntry(r.id));
}

/* ---------- Filtres ---------- */
function count(pred) { return state.all.filter(pred).length; }

function buildFilters() {
  const empty = !state.all.length;
  if (empty) {
    $('#fInstr').innerHTML = '<p class="nofilter">Les types d’instrument s’afficheront dès qu’une fiche sera saisie.</p>';
    $('#fSpec').innerHTML = '<p class="nofilter">Les spécialisations s’afficheront dès qu’une fiche sera saisie.</p>';
    $('#fCountry').innerHTML = '<p class="nofilter">Aucun pays à filtrer pour l’instant.</p>';
    return;
  }
  $('#fInstr').innerHTML = INSTR.filter(i => count(r => r.i?.includes(i.k))).map(i =>
    `<label class="chip"><input type="checkbox" value="${i.k}" data-f="instr"${state.instr.has(i.k) ? ' checked' : ''}><i class="dot ${i.c}"></i>${esc(i.l)}<span class="n">${count(r => r.i?.includes(i.k))}</span></label>`).join('')
    || '<p class="nofilter">Aucun instrument renseigné sur les fiches actuelles.</p>';
  $('#fSpec').innerHTML = SPECS.filter(s => count(r => r.s?.includes(s.k))).map(s =>
    `<label class="chip"><input type="checkbox" value="${s.k}" data-f="spec"${state.spec.has(s.k) ? ' checked' : ''}>${esc(s.l)}<span class="n">${count(r => r.s?.includes(s.k))}</span></label>`).join('')
    || '<p class="nofilter">Aucune spécialisation renseignée sur les fiches actuelles.</p>';

  const byCountry = {};
  state.all.forEach(r => { if (r.p) byCountry[r.p] = (byCountry[r.p] || 0) + 1; });
  $('#fCountry').innerHTML = Object.entries(byCountry).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr')).map(([c, n]) =>
    `<label class="crow"><input type="checkbox" value="${esc(c)}" data-f="country"${state.countries.has(c) ? ' checked' : ''}>${esc(c)}<span class="n">${n}</span></label>`).join('');
}

function wireFilters() {
  document.addEventListener('change', e => {
    const f = e.target.dataset?.f;
    if (!f) return;
    const set = f === 'instr' ? state.instr : f === 'spec' ? state.spec : state.countries;
    e.target.checked ? set.add(e.target.value) : set.delete(e.target.value);
    apply();
  });
  let qTimer;
  $('#q').addEventListener('input', e => {
    state.q = fold(e.target.value.trim());
    clearTimeout(qTimer);
    apply(false);
    qTimer = setTimeout(() => { if (state.q) apply(true); }, 500);
  });
  $('#fWeb').addEventListener('change', e => { state.web = e.target.checked; apply(); });
  $('#fPrecise').addEventListener('change', e => { state.precise = e.target.checked; apply(); });
  $('#clearCountries').addEventListener('click', () => { state.countries.clear(); buildFilters(); apply(); });
  $('#resetAll').addEventListener('click', () => {
    state.instr.clear(); state.spec.clear(); state.countries.clear();
    state.q = ''; state.web = false; state.precise = false;
    $('#q').value = ''; $('#fWeb').checked = false; $('#fPrecise').checked = false;
    buildFilters(); apply();
  });
  $('#loadMore').addEventListener('click', () => { state.shown += PAGE; renderList(); });
  $('#addBtn').addEventListener('click', () => openForm());
  $('#emptyAdd').addEventListener('click', () => openForm());
}

function matches(r) {
  if (state.instr.size && !(r.i || []).some(x => state.instr.has(x))) return false;
  if (state.spec.size && !(r.s || []).some(x => state.spec.has(x))) return false;
  if (state.countries.size && !state.countries.has(r.p)) return false;
  if (state.web && !r.w) return false;
  if (state.precise && r.g !== 'adresse') return false;
  if (state.q && !fold(`${r.n} ${r.v} ${r.p} ${r.a} ${r.as}`).includes(state.q)) return false;
  return true;
}

function activeFilters() {
  return state.instr.size || state.spec.size || state.countries.size || state.q || state.web || state.precise;
}

function apply(fit = true) {
  const kept = state.all.filter(matches);
  cluster.clearLayers();
  cluster.addLayers(kept.map(r => markers.get(r.id)).filter(Boolean));
  state.shown = PAGE;
  if (fit && kept.length && activeFilters()) {
    map.fitBounds(L.latLngBounds(kept.map(r => [r.lat, r.lon])).pad(0.12), { maxZoom: 11, animate: true });
  }
  renderList(kept);
}

/* ---------- Liste ---------- */
function renderList(keptArg) {
  const kept = keptArg || state.all.filter(matches);
  const b = map.getBounds();
  const inView = kept.filter(r => b.contains([r.lat, r.lon]));
  const list = (inView.length ? inView : kept).slice().sort((a, b2) => a.n.localeCompare(b2.n, 'fr'));

  $('#resultCount').textContent = state.all.length
    ? `${kept.length} atelier${kept.length > 1 ? 's' : ''}`
    : 'Aucune fiche';
  $('#viewportHint').textContent = !state.all.length ? ''
    : inView.length ? `${inView.length} dans la zone affichée`
      : kept.length ? 'aucun dans la zone — liste complète' : '';

  if (state.syncing && !state.all.length) {
    $('#cards').innerHTML = '<div class="sk"></div><div class="sk"></div><div class="sk"></div>';
    $('#emptyState').hidden = true;
    $('#loadMore').hidden = true;
    $('#resultCount').textContent = 'Chargement…';
    return;
  }
  const page = list.slice(0, state.shown);
  $('#emptyState').hidden = kept.length !== 0;
  $('#emptyText').textContent = state.all.length
    ? 'Aucun atelier ne correspond aux filtres. Élargissez la zone de la carte ou retirez un critère.'
    : state.admin
      ? 'La carte est vierge. Créez une fiche ou validez un dossier dans NovaLuth : les ateliers validés arrivent ici automatiquement.'
      : 'Aucun atelier publié pour l’instant. Les ateliers apparaîtront ici dès que leur dossier sera validé dans NovaLuth.';
  $('#emptyAdd').hidden = state.all.length > 0;

  $('#cards').innerHTML = page.map(r => {
    const tags = [...(r.i || []).slice(0, 2).map(k => `<span class="tag i">${esc(INSTR_LABEL[k] || k)}</span>`),
      ...(r.s || []).slice(0, 2).map(k => `<span class="tag">${esc(SPEC_LABEL[k] || k)}</span>`)].join('');
    return `<button class="card${state.selected === r.id ? ' active' : ''}" type="button" data-id="${r.id}">
      ${r.m ? '<span class="mine" title="Fiche saisie par un administrateur">saisie</span>' : (r.nl ? '<span class="mine ok" title="Fiche validée dans NovaLuth">validée</span>' : '')}
      <span class="cn">${esc(r.n)}</span>
      <span class="cv">${esc(r.v || '—')}${r.p ? ' · ' + esc(r.p) : ''}</span>
      ${tags ? `<span class="tags">${tags}</span>` : ''}
    </button>`;
  }).join('');
  $('#loadMore').hidden = list.length <= state.shown;

  $('#cards').querySelectorAll('.card').forEach(el => {
    el.addEventListener('click', () => {
      const r = state.all.find(x => String(x.id) === el.dataset.id);
      if (!r) return;
      const m = markers.get(r.id);
      state.selected = r.id;
      map.setView([r.lat, r.lon], Math.max(map.getZoom(), 13), { animate: true });
      cluster.zoomToShowLayer(m, () => m.openPopup());
      if (window.matchMedia('(max-width: 900px)').matches) document.querySelector('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

/* ---------- Formulaire ---------- */
function buildFormOptions() {
  $('#fPays').innerHTML = '<option value="">— Choisir un pays —</option>' + PAYS.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#fmInstr').innerHTML = INSTR.map(i =>
    `<label class="chip"><input type="checkbox" value="${i.k}" name="instr"><i class="dot ${i.c}"></i>${esc(i.l)}</label>`).join('');
  $('#fmSpec').innerHTML = SPECS.map(s =>
    `<label class="chip"><input type="checkbox" value="${s.k}" name="spec">${esc(s.l)}</label>`).join('');
}

function openForm(entry = null) {
  state.editing = entry;
  lastFocus = document.activeElement;
  $('#modalTitle').textContent = entry ? 'Modifier la fiche' : 'Nouvelle fiche d\'atelier';
  $('#submitBtn').textContent = entry ? 'Enregistrer les modifications' : 'Enregistrer la fiche';
  $('#form').reset();
  $('#formError').hidden = true;
  $('#geoStatus').className = 'geo-status';
  $('#geoStatus').textContent = 'Renseignez une adresse puis lancez la localisation, ou pointez directement le lieu sur la carte.';
  if (entry) {
    $('#fNom').value = entry.n || ''; $('#fPays').value = entry.p || ''; $('#fVille').value = entry.v || '';
    $('#fAdresse').value = entry.a || ''; $('#fTel').value = entry.t || ''; $('#fEmail').value = entry.e || '';
    $('#fSite').value = entry.w || ''; $('#fAssoc').value = entry.as || ''; $('#fSource').value = entry.su || '';
    $('#fLat').value = entry.lat; $('#fLon').value = entry.lon;
    document.querySelectorAll('#fmInstr input').forEach(i => { i.checked = (entry.i || []).includes(i.value); });
    document.querySelectorAll('#fmSpec input').forEach(i => { i.checked = (entry.s || []).includes(i.value); });
  }
  $('#modal').hidden = false;
  requestAnimationFrame(() => {
    $('#modal').classList.add('open');
    $('.modal-body').scrollTop = 0;
    $('#fNom').focus({ preventScroll: true });
  });
}

function closeForm() {
  $('#modal').classList.remove('open');
  setTimeout(() => { $('#modal').hidden = true; }, 200);
  stopPicking();
  state.editing = null;
  lastFocus?.focus?.();
}

async function geocodeAddress({ silent = false } = {}) {
  const adresse = $('#fAdresse').value.trim();
  const ville = $('#fVille').value.trim();
  const pays = $('#fPays').value;
  const parts = [adresse, ville, pays].filter(Boolean);
  if (!parts.length) {
    if (!silent) setGeo('Renseignez au moins une ville ou une adresse pour lancer la localisation.', 'warn');
    return null;
  }
  setGeo('Localisation en cours…', 'busy');
  try {
    const url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(parts.join(', ')) + '&limit=5&lang=fr';
    const res = await fetch(url);
    const data = await res.json();
    const cc = CC[pays];
    const hit = (data.features || []).find(f => !cc || !f.properties.countrycode || f.properties.countrycode === cc);
    if (!hit) { setGeo('Adresse introuvable. Pointez le lieu sur la carte ou saisissez les coordonnées.', 'warn'); return null; }
    const [lon, lat] = hit.geometry.coordinates;
    const p = hit.properties;
    const precise = ['house', 'street', 'building'].includes(p.type);
    $('#fLat').value = lat.toFixed(6);
    $('#fLon').value = lon.toFixed(6);
    const label = [p.name, p.street, p.postcode, p.city, p.country].filter(Boolean).join(', ');
    setGeo(`${precise ? 'Adresse localisée' : 'Localisation approximative'} : ${label}`, precise ? 'ok' : 'warn');
    return { lat, lon, g: precise ? 'adresse' : 'ville' };
  } catch (e) {
    setGeo('Service de localisation indisponible. Saisissez les coordonnées ou pointez sur la carte.', 'warn');
    return null;
  }
}

function setGeo(msg, kind) {
  const el = $('#geoStatus');
  el.textContent = msg;
  el.className = 'geo-status' + (kind ? ' ' + kind : '');
}

function startPicking() {
  state.picking = true;
  $('#pickBanner').hidden = false;
  $('#modal').classList.add('minimized');
  document.querySelector('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function stopPicking() {
  state.picking = false;
  $('#pickBanner').hidden = true;
  $('#modal').classList.remove('minimized');
  if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
}
function setPicked(lat, lon) {
  $('#fLat').value = lat.toFixed(6);
  $('#fLon').value = lon.toFixed(6);
  if (pickMarker) map.removeLayer(pickMarker);
  pickMarker = L.marker([lat, lon], { icon: L.divIcon({ className: 'pin picked', html: '<span></span>', iconSize: [15, 15], iconAnchor: [7, 7] }) }).addTo(map);
  setGeo(`Position choisie sur la carte : ${lat.toFixed(4)}, ${lon.toFixed(4)}`, 'ok');
  stopPicking();
  $('#pickBanner').hidden = true;
}

function wireForm() {
  $('#modalClose').addEventListener('click', closeForm);
  $('#cancelBtn').addEventListener('click', closeForm);
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeForm(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modal').hidden) { state.picking ? stopPicking() : closeForm(); }
  });
  $('#geoBtn').addEventListener('click', () => geocodeAddress());
  $('#pickBtn').addEventListener('click', startPicking);
  $('#pickCancel').addEventListener('click', stopPicking);

  $('#form').addEventListener('submit', async e => {
    e.preventDefault();
    const nom = $('#fNom').value.trim();
    const pays = $('#fPays').value;
    if (!nom || !pays) {
      showFormError('Le nom de l’atelier et le pays sont obligatoires.');
      (!nom ? $('#fNom') : $('#fPays')).focus();
      return;
    }
    let lat = parseFloat($('#fLat').value.replace(',', '.'));
    let lon = parseFloat($('#fLon').value.replace(',', '.'));
    let g = 'manuel';
    if (!isFinite(lat) || !isFinite(lon)) {
      const geo = await geocodeAddress({ silent: true });
      if (!geo) {
        showFormError('Localisation manquante : lancez « Localiser depuis l’adresse », pointez le lieu sur la carte, ou saisissez latitude et longitude.');
        return;
      }
      lat = geo.lat; lon = geo.lon; g = geo.g;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      showFormError('Coordonnées hors limites : latitude entre -90 et 90, longitude entre -180 et 180.');
      return;
    }

    const rec = {
      id: state.editing ? state.editing.id : state.nextId--,
      n: nom, v: $('#fVille').value.trim(), p: pays, a: $('#fAdresse').value.trim(),
      i: [...document.querySelectorAll('#fmInstr input:checked')].map(i => i.value),
      s: [...document.querySelectorAll('#fmSpec input:checked')].map(i => i.value),
      t: $('#fTel').value.trim(), e: $('#fEmail').value.trim(), w: cleanUrl($('#fSite').value),
      as: $('#fAssoc').value.trim(), su: cleanUrl($('#fSource').value),
      g: state.editing && $('#fLat').value === String(state.editing.lat) ? state.editing.g : g,
      lat: +lat.toFixed(6), lon: +lon.toFixed(6), m: true
    };

    if (API_ON && state.admin) {
      const ok = await envoyerFiche(rec);
      if (!ok) return;
      closeForm();
      await synchroniser();
      return;
    }

    if (state.editing) {
      const idx = state.manual.findIndex(r => r.id === rec.id);
      state.manual[idx] = rec;
      cluster.removeLayer(markers.get(rec.id));
      markers.delete(rec.id);
      toast(`Fiche « ${rec.n} » mise à jour.`);
    } else {
      state.manual.push(rec);
      toast(`Fiche « ${rec.n} » ajoutée à la carte.`);
    }
    closeForm();
    refresh({ fit: false });
    state.selected = rec.id;
    map.setView([rec.lat, rec.lon], Math.max(map.getZoom(), 11), { animate: true });
    setTimeout(() => cluster.zoomToShowLayer(markers.get(rec.id), () => markers.get(rec.id).openPopup()), 350);
  });
}

async function envoyerFiche(rec) {
  const idNl = state.editing && String(state.editing.id).startsWith('nl-') ? String(state.editing.id).slice(3) : null;
  const corps = {
    nom: rec.n, ville: rec.v, pays: rec.p, adresse: rec.a, instruments: rec.i, specialisations: rec.s,
    telephone: rec.t, email: rec.e, site_web: rec.w, association: rec.as, source_url: rec.su,
    latitude: rec.lat, longitude: rec.lon, precision_geocodage: rec.g, origine: 'atlas-admin'
  };
  $('#submitBtn').disabled = true;
  try {
    const res = await fetch(api(CONFIG.cheminAdmin) + (idNl ? '/' + encodeURIComponent(idNl) : ''), {
      method: idNl ? 'PATCH' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corps)
    });
    if (res.status === 401 || res.status === 403) { showFormError('Session administrateur expirée : reconnectez-vous à NovaLuth.'); await verifierSession(); return false; }
    if (!res.ok) { showFormError('NovaLuth a refusé l’enregistrement (' + res.status + '). La fiche n’a pas été publiée.'); return false; }
    toast(idNl ? `Fiche « ${rec.n} » mise à jour dans NovaLuth.` : `Fiche « ${rec.n} » envoyée à NovaLuth.`);
    return true;
  } catch (e) {
    showFormError('NovaLuth injoignable : la fiche n’a pas été enregistrée.');
    return false;
  } finally {
    $('#submitBtn').disabled = false;
  }
}

function showFormError(msg) {
  const el = $('#formError');
  el.textContent = msg;
  el.hidden = false;
}

async function removeEntry(id) {
  if (!state.admin) return;
  const distante = String(id).startsWith('nl-');
  if (distante) {
    const f = state.base.find(x => x.id === id);
    if (!f) return;
    try {
      const res = await fetch(api(CONFIG.cheminAdmin) + '/' + encodeURIComponent(String(id).slice(3)), { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(res.status);
      map.closePopup();
      toast(`Fiche « ${f.n} » retirée de NovaLuth.`, 'warn');
      await synchroniser();
    } catch (e) {
      toast('Suppression refusée par NovaLuth.', 'warn');
    }
    return;
  }
  const r = state.manual.find(x => x.id === id);
  if (!r) return;
  state.manual = state.manual.filter(x => x.id !== id);
  map.closePopup();
  refresh({ fit: false });
  map.fitBounds(state.all.length ? L.latLngBounds(state.all.map(x => [x.lat, x.lon])).pad(0.2) : EUROPE, { maxZoom: 11, animate: true });
  toast(`Fiche « ${r.n} » supprimée.`, 'warn');
}

/* ---------- Export / import ---------- */
const FIELDS = [['n', 'nom'], ['v', 'ville'], ['p', 'pays'], ['a', 'adresse'], ['i', 'instruments'], ['s', 'specialisations'],
  ['t', 'telephone'], ['e', 'email'], ['w', 'site_web'], ['as', 'association_source'], ['su', 'url_source'],
  ['lat', 'latitude'], ['lon', 'longitude'], ['g', 'precision_geocodage']];

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function buildMyData() {
  const n = state.manual.length;
  $('#myData').hidden = n === 0;
  $('#myCount').textContent = n ? `${n} fiche${n > 1 ? 's' : ''}` : '';
}

function wireData() {
  $('#expJson').addEventListener('click', () => {
    download('mes-fiches-luthiers.json', JSON.stringify(state.manual.map(({ m, ...r }) => r), null, 1), 'application/json');
    toast('Export JSON généré.');
  });
  $('#expCsv').addEventListener('click', () => {
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [FIELDS.map(f => f[1]).join(';')];
    state.manual.forEach(r => lines.push(FIELDS.map(([k]) => q(Array.isArray(r[k]) ? r[k].join('; ') : r[k])).join(';')));
    download('mes-fiches-luthiers.csv', '\ufeff' + lines.join('\r\n'), 'text/csv');
    toast('Export CSV généré.');
  });
  $('#impFile').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      const rows = /\.csv$/i.test(file.name) ? parseCsv(txt) : JSON.parse(txt);
      if (!Array.isArray(rows)) throw new Error('format');
      let added = 0;
      rows.forEach(raw => {
        const rec = normalize(raw);
        if (rec) { rec.id = state.nextId--; state.manual.push(rec); added++; }
      });
      refresh({ fit: false });
      if (added) {
        map.fitBounds(L.latLngBounds(state.manual.map(r => [r.lat, r.lon])).pad(0.15), { maxZoom: 11 });
        toast(`${added} fiche${added > 1 ? 's' : ''} importée${added > 1 ? 's' : ''}.`);
      } else {
        toast('Aucune fiche exploitable dans ce fichier (nom et coordonnées requis).', 'warn');
      }
    } catch (err) {
      toast('Fichier illisible : attendu un JSON ou un CSV exporté depuis cette carte.', 'warn');
    }
    e.target.value = '';
  });
  $('#clearMine').addEventListener('click', () => {
    if (!state.manual.length) return;
    const n = state.manual.length;
    state.manual = [];
    map.closePopup();
    refresh({ fit: false });
    map.fitBounds(EUROPE, { animate: true });
    toast(`${n} fiche${n > 1 ? 's' : ''} effacée${n > 1 ? 's' : ''}.`, 'warn');
  });
}

function normalize(raw) {
  const get = (...keys) => { for (const k of keys) { if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k]; } return ''; };
  const listOf = (val, allowed) => String(val || '').split(/[;,]/).map(s => fold(s.trim())).filter(Boolean)
    .map(s => allowed.find(a => fold(a) === s || fold(a).startsWith(s))).filter(Boolean);
  const lat = parseFloat(String(get('lat', 'latitude')).replace(',', '.'));
  const lon = parseFloat(String(get('lon', 'longitude')).replace(',', '.'));
  const nom = String(get('n', 'nom', 'name')).trim();
  if (!nom || !isFinite(lat) || !isFinite(lon)) return null;
  return {
    n: nom, v: String(get('v', 'ville', 'city')).trim(), p: String(get('p', 'pays', 'country')).trim(),
    a: String(get('a', 'adresse', 'address')).trim(),
    i: listOf(get('i', 'instruments'), INSTR.map(x => x.k)),
    s: listOf(get('s', 'specialisations', 'specialisation'), SPECS.map(x => x.k)),
    t: String(get('t', 'telephone', 'tel')).trim(), e: String(get('e', 'email')).trim(),
    w: cleanUrl(get('w', 'site_web', 'site')), as: String(get('as', 'association_source', 'association')).trim(),
    su: cleanUrl(get('su', 'url_source', 'source_url')),
    g: String(get('g', 'precision_geocodage') || 'manuel'), lat: +lat.toFixed(6), lon: +lon.toFixed(6), m: true
  };
}

function parseCsv(txt) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  const sep = (txt.split('\n')[0].match(/;/g) || []).length >= (txt.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  txt = txt.replace(/^\ufeff/, '');
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (inQ) {
      if (c === '"' && txt[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim());
  return rows.filter(r => r.some(v => v.trim())).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/* ---------- Pied de page ---------- */
function buildSources() {
  if (!state.all.length) {
    $('#sourcesIntro').textContent = 'La carte est prête mais volontairement vierge. Chaque fiche saisie conserve le nom de son annuaire d’origine et le lien vers la page source, afin que la donnée reste vérifiable.';
    $('#assocList').innerHTML = '';
    return;
  }
  const by = {};
  state.all.forEach(r => {
    const key = r.as || 'Saisie manuelle (sans annuaire indiqué)';
    by[key] = by[key] || { n: 0, url: r.su };
    by[key].n++;
    if (!by[key].url && r.su) by[key].url = r.su;
  });
  $('#sourcesIntro').textContent = 'Répartition des fiches par annuaire d’origine. Chaque fiche conserve un lien vers sa page source lorsqu’il est renseigné.';
  $('#assocList').innerHTML = Object.entries(by).sort((a, b) => b[1].n - a[1].n).map(([name, v]) =>
    `<li><span>${v.url ? `<a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name)}</span><span class="cnt">${v.n} atelier${v.n > 1 ? 's' : ''}</span></li>`).join('');
}

window.addEventListener('scroll', () => {
  document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

init();
