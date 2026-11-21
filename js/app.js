// ============================================================
// KasirKu — Frontend App (Vanilla JS SPA)
// Prinsip arsitektur (gas-instant-ux):
//  1. SPA: navigasi antar menu tanpa reload (show/hide section)
//  2. Optimistic UI + localStorage: keranjang kasir instan
//  3. Cache sisi-klien (window.appState) + cache server (CacheX di backend)
//  4. Batch: satu panggilan checkout untuk seluruh keranjang
// ============================================================

const GAS_URL = window.APP_CONFIG.GAS_URL;

// ---------------- STATE GLOBAL ----------------
window.appState = {
  session: null,       // { token, role, nama }
  produk: [],
  kategori: [],
  pengaturan: {},
  cart: []             // keranjang kasir aktif
};

// ---------------- UTIL ----------------
function rupiah(n) { return 'Rp' + Number(n || 0).toLocaleString('id-ID'); }
function el(id) { return document.getElementById(id); }
function showToast(msg, type) {
  const box = el('toastBox');
  const t = document.createElement('div');
  t.className = 'toast toast-' + (type || 'info');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(function () { t.classList.add('show'); }, 10);
  setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2500);
}

// ---------------- API WRAPPER (dedupe in-flight, gas-scale-turbo) ----------------
const _inflight = {};
let _writeEpoch = 0;

async function api(action, data) {
  data = data || {};
  if (appState.session && appState.session.token) data.token = appState.session.token;
  data.action = action;

  const isRead = /\.(list|get|summary)$/.test(action) || action === 'ping';
  if (!isRead) {
    _writeEpoch++;
    return apiRun(data);
  }
  const key = _writeEpoch + '|' + JSON.stringify(data);
  if (_inflight[key]) return _inflight[key];
  const p = apiRun(data);
  _inflight[key] = p;
  p.finally(function () { delete _inflight[key]; });
  return p;
}

async function apiRun(data) {
  try {
    const res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // wajib, hindari CORS preflight
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!json.success) {
      if (json.code === 'AUTH') { doLogout(true); }
      throw new Error(json.message || 'Terjadi kesalahan');
    }
    return json.data;
  } catch (err) {
    showToast('⚠️ ' + err.message, 'danger');
    throw err;
  }
}

// ============================================================
// AUTH
// ============================================================
function loadSessionFromStorage() {
  try {
    const raw = localStorage.getItem('kasirku_session');
    if (raw) appState.session = JSON.parse(raw);
  } catch (e) { appState.session = null; }
}
function saveSessionToStorage() {
  localStorage.setItem('kasirku_session', JSON.stringify(appState.session));
}
function doLogout(expired) {
  appState.session = null;
  localStorage.removeItem('kasirku_session');
  renderAuthView();
  if (expired) showToast('Sesi berakhir, silakan login kembali.', 'warning');
}

async function handleLogin(e) {
  e.preventDefault();
  const username = el('loginUsername').value.trim();
  const password = el('loginPassword').value;
  const btn = el('btnLogin');
  btn.disabled = true; btn.textContent = 'Masuk...';
  try {
    const res = await api('auth.login', { username: username, password: password });
    appState.session = { token: res.token, role: res.role, nama: res.nama };
    saveSessionToStorage();
    await bootApp();
  } catch (err) {
    // pesan error sudah ditoast oleh apiRun
  } finally {
    btn.disabled = false; btn.textContent = 'Masuk';
  }
}

function renderAuthView() {
  el('authView').style.display = 'flex';
  el('appShell').style.display = 'none';
}

