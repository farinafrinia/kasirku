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
    let libraryTersimpan = null;
    try { libraryTersimpan = pengaturan.Template_Library ? JSON.parse(pengaturan.Template_Library) : null; } catch (e) { libraryTersimpan = null; }
    appState._templateCustom = Array.isArray(libraryTersimpan) ? libraryTersimpan : [];
    applyBranding();
    renderPosTemplateSelect();
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
  if (sectionId === 'akun') el('akNewNama').placeholder = 'Saat ini: ' + (appState.session.nama || '-');

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
    const metodeBayar = el('posMetode').value;
    const trx = await api('transaksi.checkout', { items: appState.cart, metodeBayar: metodeBayar });
    showToast('✅ Transaksi tersimpan: ' + trx.ID_Transaksi, 'success');

    // kurangi stok lokal secara optimistik agar grid langsung update
    trx.Items.forEach(function (it) {
      const p = appState.produk.find(function (x) { return x.ID_Produk === it.ID_Produk; });
      if (p) p.Stok = Number(p.Stok) - Number(it.Qty);
    });
    clearCart();
    renderProdukGrid(appState.produk);

    await Printer.cetakStruk(trx, tokoUntukCetak_());
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
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="7">Belum ada transaksi.</td></tr>'; return; }
  tbody.innerHTML = list.map(function (r) {
    const batal = r.Status === 'Dibatalkan';
    return '<tr>' +
      '<td>' + r.ID_Transaksi + '</td>' +
      '<td>' + new Date(r.Tanggal_Waktu).toLocaleString('id-ID') + '</td>' +
      '<td>' + r.Kasir + '</td>' +
      '<td>' + (r.Metode_Bayar || '-') + '</td>' +
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
    Subtotal: r.Subtotal, Diskon: r.Diskon, Total_Bayar: r.Total_Bayar, Metode_Bayar: r.Metode_Bayar
  };
  await Printer.cetakStruk(trx, tokoUntukCetak_());
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
  aturStatusLogo(p.Logo_URL || '');
  el('stFooter').value = p.Footer_Struk || '';
  el('stKertas').value = localStorage.getItem('kasirku_kertas') || '58';
  el('stTemplate').value = p.Template_Struk || Printer.templateDefault;
  renderPanduanTemplate();
  let blocksTersimpan = null;
  try { blocksTersimpan = p.Template_Blocks ? JSON.parse(p.Template_Blocks) : null; } catch (e) { blocksTersimpan = null; }
  appState.strukBlocks = Array.isArray(blocksTersimpan) && blocksTersimpan.length ? blocksTersimpan : Printer.blokDefault();
  let libraryTersimpan = null;
  try { libraryTersimpan = p.Template_Library ? JSON.parse(p.Template_Library) : null; } catch (e) { libraryTersimpan = null; }
  appState._templateCustom = Array.isArray(libraryTersimpan) ? libraryTersimpan : [];
  // Pilih mode awal: bila template tersimpan persis sama dengan hasil susunan
  // blok tersimpan, buka Mode Mudah (aman, tetap sinkron). Bila sudah diedit
  // manual lebih rumit di Mode Lanjutan, buka Mode Lanjutan agar kode yang
  // sudah dibuat tidak diganti diam-diam oleh susunan blok lama.
  const cocok = el('stTemplate').value.trim() === Printer.blocksToTemplate(appState.strukBlocks).trim();
  pilihModeTemplate(cocok ? 'mudah' : 'lanjutan');
  renderGaleriTemplate();
  renderPosTemplateSelect();
}