// ============================================================
// BOOT APP
// ============================================================
async function bootApp() {
  el('authView').style.display = 'none';
  el('appShell').style.display = 'flex';
  el('userNama').textContent = appState.session.nama + ' (' + (appState.session.role === 'owner' ? 'Owner' : 'Kasir') + ')';
  applyRoleVisibility();

  try {
    const [produk, kategori, pengaturan] = await Promise.all([
      api('produk.list'), api('kategori.list'), api('pengaturan.get')
    ]);
    appState.produk = produk;
    appState.kategori = kategori;
    appState.pengaturan = pengaturan;
    applyBranding();
    renderKasirSection();
    navigateTo('kasir');
  } catch (e) { /* toast sudah tampil */ }
}

function applyRoleVisibility() {
  const isOwner = appState.session.role === 'owner';
  document.querySelectorAll('[data-owner-only]').forEach(function (node) {
    node.style.display = isOwner ? '' : 'none';
  });
}

function applyBranding() {
  const p = appState.pengaturan;
  el('brandNama').textContent = p.Nama_Toko || 'KasirKu';
  if (p.Logo_URL) { el('brandLogo').src = p.Logo_URL; el('brandLogo').style.display = ''; }
}

// ============================================================
// SPA NAVIGASI (Prinsip 1)
// ============================================================
function navigateTo(sectionId) {
  document.querySelectorAll('.content-section').forEach(function (s) { s.classList.remove('active'); });
  document.querySelectorAll('.nav-link').forEach(function (a) { a.classList.remove('active'); });
  el('section-' + sectionId).classList.add('active');
  const navLink = document.querySelector('[data-section="' + sectionId + '"]');
  if (navLink) navLink.classList.add('active');
  el('pageTitle').textContent = navLink ? navLink.textContent.trim() : sectionId;

  if (sectionId === 'produk') renderProdukTable();
  if (sectionId === 'riwayat') loadRiwayat();
  if (sectionId === 'dashboard') loadDashboard();
  if (sectionId === 'pengaturan') renderPengaturanForm();

  closeSidebarMobile();
}
function toggleSidebar() { el('sidebar').classList.toggle('show'); }
function closeSidebarMobile() { el('sidebar').classList.remove('show'); }

// ============================================================
// KASIR / POS (Prinsip 2: Optimistic UI + LocalStorage)
// ============================================================
function loadCartFromStorage() {
  try { appState.cart = JSON.parse(localStorage.getItem('kasirku_cart') || '[]'); }
  catch (e) { appState.cart = []; }
}
function saveCartToStorage() { localStorage.setItem('kasirku_cart', JSON.stringify(appState.cart)); }

function renderKasirSection() {
  loadCartFromStorage();
  renderProdukGrid(appState.produk);
  renderKategoriFilter();
  renderCart();
}

function renderKategoriFilter() {
  const sel = el('filterKategori');
  sel.innerHTML = '<option value="">Semua Kategori</option>' +
    appState.kategori.map(function (k) { return '<option value="' + k.Nama_Kategori + '">' + k.Nama_Kategori + '</option>'; }).join('');
}

function renderProdukGrid(list) {
  const grid = el('produkGrid');
  const aktif = list.filter(function (p) { return p.Status_Aktif !== false && p.Status_Aktif !== 'FALSE'; });
  if (!aktif.length) { grid.innerHTML = '<p class="empty-state">Belum ada produk aktif.</p>'; return; }
  grid.innerHTML = aktif.map(function (p) {
    return '<div class="produk-card" onclick="addToCart(\'' + p.ID_Produk + '\')">' +
      '<div class="produk-card-name">' + p.Nama_Produk + '</div>' +
      '<div class="produk-card-price">' + rupiah(p.Harga_Jual) + '</div>' +
      '<div class="produk-card-stock">Stok: ' + p.Stok + '</div>' +
      '</div>';
  }).join('');
}

function handleSearchProduk(q) {
  q = q.toLowerCase();
  const kategori = el('filterKategori').value;
  const filtered = appState.produk.filter(function (p) {
    const cocokNama = p.Nama_Produk.toLowerCase().indexOf(q) > -1;
    const cocokKategori = !kategori || p.Kategori === kategori;
    return cocokNama && cocokKategori;
  });
  renderProdukGrid(filtered);
}