// ---- Galeri Template (9 preset siap pakai + template custom tersimpan) ----
function renderGaleriTemplate() {
  const box = el('galeriTemplate');
  if (!box) return;
  const semua = Printer.daftarLibrary(appState.pengaturan);
  const grup = {};
  semua.forEach(function (t) {
    const kat = (appState._templateCustom || []).indexOf(t) > -1 ? 'custom' : (t.kategori || 'custom');
    (grup[kat] = grup[kat] || []).push(t);
  });
  const urutanKategori = ['custom', 'cafe', 'toko', 'laundry'];
  box.innerHTML = urutanKategori.filter(function (k) { return grup[k] && grup[k].length; }).map(function (kat) {
    const judul = (Printer.labelKategori && Printer.labelKategori[kat]) || kat;
    const kartu = grup[kat].map(function (t) {
      const custom = kat === 'custom';
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:8px;background:#fff">' +
        '<span style="font-size:0.88rem">' + t.nama + '</span>' +
        '<span style="display:flex;gap:6px">' +
          '<button type="button" class="btn-sm" onclick="gunakanTemplateGaleri(\'' + t.id + '\')">Gunakan</button>' +
          (custom ? '<button type="button" class="btn-sm btn-sm-outline" onclick="hapusTemplateCustom(\'' + t.id + '\')">Hapus</button>' : '') +
        '</span></div>';
    }).join('');
    return '<div><p style="font-size:0.8rem;font-weight:600;color:var(--text-muted);margin:0 0 6px">' + judul + '</p>' +
      '<div style="display:flex;flex-direction:column;gap:6px">' + kartu + '</div></div>';
  }).join('');
}
function gunakanTemplateGaleri(id) {
  const semua = Printer.daftarLibrary(appState.pengaturan);
  const t = semua.find(function (x) { return x.id === id; });
  if (!t) return;
  appState.strukBlocks = JSON.parse(JSON.stringify(t.blocks));
  renderStrukBlocks();
  sinkronkanTemplateDariBlok();
  pilihModeTemplate('mudah');
  pratinjauStruk();
  showToast('Template "' + t.nama + '" dimuat ke editor — klik Simpan Pengaturan untuk menyimpan sebagai tampilan aktif', 'success');
}
async function simpanTemplateKeLibrary() {
  const nama = prompt('Nama untuk template ini (contoh: "Struk Toko Saya v2"):');
  if (!nama || !nama.trim()) return;
  const idBaru = 'custom_' + Date.now();
  appState._templateCustom = appState._templateCustom || [];
  appState._templateCustom.push({ id: idBaru, nama: nama.trim(), kategori: 'custom', blocks: JSON.parse(JSON.stringify(appState.strukBlocks || [])) });
  const pengaturan = bangunPengaturanPayload_();
  try {
    await api('pengaturan.save', { pengaturan: pengaturan });
    appState.pengaturan = pengaturan;
    renderGaleriTemplate();
    renderPosTemplateSelect();
    showToast('Template "' + nama.trim() + '" tersimpan di galeri', 'success');
  } catch (e) { /* toast sudah tampil */ }
}
async function hapusTemplateCustom(id) {
  if (!confirm('Hapus template ini dari galeri?')) return;
  appState._templateCustom = (appState._templateCustom || []).filter(function (t) { return t.id !== id; });
  const pengaturan = bangunPengaturanPayload_();
  try {
    await api('pengaturan.save', { pengaturan: pengaturan });
    appState.pengaturan = pengaturan;
    renderGaleriTemplate();
    renderPosTemplateSelect();
    showToast('Template dihapus dari galeri', 'success');
  } catch (e) { /* toast sudah tampil */ }
}