function addToCart(idProduk) {
  const p = appState.produk.find(function (x) { return x.ID_Produk === idProduk; });
  if (!p) return;
  const existing = appState.cart.find(function (c) { return c.ID_Produk === idProduk; });
  const stokTersisa = Number(p.Stok) - (existing ? existing.Qty : 0);
  if (stokTersisa <= 0) { showToast('Stok ' + p.Nama_Produk + ' habis', 'warning'); return; }

  if (existing) existing.Qty += 1;
  else appState.cart.push({ ID_Produk: p.ID_Produk, Nama_Produk: p.Nama_Produk, Qty: 1, Harga_Satuan: Number(p.Harga_Jual) });

  saveCartToStorage();
  renderCart();
}

function updateCartQty(idProduk, qty) {
  qty = Math.max(0, Number(qty));
  const item = appState.cart.find(function (c) { return c.ID_Produk === idProduk; });
  if (!item) return;
  if (qty === 0) { appState.cart = appState.cart.filter(function (c) { return c.ID_Produk !== idProduk; }); }
  else item.Qty = qty;
  saveCartToStorage();
  renderCart();
}
function removeFromCart(idProduk) {
  appState.cart = appState.cart.filter(function (c) { return c.ID_Produk !== idProduk; });
  saveCartToStorage();
  renderCart();
}

function renderCart() {
  const box = el('cartItems');
  if (!appState.cart.length) {
    box.innerHTML = '<p class="empty-state">Keranjang kosong</p>';
  } else {
    box.innerHTML = appState.cart.map(function (c) {
      return '<div class="cart-item">' +
        '<div class="cart-item-info"><div>' + c.Nama_Produk + '</div>' +
        '<div class="cart-item-price">' + rupiah(c.Harga_Satuan) + '</div></div>' +
        '<input type="number" min="0" value="' + c.Qty + '" class="cart-qty" onchange="updateCartQty(\'' + c.ID_Produk + '\', this.value)">' +
        '<div class="cart-item-subtotal">' + rupiah(c.Qty * c.Harga_Satuan) + '</div>' +
        '<button class="btn-icon" onclick="removeFromCart(\'' + c.ID_Produk + '\')">&times;</button>' +
        '</div>';
    }).join('');
  }
  const total = appState.cart.reduce(function (s, c) { return s + c.Qty * c.Harga_Satuan; }, 0);
  el('cartTotal').textContent = rupiah(total);
  el('btnBayar').disabled = appState.cart.length === 0;
}

function clearCart() {
  appState.cart = [];
  saveCartToStorage();
  renderCart();
}

async function handleCheckout() {
  if (!appState.cart.length) return;
  const btn = el('btnBayar');
  btn.disabled = true; btn.textContent = 'Memproses...';
  try {
    const trx = await api('transaksi.checkout', { items: appState.cart, metodeBayar: 'Tunai' });
    showToast('✅ Transaksi tersimpan: ' + trx.ID_Transaksi, 'success');

    // kurangi stok lokal secara optimistik agar grid langsung update
    trx.Items.forEach(function (it) {
      const p = appState.produk.find(function (x) { return x.ID_Produk === it.ID_Produk; });
      if (p) p.Stok = Number(p.Stok) - Number(it.Qty);
    });
    clearCart();
    renderProdukGrid(appState.produk);

    await Printer.cetakStruk(trx, appState.pengaturan);
  } catch (e) { /* toast sudah tampil */ }
  finally { btn.disabled = false; btn.textContent = 'Bayar & Cetak Struk'; }
}