// ---- Dropdown pilih template sebelum cetak (Kasir & Cetak Ulang Riwayat) ----
function renderPosTemplateSelect() {
  const sel = el('posTemplate');
  if (!sel) return;
  const terakhir = localStorage.getItem('kasirku_template_pilihan') || '__aktif__';
  const semua = Printer.daftarLibrary(appState.pengaturan);
  const grup = {};
  semua.forEach(function (t) {
    const kat = (appState._templateCustom || []).indexOf(t) > -1 ? 'custom' : (t.kategori || 'custom');
    (grup[kat] = grup[kat] || []).push(t);
  });
  const urutanKategori = ['custom', 'cafe', 'toko', 'laundry'];
  let html = '<option value="__aktif__">⭐ Template Aktif (Pengaturan)</option>';
  urutanKategori.forEach(function (kat) {
    if (!grup[kat] || !grup[kat].length) return;
    const judul = (Printer.labelKategori && Printer.labelKategori[kat]) || kat;
    html += '<optgroup label="' + judul + '">' + grup[kat].map(function (t) {
      return '<option value="' + t.id + '">' + t.nama + '</option>';
    }).join('') + '</optgroup>';
  });
  sel.innerHTML = html;
  sel.value = semua.some(function (t) { return t.id === terakhir; }) ? terakhir : '__aktif__';
}
function tokoUntukCetak_() {
  const sel = el('posTemplate');
  const idTerpilih = sel ? sel.value : '__aktif__';
  if (sel) localStorage.setItem('kasirku_template_pilihan', idTerpilih);
  return Object.assign({}, appState.pengaturan, { Template_Struk: Printer.templateUntukId(appState.pengaturan, idTerpilih) });
}
// Satu fungsi pembangun payload Pengaturan dipakai oleh form Simpan maupun
// aksi Galeri Template (simpan racikan baru), supaya Template_Library &
// Template_Aktif_Id tidak pernah tertimpa kosong secara tidak sengaja
// (backend menulis '' untuk kolom yang tidak disertakan pada payload).
function bangunPengaturanPayload_() {
  return {
    Nama_Toko: el('stNamaToko').value.trim(),
    Alamat: el('stAlamat').value.trim(),
    No_Telepon: el('stTelepon').value.trim(),
    Logo_URL: el('stLogoUrl').value.trim(),
    Footer_Struk: el('stFooter').value.trim(),
    Template_Struk: el('stTemplate').value,
    Template_Blocks: JSON.stringify(appState.strukBlocks || []),
    Template_Library: JSON.stringify(appState._templateCustom || []),
    Template_Aktif_Id: appState.pengaturan.Template_Aktif_Id || ''
  };
}
async function submitPengaturanForm(e) {
  e.preventDefault();
  const pengaturan = bangunPengaturanPayload_();
  localStorage.setItem('kasirku_kertas', el('stKertas').value);
  try {
    await api('pengaturan.save', { pengaturan: pengaturan });
    appState.pengaturan = pengaturan;
    applyBranding();
    renderPosTemplateSelect();
    showToast('Pengaturan toko disimpan', 'success');
  } catch (e) { /* toast sudah tampil */ }
}

// ---- Upload logo dari perangkat (diubah jadi data gambar, bebas masalah CORS saat cetak) ----
function aturStatusLogo(v) {
  const status = el('stLogoStatus');
  if (v && v.indexOf('data:') === 0) {
    status.textContent = '✅ Logo tersimpan dari upload (' + Math.round(v.length / 1024) + ' KB)';
  } else if (v) {
    status.textContent = 'Memakai URL gambar eksternal.';
  } else {
    status.textContent = 'Belum ada logo.';
  }
}
function hapusLogo() {
  el('stLogoUrl').value = '';
  el('stLogoFile').value = '';
  aturStatusLogo('');
  pratinjauStruk();
}
function resizeImageToDataUrl_(img, maxW) {
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}
async function handleLogoFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const status = el('stLogoStatus');
  status.textContent = 'Memproses gambar...';
  try {
    const dataUrlAsli = await new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Gagal membaca file.')); };
      reader.readAsDataURL(file);
    });
    const img = await new Promise(function (resolve, reject) {
      const im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = function () { reject(new Error('File yang dipilih bukan gambar yang valid.')); };
      im.src = dataUrlAsli;
    });
    // Google Sheets membatasi ±50.000 karakter per sel — perkecil bertahap bila hasil kepanjangan.
    let lebar = 280;
    let hasil = resizeImageToDataUrl_(img, lebar);
    while (hasil.length > 40000 && lebar > 80) {
      lebar = Math.round(lebar * 0.7);
      hasil = resizeImageToDataUrl_(img, lebar);
    }
    if (hasil.length > 40000) {
      status.textContent = '⚠️ Gambar masih terlalu besar/rumit. Coba logo yang lebih sederhana (bentuk datar, bukan foto).';
      return;
    }
    el('stLogoUrl').value = hasil;
    aturStatusLogo(hasil);
    pratinjauStruk();
  } catch (err) {
    status.textContent = '⚠️ ' + err.message;
  }
}

// ---- Editor & pratinjau template struk (gas-struk-resi-printer) ----
function renderPanduanTemplate() {
  const box = el('panduanTemplate');
  if (!box || box.dataset.rendered) return;
  box.dataset.rendered = '1';
  box.innerHTML = '<table style="width:100%;border-collapse:collapse">' +
    Printer.panduanTemplate.map(function (p) {
      return '<tr><td style="padding:3px 8px 3px 0;white-space:nowrap;font-family:monospace;color:#2563eb;vertical-align:top">' + p.kode + '</td>' +
        '<td style="padding:3px 0;color:var(--text-muted)">' + p.ket + '</td></tr>';
    }).join('') + '</table>';
}
function pengaturanDariForm_() {
  return {
    Nama_Toko: el('stNamaToko').value.trim() || 'KasirKu',
    Alamat: el('stAlamat').value.trim(),
    No_Telepon: el('stTelepon').value.trim(),
    Logo_URL: el('stLogoUrl').value.trim(),
    Footer_Struk: el('stFooter').value.trim() || 'Terima kasih atas kunjungan Anda'
  };
}
function pratinjauStruk() {
  try {
    const toko = pengaturanDariForm_();
    const tpl = el('stTemplate').value;
    const kertas = el('stKertas').value;
    el('strukPreview').innerHTML = Printer.renderPreviewHtml(tpl, Printer.contohTrx(), toko, kertas);
    el('strukPreviewWrap').style.display = 'flex';
  } catch (e) {
    showToast('Template tidak valid: ' + e.message, 'danger');
  }
}
function resetTemplateStruk() {
  el('stTemplate').value = Printer.templateDefault;
  pratinjauStruk();
  showToast('Template dikembalikan ke bawaan — klik Simpan Pengaturan untuk menyimpan', 'warning');
}

// ---- Mode Mudah vs Mode Lanjutan ----
function pilihModeTemplate(mode) {
  const mudah = mode === 'mudah';
  el('templateModeMudah').style.display = mudah ? 'block' : 'none';
  el('templateModeLanjutan').style.display = mudah ? 'none' : 'block';
  el('btnModeMudah').classList.toggle('active', mudah);
  el('btnModeLanjutan').classList.toggle('active', !mudah);
  if (mudah) {
    renderStrukBlocks();
  } else {
    renderPanduanTemplate();
    pratinjauStruk();
  }
}