// ============================================================
// PRODUK (Kelola)
// ============================================================
function renderProdukTable() {
  const isOwner = appState.session.role === 'owner';
  const tbody = el('produkTableBody');
  tbody.innerHTML = appState.produk.map(function (p) {
    return '<tr>' +
      '<td>' + p.Nama_Produk + '</td>' +
      '<td>' + (p.Kategori || '-') + '</td>' +
      '<td>' + rupiah(p.Harga_Jual) + '</td>' +
      '<td>' + p.Stok + '</td>' +
      '<td><span class="badge ' + (p.Status_Aktif === false || p.Status_Aktif === 'FALSE' ? 'badge-red' : 'badge-green') + '">' +
        (p.Status_Aktif === false || p.Status_Aktif === 'FALSE' ? 'Nonaktif' : 'Aktif') + '</span></td>' +
      '<td>' + (isOwner ?
        '<button class="btn-sm" onclick="openProdukModal(\'' + p.ID_Produk + '\')">Edit</button> ' +
        '<button class="btn-sm btn-sm-outline" onclick="toggleProdukStatus(\'' + p.ID_Produk + '\', ' + (p.Status_Aktif === false || p.Status_Aktif === 'FALSE') + ')">' +
        ((p.Status_Aktif === false || p.Status_Aktif === 'FALSE') ? 'Aktifkan' : 'Nonaktifkan') + '</button>'
        : '-') + '</td>' +
      '</tr>';
  }).join('');
}

function openProdukModal(idProduk) {
  const p = idProduk ? appState.produk.find(function (x) { return x.ID_Produk === idProduk; }) : {};
  el('produkModalTitle').textContent = idProduk ? 'Edit Produk' : 'Tambah Produk';
  el('pmId').value = p.ID_Produk || '';
  el('pmNama').value = p.Nama_Produk || '';
  el('pmKategori').value = p.Kategori || '';
  el('pmHargaBeli').value = p.Harga_Beli || '';
  el('pmHargaJual').value = p.Harga_Jual || '';
  el('pmStok').value = p.Stok || 0;
  el('pmSatuan').value = p.Satuan || 'pcs';
  el('pmBarcode').value = p.Barcode || '';
  el('modalProduk').classList.add('show');
}
function closeProdukModal() { el('modalProduk').classList.remove('show'); }

async function submitProdukForm(e) {
  e.preventDefault();
  const produk = {
    ID_Produk: el('pmId').value || undefined,
    Nama_Produk: el('pmNama').value.trim(),
    Kategori: el('pmKategori').value.trim(),
    Harga_Beli: Number(el('pmHargaBeli').value || 0),
    Harga_Jual: Number(el('pmHargaJual').value || 0),
    Stok: Number(el('pmStok').value || 0),
    Satuan: el('pmSatuan').value.trim() || 'pcs',
    Barcode: el('pmBarcode').value.trim()
  };
  try {
    const saved = await api('produk.save', { produk: produk });
    showToast('Produk tersimpan', 'success');
    closeProdukModal();
    const idx = appState.produk.findIndex(function (x) { return x.ID_Produk === saved.ID_Produk; });
    if (idx > -1) appState.produk[idx] = Object.assign({}, appState.produk[idx], saved);
    else appState.produk.push(saved);
    renderProdukTable();
    renderProdukGrid(appState.produk);
  } catch (e) { /* toast sudah tampil */ }
}

async function toggleProdukStatus(id, aktifkan) {
  try {
    await api('produk.setStatus', { id: id, aktif: aktifkan });
    const p = appState.produk.find(function (x) { return x.ID_Produk === id; });
    if (p) p.Status_Aktif = aktifkan;
    renderProdukTable();
    renderProdukGrid(appState.produk);
  } catch (e) { /* toast sudah tampil */ }
}