// ---- Struk Builder (Mode Mudah): susun baris struk seperti formulir ----
function escAttr_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function selectHtml_(onchange, options, current) {
  return '<select onchange="' + onchange + '" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:0.8rem">' +
    options.map(function (o) { return '<option value="' + o[0] + '"' + (current === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
    '</select>';
}
function blokRowHtml_(b, i, total) {
  const label = Printer.labelBlok[b.type] || b.type;
  let kontrol = '';
  if (b.type === 'judul_toko' || b.type === 'teks' || b.type === 'footer') {
    kontrol += selectHtml_('ubahBlokField(' + i + ",'align',this.value)", [['L', 'Kiri'], ['C', 'Tengah'], ['R', 'Kanan']], b.align || 'C');
  }
  if (b.type === 'judul_toko' || b.type === 'teks') {
    kontrol += '<label style="display:flex;align-items:center;gap:4px;font-size:0.8rem"><input type="checkbox" style="width:auto"' +
      (b.bold ? ' checked' : '') + ' onchange="ubahBlokField(' + i + ",'bold',this.checked)\"> Tebal</label>";
    kontrol += selectHtml_('ubahBlokField(' + i + ",'size',this.value)", [['normal', 'Normal'], ['besar', 'Besar'], ['sangat_besar', 'Sangat Besar']], b.size || 'normal');
  }
  if (b.type === 'garis') {
    kontrol += selectHtml_('ubahBlokField(' + i + ",'jenis',this.value)", [['putus', 'Putus-putus'], ['tebal', 'Tebal']], b.jenis || 'putus');
  }
  if (b.type === 'info_transaksi') {
    kontrol += [['noStruk', 'No. Struk'], ['tanggal', 'Tanggal'], ['kasir', 'Kasir'], ['metode', 'Metode Bayar']].map(function (p) {
      return '<label style="display:flex;align-items:center;gap:4px;font-size:0.8rem"><input type="checkbox" style="width:auto"' +
        (b[p[0]] ? ' checked' : '') + ' onchange="ubahBlokField(' + i + ",'" + p[0] + "',this.checked)\"> " + p[1] + '</label>';
    }).join('');
  }
  const teksField = b.type === 'teks'
    ? '<input type="text" value="' + escAttr_(b.text) + '" oninput="ubahBlokTeks(' + i + ',this.value)" ' +
      'placeholder="Tulis teks, bisa pakai {{TOKO_NAMA}} {{FOOTER}} dll" style="width:100%;margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:0.85rem">'
    : '';
  return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:#fff">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<strong style="font-size:0.85rem">' + label + '</strong>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + kontrol +
        '<div style="display:flex;gap:4px">' +
          '<button type="button" class="btn-sm btn-sm-outline" onclick="pindahBlok(' + i + ',-1)"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="btn-sm btn-sm-outline" onclick="pindahBlok(' + i + ',1)"' + (i === total - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" class="btn-sm" style="background:#dc2626" onclick="hapusBlok(' + i + ')">✕</button>' +
        '</div>' +
      '</div>' +
    '</div>' + teksField +
  '</div>';
}
function renderStrukBlocks() {
  const list = appState.strukBlocks;
  el('strukBlocks').innerHTML = list.length
    ? list.map(function (b, i) { return blokRowHtml_(b, i, list.length); }).join('')
    : '<p style="font-size:0.85rem;color:var(--text-muted)">Belum ada baris. Tambahkan dari daftar di bawah.</p>';
  sinkronkanTemplateDariBlok();
}
function sinkronkanTemplateDariBlok() {
  el('stTemplate').value = Printer.blocksToTemplate(appState.strukBlocks);
  pratinjauStruk();
}
function ubahBlokField(i, field, value) {
  appState.strukBlocks[i][field] = value;
  renderStrukBlocks();
}
function ubahBlokTeks(i, value) {
  appState.strukBlocks[i].text = value;
  sinkronkanTemplateDariBlok(); // tanpa render ulang daftar, supaya fokus ketik tidak hilang
}
function pindahBlok(i, arah) {
  const arr = appState.strukBlocks;
  const j = i + arah;
  if (j < 0 || j >= arr.length) return;
  const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  renderStrukBlocks();
}
function hapusBlok(i) {
  appState.strukBlocks.splice(i, 1);
  renderStrukBlocks();
}
function tambahBlokStruk() {
  appState.strukBlocks.push(Printer.blokBaru(el('tambahBlokTipe').value));
  renderStrukBlocks();
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
  el('stLogoFile').addEventListener('change', handleLogoFile);

  // Pratinjau struk live (debounced) saat template/field toko diubah
  let _previewTimer = null;
  function jadwalkanPratinjau() { clearTimeout(_previewTimer); _previewTimer = setTimeout(pratinjauStruk, 350); }
  ['stTemplate', 'stNamaToko', 'stAlamat', 'stTelepon', 'stLogoUrl', 'stFooter', 'stKertas'].forEach(function (id) {
    const node = el(id);
    if (node) node.addEventListener('input', jadwalkanPratinjau);
  });
});

async function submitAkunForm(e) {
  e.preventDefault();
  const payload = {
    currentPassword: el('akCurPass').value,
    newNama: el('akNewNama').value.trim(),
    newUsername: el('akNewUser').value.trim(),
    newPassword: el('akNewPass').value
  };
  if (!payload.newNama && !payload.newUsername && !payload.newPassword) {
    showToast('Isi salah satu: nama tampilan, username baru, atau password baru', 'warning');
    return;
  }
  try {
    await api('auth.changeCredentials', payload);
    showToast('Akun diperbarui, silakan login ulang', 'success');
    setTimeout(function () { doLogout(); }, 800);
  } catch (e) { /* toast sudah tampil */ }
}