// ============================================================
// RIWAYAT TRANSAKSI
// ============================================================
async function loadRiwayat(filterTanggal) {
  const tbody = el('riwayatTableBody');
  tbody.innerHTML = '<tr><td colspan="6">Memuat...</td></tr>';
  try {
    const list = await api('transaksi.list', filterTanggal ? { tanggal: filterTanggal } : {});
    appState._riwayat = list;
    renderRiwayatTable(list);
  } catch (e) { tbody.innerHTML = '<tr><td colspan="6">Gagal memuat data.</td></tr>'; }
}
function renderRiwayatTable(list) {
  const isOwner = appState.session.role === 'owner';
  const tbody = el('riwayatTableBody');
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="6">Belum ada transaksi.</td></tr>'; return; }
  tbody.innerHTML = list.map(function (r) {
    const batal = r.Status === 'Dibatalkan';
    return '<tr>' +
      '<td>' + r.ID_Transaksi + '</td>' +
      '<td>' + new Date(r.Tanggal_Waktu).toLocaleString('id-ID') + '</td>' +
      '<td>' + r.Kasir + '</td>' +
      '<td>' + rupiah(r.Total_Bayar) + '</td>' +
      '<td><span class="badge ' + (batal ? 'badge-red' : 'badge-green') + '">' + r.Status + '</span></td>' +
      '<td>' +
        '<button class="btn-sm" onclick="cetakUlang(\'' + r.ID_Transaksi + '\')">Cetak</button> ' +
        (isOwner && !batal ? '<button class="btn-sm btn-sm-outline" onclick="voidTransaksi(\'' + r.ID_Transaksi + '\')">Void</button>' : '') +
      '</td></tr>';
  }).join('');
}
function searchRiwayat(tanggal) { loadRiwayat(tanggal); }

async function cetakUlang(idTransaksi) {
  const r = (appState._riwayat || []).find(function (x) { return x.ID_Transaksi === idTransaksi; });
  if (!r) return;
  // Riwayat tidak menyimpan detail item dalam list ringkas; minta backend bila perlu detail lengkap.
  const trx = {
    ID_Transaksi: r.ID_Transaksi, Tanggal_Waktu: r.Tanggal_Waktu, Kasir: r.Kasir,
    Items: [{ Nama_Produk: 'Lihat Google Sheets Detail_Transaksi untuk rincian item', Qty: 1, Harga_Satuan: r.Total_Bayar }],
    Subtotal: r.Subtotal, Diskon: r.Diskon, Total_Bayar: r.Total_Bayar
  };
  await Printer.cetakStruk(trx, appState.pengaturan);
}

async function voidTransaksi(idTransaksi) {
  if (!confirm('Batalkan transaksi ' + idTransaksi + '? Stok produk akan dikembalikan.')) return;
  try {
    await api('transaksi.void', { id: idTransaksi });
    showToast('Transaksi dibatalkan', 'success');
    loadRiwayat();
  } catch (e) { /* toast sudah tampil */ }
}

// ============================================================
// DASHBOARD (owner only)
// ============================================================
async function loadDashboard() {
  try {
    const d = await api('dashboard.summary');
    el('kpiOmzetHari').textContent = rupiah(d.omzetHari);
    el('kpiTrxHari').textContent = d.trxHari;
    el('kpiOmzetBulan').textContent = rupiah(d.omzetBulan);
    el('dashTerlaris').innerHTML = d.produkTerlaris.length
      ? d.produkTerlaris.map(function (t) { return '<li>' + t.nama + ' — ' + t.qty + ' terjual</li>'; }).join('')
      : '<li>Belum ada data penjualan</li>';
  } catch (e) { /* toast sudah tampil */ }
}

// ============================================================
// PENGATURAN TOKO (owner only)
// ============================================================
function renderPengaturanForm() {
  const p = appState.pengaturan;
  el('stNamaToko').value = p.Nama_Toko || '';
  el('stAlamat').value = p.Alamat || '';
  el('stTelepon').value = p.No_Telepon || '';
  el('stLogoUrl').value = p.Logo_URL || '';
  el('stFooter').value = p.Footer_Struk || '';
  el('stKertas').value = localStorage.getItem('kasirku_kertas') || '58';
  el('stCetakLogo').checked = localStorage.getItem('kasirku_cetak_logo') !== '0';
  el('stCetakQr').checked = localStorage.getItem('kasirku_cetak_qr') !== '0';
}
async function submitPengaturanForm(e) {
  e.preventDefault();
  const pengaturan = {
    Nama_Toko: el('stNamaToko').value.trim(),
    Alamat: el('stAlamat').value.trim(),
    No_Telepon: el('stTelepon').value.trim(),
    Logo_URL: el('stLogoUrl').value.trim(),
    Footer_Struk: el('stFooter').value.trim()
  };
  localStorage.setItem('kasirku_kertas', el('stKertas').value);
  localStorage.setItem('kasirku_cetak_logo', el('stCetakLogo').checked ? '1' : '0');
  localStorage.setItem('kasirku_cetak_qr', el('stCetakQr').checked ? '1' : '0');
  try {
    await api('pengaturan.save', { pengaturan: pengaturan });
    appState.pengaturan = pengaturan;
    applyBranding();
    showToast('Pengaturan toko disimpan', 'success');
  } catch (e) { /* toast sudah tampil */ }
}

// ---- Import Produk dari CSV (gas-migrasi-database: upsert idempoten) ----
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(function (h) { return h.trim(); });
  return lines.slice(1).filter(function (l) { return l.trim(); }).map(function (line) {
    const cols = line.split(',');
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = (cols[i] || '').trim(); });
    ['Harga_Beli', 'Harga_Jual', 'Stok'].forEach(function (f) { if (obj[f] !== undefined) obj[f] = Number(obj[f] || 0); });
    return obj;
  });
}

async function importProdukCsv(dryRun) {
  const file = el('csvFile').files[0];
  if (!file) { showToast('Pilih file CSV terlebih dahulu', 'warning'); return; }
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) { showToast('File CSV kosong atau format salah', 'warning'); return; }

  try {
    const report = await api('produk.import', { rows: rows, dryRun: !!dryRun, overwrite: el('csvOverwrite').checked });
    el('importReport').innerHTML =
      '<strong>' + (dryRun ? 'Hasil Pindai (belum disimpan):' : 'Hasil Import:') + '</strong><br>' +
      '✅ Baru: ' + report.inserted + ' &nbsp; 🔄 Diperbarui: ' + report.updated + ' &nbsp; ⏭️ Dilewati: ' + report.skipped;
    if (!dryRun) {
      const produk = await api('produk.list');
      appState.produk = produk;
      renderProdukTable();
      renderProdukGrid(appState.produk);
      showToast('Import produk selesai', 'success');
    }
  } catch (e) { /* toast sudah tampil */ }
}

async function hubungkanPrinter() {
  try {
    const nama = await Printer.connect();
    showToast('Terhubung ke printer: ' + nama, 'success');
  } catch (e) {
    showToast('Gagal terhubung: ' + e.message, 'danger');
  }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
  loadSessionFromStorage();
  if (appState.session && appState.session.token) {
    bootApp();
  } else {
    renderAuthView();
  }

  el('loginForm').addEventListener('submit', handleLogin);
  el('produkForm').addEventListener('submit', submitProdukForm);
  el('pengaturanForm').addEventListener('submit', submitPengaturanForm);
  el('akunForm').addEventListener('submit', submitAkunForm);
});

async function submitAkunForm(e) {
  e.preventDefault();
  const payload = {
    currentPassword: el('akCurPass').value,
    newUsername: el('akNewUser').value.trim(),
    newPassword: el('akNewPass').value
  };
  if (!payload.newUsername && !payload.newPassword) {
    showToast('Isi username baru atau password baru dulu', 'warning');
    return;
  }
  try {
    await api('auth.changeCredentials', payload);
    showToast('Akun diperbarui, silakan login ulang', 'success');
    setTimeout(function () { doLogout(); }, 800);
  } catch (e) { /* toast sudah tampil */ }
}
