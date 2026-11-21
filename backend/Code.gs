/**
 * ============================================================
 *  KasirKu — Backend REST API (Google Apps Script)
 *  Arsitektur: GAS-PRO-API (pure JSON REST, no iframe, no HtmlService)
 * ============================================================
 *  Skill yang diterapkan:
 *  - gas-pro-api            : doGet/doPost JSON murni, CORS text/plain
 *  - gas-rahasia-script-properties : SESSION_SECRET, hash password, token HMAC
 *  - gas-scale-turbo        : CacheX (cache ber-chunk), cache berversi,
 *                             batch read/write, telemetri ms
 *
 *  CARA SETUP:
 *  1. Buat Apps Script project baru → tempel seluruh file ini sebagai Code.gs
 *  2. Jalankan fungsi `setupAppEnvironment` sekali (pilih run → setupAppEnvironment)
 *  3. Izinkan semua permission yang diminta
 *  4. Buka Executions log → catat SPREADSHEET_URL dan password OWNER & KASIR
 *     (hanya ditampilkan SEKALI — segera catat/ganti)
 *  5. Deploy → New deployment → Web app
 *     - Execute as: Me
 *     - Who has access: Anyone
 *  6. Salin URL /exec ke frontend (js/config.js)
 * ============================================================
 */

// ============================================================
// 0. KONFIGURASI DASAR
// ============================================================
const APP_VERSION = '1.0.0';
const APP_NAME = 'KasirKu';

const SHEETS = {
  PRODUK: 'Produk',
  KATEGORI: 'Kategori',
  TRANSAKSI: 'Transaksi',
  DETAIL: 'Detail_Transaksi',
  LOG_STOK: 'Log_Stok',
  PENGATURAN: 'Pengaturan'
};

const CACHE_TTL = {
  PRODUK: 3600,      // 1 jam — master data, jarang berubah
  KATEGORI: 3600,
  PENGATURAN: 3600,
  DASHBOARD: 300      // 5 menit — angka berubah tiap transaksi
};

const SESI_JAM = 12; // umur token sesi

// ============================================================
// 1. SATU PINTU SCRIPT PROPERTIES (gas-rahasia-script-properties)
// ============================================================
const PROPS = PropertiesService.getScriptProperties();
let _PROP_MEMO = null;
function prop_(key, def) {
  if (!_PROP_MEMO) _PROP_MEMO = PROPS.getProperties();
  const v = _PROP_MEMO[key];
  return (v === undefined || v === null || v === '') ? (def === undefined ? '' : def) : v;
}
function setProp_(key, val) {
  PROPS.setProperty(key, String(val));
  if (_PROP_MEMO) _PROP_MEMO[key] = String(val);
}
function setProps_(obj) {
  PROPS.setProperties(obj);
  if (_PROP_MEMO) Object.keys(obj).forEach(function (k) { _PROP_MEMO[k] = String(obj[k]); });
}

// ============================================================
// 2. ACAK KUAT, HASH PASSWORD, PERBANDINGAN AMAN, MASKING
// ============================================================
function acak_(n, huruf) {
  huruf = huruf || 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  while (s.length < n) {
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid())
      .forEach(function (b) { if (s.length < n) s += huruf[(b & 0xff) % huruf.length]; });
  }
  return s;
}
function sandiAcak_(n) {
  const s = acak_(n || 12);
  return (/\d/.test(s) && /[A-Za-z]/.test(s)) ? s : sandiAcak_(n);
}
function hashPass_(pass, salt) {
  let h = String(pass);
  for (let i = 0; i < 300; i++) h = Utilities.base64Encode(Utilities.computeHmacSha256Signature(h + salt, salt));
  return h;
}
function samaAman_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ============================================================
// 3. SESI LOGIN (token HMAC tanpa state server)
// ============================================================
function secret_() {
  let s = prop_('SESSION_SECRET');
  if (!s) { s = acak_(64); setProp_('SESSION_SECRET', s); }
  return s;
}
function hmac_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, secret_())).replace(/=+$/, '');
}
function signToken_(p) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(p)).replace(/=+$/, '');
  return body + '.' + hmac_(body);
}
function buatSesi_(username, role, nama) {
  const now = Date.now();
  return signToken_({ u: username, r: role, n: nama || '', i: now, x: now + SESI_JAM * 3600e3 });
}
function verifyToken_(t) {
  try {
    const parts = String(t || '').split('.');
    if (parts.length !== 2 || !samaAman_(hmac_(parts[0]), parts[1])) return null;
    let b = parts[0]; while (b.length % 4) b += '=';
    const p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(b)).getDataAsString());
    if (!p.x || p.x < Date.now()) return null;
    const rev = Number(prop_('REV_' + p.u) || 0);
    if (p.i < rev) return null; // token dicabut (password diganti / logout paksa)
    return { username: p.u, role: p.r, nama: p.n || '' };
  } catch (e) { return null; }
}
function revokeAll_(username) { setProp_('REV_' + username, String(Date.now())); }

// ============================================================
// 4. CACHEX — CACHE BER-CHUNK (gas-scale-turbo)
// ============================================================
const CacheX = {
  SZ: 50000,
  c: function () { return CacheService.getScriptCache(); },
  get: function (key) {
    try {
      const c = this.c(), head = c.get(key);
      if (head == null) return null;
      if (head.indexOf('__chunks:') !== 0) return JSON.parse(head);
      const n = +head.slice(9), keys = [];
      for (let i = 0; i < n; i++) keys.push(key + '#' + i);
      const parts = c.getAll(keys);
      let s = '';
      for (let i = 0; i < n; i++) { if (parts[keys[i]] == null) return null; s += parts[keys[i]]; }
      return JSON.parse(s);
    } catch (e) { return null; }
  },
  put: function (key, val, ttl) {
    try {
      const s = JSON.stringify(val), c = this.c();
      if (s.length <= this.SZ) { c.put(key, s, ttl); return true; }
      const n = Math.ceil(s.length / this.SZ);
      if (n > 20) return false;
      const m = {};
      for (let i = 0; i < n; i++) m[key + '#' + i] = s.substr(i * this.SZ, this.SZ);
      c.putAll(m, ttl);
      c.put(key, '__chunks:' + n, ttl);
      return true;
    } catch (e) { return false; }
  },
  remove: function (key) { this.c().remove(key); }
};

// ============================================================
// 5. ENTRY POINTS — doGet & doPost (JSON murni)
// ============================================================
function doGet(e) {
  const t0 = Date.now();
  let res;
  try {
    const action = (e && e.parameter && e.parameter.action) || 'ping';
    res = dispatch_(action, e.parameter || {});
  } catch (err) {
    res = fail_(err && err.message ? err.message : String(err));
  }
  res.ms = Date.now() - t0;
  res.v = APP_VERSION;
  return buildResponse_(res);
}

function doPost(e) {
  const t0 = Date.now();
  let res, body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action || '';
    res = dispatch_(action, body);
  } catch (err) {
    res = fail_(err && err.message ? err.message : String(err));
  }
  res.ms = Date.now() - t0;
  res.v = APP_VERSION;
  return buildResponse_(res);
}

function buildResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data, message) { return Object.assign({ success: true, message: message || '' }, { data: data }); }
function fail_(message, extra) { return Object.assign({ success: false, message: message || 'Terjadi kesalahan' }, extra || {}); }

// ============================================================
// 6. ROUTER / DISPATCHER + RBAC
// ============================================================
// roles: 'owner' | 'kasir' | '*' (siapa saja termasuk belum login, mis. auth.login)
const ROUTES = {
  'ping':              { roles: '*',               fn: apiPing_ },
  'auth.login':        { roles: '*',               fn: apiAuthLogin_ },
  'produk.list':       { roles: ['owner', 'kasir'], fn: apiProdukList_ },
  'produk.save':       { roles: ['owner'],          fn: apiProdukSave_ },
  'produk.setStatus':  { roles: ['owner'],          fn: apiProdukSetStatus_ },
  'produk.import':     { roles: ['owner'],          fn: apiProdukImport_ },
  'kategori.list':     { roles: ['owner', 'kasir'], fn: apiKategoriList_ },
  'kategori.save':     { roles: ['owner'],          fn: apiKategoriSave_ },
  'pengaturan.get':    { roles: ['owner', 'kasir'], fn: apiPengaturanGet_ },
  'pengaturan.save':   { roles: ['owner'],          fn: apiPengaturanSave_ },
  'transaksi.checkout':{ roles: ['owner', 'kasir'], fn: apiTransaksiCheckout_ },
  'transaksi.list':    { roles: ['owner', 'kasir'], fn: apiTransaksiList_ },
  'transaksi.void':    { roles: ['owner'],          fn: apiTransaksiVoid_ },
  'dashboard.summary': { roles: ['owner'],          fn: apiDashboardSummary_ }
};

function dispatch_(action, d) {
  const route = ROUTES[action];
  if (!route) return fail_('Aksi tidak dikenal: ' + action);

  let session = null;
  if (route.roles !== '*') {
    session = verifyToken_(d.token);
    if (!session) return fail_('Sesi tidak valid atau sudah habis. Silakan login ulang.', { code: 'AUTH' });
    if (route.roles.indexOf(session.role) === -1) {
      return fail_('Anda tidak memiliki akses untuk aksi ini.', { code: 'FORBIDDEN' });
    }
  }

  // Lock hanya dipakai untuk aksi tulis yang mengubah stok (hindari race condition)
  if (action === 'transaksi.checkout' || action === 'transaksi.void') {
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      return route.fn(session, d);
    } finally {
      lock.releaseLock();
    }
  }
  return route.fn(session, d);
}

function apiPing_() { return ok_({ app: APP_NAME, version: APP_VERSION, time: new Date().toISOString() }); }

// ============================================================
// 7. SPREADSHEET HELPERS
// ============================================================
function ss_() { return SpreadsheetApp.openById(prop_('SPREADSHEET_ID')); }
function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" tidak ditemukan. Jalankan setupAppEnvironment().');
  return sh;
}
function readAll_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return { headers: values[0] || [], rows: [] };
  const headers = values[0];
  const rows = values.slice(1).map(function (row) {
    const obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
  return { headers: headers, rows: rows };
}
function appendRows_(name, rows2D) {
  if (!rows2D.length) return;
  const sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, rows2D.length, rows2D[0].length).setValues(rows2D);
}

// ============================================================
// 8. AUTH
// ============================================================
function apiAuthLogin_(_session, d) {
  const username = String(d.username || '').trim().toLowerCase();
  const password = String(d.password || '');
  if (!username || !password) return fail_('Username dan password wajib diisi.');

  const roles = [
    { key: 'OWNER', role: 'owner' },
    { key: 'KASIR', role: 'kasir' }
  ];

  for (let i = 0; i < roles.length; i++) {
    const r = roles[i];
    const u = prop_(r.key + '_USERNAME');
    const hash = prop_(r.key + '_PASS_HASH');
    const salt = prop_(r.key + '_SALT');
    const nama = prop_(r.key + '_NAMA', r.role === 'owner' ? 'Owner' : 'Kasir');
    if (!u || !hash || !salt) continue;
    if (samaAman_(username, u) && samaAman_(hashPass_(password, salt), hash)) {
      return ok_({ token: buatSesi_(username, r.role, nama), role: r.role, nama: nama }, 'Login berhasil');
    }
  }
  Utilities.sleep(400); // perlambat percobaan brute-force
  return fail_('Username atau password salah.');
}

// ============================================================
// 9. PRODUK (dengan cache)
// ============================================================
function apiProdukList_() {
  const cached = CacheX.get('produk_list');
  if (cached) return ok_(cached);
  const { rows } = readAll_(SHEETS.PRODUK);
  CacheX.put('produk_list', rows, CACHE_TTL.PRODUK);
  return ok_(rows);
}

function apiProdukSave_(_session, d) {
  const p = d.produk || {};
  if (!p.Nama_Produk || p.Harga_Jual === undefined) return fail_('Nama produk dan harga jual wajib diisi.');
  if (Number(p.Harga_Jual) < 0) return fail_('Harga jual tidak boleh negatif.');

  const sh = sheet_(SHEETS.PRODUK);
  const { headers, rows } = readAll_(SHEETS.PRODUK);

  if (p.ID_Produk) {
    // update baris yang sudah ada
    const idx = rows.findIndex(function (r) { return String(r.ID_Produk) === String(p.ID_Produk); });
    if (idx === -1) return fail_('Produk tidak ditemukan.');
    const rowNum = idx + 2; // +1 header, +1 1-indexed
    const existing = rows[idx];
    const merged = Object.assign({}, existing, p);
    const rowValues = headers.map(function (h) { return merged[h] !== undefined ? merged[h] : ''; });
    sh.getRange(rowNum, 1, 1, headers.length).setValues([rowValues]);
  } else {
    // produk baru
    p.ID_Produk = 'P' + Utilities.getUuid().slice(0, 8).toUpperCase();
    if (p.Status_Aktif === undefined) p.Status_Aktif = true;
    if (p.Stok === undefined) p.Stok = 0;
    const rowValues = headers.map(function (h) { return p[h] !== undefined ? p[h] : ''; });
    appendRows_(SHEETS.PRODUK, [rowValues]);
  }

  CacheX.remove('produk_list');
  return ok_(p, 'Produk tersimpan.');
}

function apiProdukSetStatus_(_session, d) {
  const id = d.id, aktif = !!d.aktif;
  const sh = sheet_(SHEETS.PRODUK);
  const { headers, rows } = readAll_(SHEETS.PRODUK);
  const idx = rows.findIndex(function (r) { return String(r.ID_Produk) === String(id); });
  if (idx === -1) return fail_('Produk tidak ditemukan.');
  const col = headers.indexOf('Status_Aktif') + 1;
  sh.getRange(idx + 2, col).setValue(aktif);
  CacheX.remove('produk_list');
  return ok_({ id: id, aktif: aktif }, 'Status produk diperbarui.');
}

/**
 * Import produk massal (mis. dari CSV) — pola upsert idempoten
 * (gas-migrasi-database): kunci alami = Nama_Produk (lowercase, trim).
 * Aman dijalankan berulang: baris yang sama tidak akan dobel.
 * d.rows = [{ Nama_Produk, Kategori, Harga_Beli, Harga_Jual, Stok, Satuan, Barcode }, ...]
 * d.dryRun = true → hanya hitung, tidak menulis apa pun.
 * d.overwrite = true → baris yang sudah ada ikut diperbarui (harga/stok/kategori).
 */
function apiProdukImport_(_session, d) {
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!rows.length) return fail_('Tidak ada baris untuk diimpor.');

  const sh = sheet_(SHEETS.PRODUK);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idxById = {}; // kunci: nama produk lowercase
  for (let r = 1; r < values.length; r++) {
    const nama = String(values[r][headers.indexOf('Nama_Produk')] || '').trim().toLowerCase();
    if (nama) idxById[nama] = r; // index baris di `values`
  }

  const report = { inserted: 0, updated: 0, skipped: 0 };
  const updatableFields = ['Kategori', 'Harga_Beli', 'Harga_Jual', 'Stok', 'Satuan', 'Barcode'];
  const newRows = [];
  const seen = {};

  rows.forEach(function (src) {
    const key = String(src.Nama_Produk || '').trim().toLowerCase();
    if (!key || seen[key]) { report.skipped++; return; }
    seen[key] = true;

    if (idxById[key] !== undefined) {
      if (!d.overwrite) { report.skipped++; return; }
      const r = idxById[key];
      updatableFields.forEach(function (f) {
        const col = headers.indexOf(f);
        if (col > -1 && src[f] !== undefined && src[f] !== '') values[r][col] = src[f];
      });
      report.updated++;
    } else {
      const produkBaru = Object.assign({
        ID_Produk: 'P' + Utilities.getUuid().slice(0, 8).toUpperCase(),
        Status_Aktif: true,
        Stok: 0,
        Satuan: 'pcs'
      }, src);
      newRows.push(headers.map(function (h) { return produkBaru[h] !== undefined ? produkBaru[h] : ''; }));
      report.inserted++;
    }
  });

  if (!d.dryRun && (report.updated || newRows.length)) {
    // tulis ulang baris yang diperbarui (batch, satu kali setValues untuk seluruh rentang data lama)
    if (values.length > 1) sh.getRange(2, 1, values.length - 1, headers.length).setValues(values.slice(1));
    // tambahkan baris baru (batch, satu kali setValues)
    if (newRows.length) appendRows_(SHEETS.PRODUK, newRows);
    CacheX.remove('produk_list');
  }

  return ok_(report, d.dryRun
    ? 'Pratinjau: ' + report.inserted + ' baru, ' + report.updated + ' diperbarui, ' + report.skipped + ' dilewati.'
    : 'Import selesai: ' + report.inserted + ' produk baru ditambahkan' + (d.overwrite ? ', ' + report.updated + ' diperbarui.' : '.'));
}

// ============================================================
// 10. KATEGORI (cache)
// ============================================================
function apiKategoriList_() {
  const cached = CacheX.get('kategori_list');
  if (cached) return ok_(cached);
  const { rows } = readAll_(SHEETS.KATEGORI);
  CacheX.put('kategori_list', rows, CACHE_TTL.KATEGORI);
  return ok_(rows);
}
function apiKategoriSave_(_session, d) {
  const nama = String((d.kategori || {}).Nama_Kategori || '').trim();
  if (!nama) return fail_('Nama kategori wajib diisi.');
  const id = 'K' + Utilities.getUuid().slice(0, 6).toUpperCase();
  appendRows_(SHEETS.KATEGORI, [[id, nama]]);
  CacheX.remove('kategori_list');
  return ok_({ ID_Kategori: id, Nama_Kategori: nama }, 'Kategori ditambahkan.');
}

// ============================================================
// 11. PENGATURAN TOKO (cache, satu baris)
// ============================================================
function apiPengaturanGet_() {
  const cached = CacheX.get('pengaturan');
  if (cached) return ok_(cached);
  const { rows } = readAll_(SHEETS.PENGATURAN);
  const data = rows[0] || { Nama_Toko: APP_NAME, Alamat: '', No_Telepon: '', Logo_URL: '', Footer_Struk: 'Terima kasih atas kunjungan Anda' };
  CacheX.put('pengaturan', data, CACHE_TTL.PENGATURAN);
  return ok_(data);
}
function apiPengaturanSave_(_session, d) {
  const p = d.pengaturan || {};
  const sh = sheet_(SHEETS.PENGATURAN);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowValues = headers.map(function (h) { return p[h] !== undefined ? p[h] : ''; });
  if (sh.getLastRow() < 2) {
    sh.getRange(2, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sh.getRange(2, 1, 1, headers.length).setValues([rowValues]);
  }
  CacheX.remove('pengaturan');
  return ok_(p, 'Pengaturan toko disimpan.');
}

// ============================================================
// 12. TRANSAKSI — CHECKOUT (batch composite, Prinsip 4 gas-instant-ux)
// ============================================================
function apiTransaksiCheckout_(session, d) {
  const items = d.items || []; // [{ID_Produk, Nama_Produk, Qty, Harga_Satuan}]
  if (!items.length) return fail_('Keranjang kosong.');

  const produkSheet = sheet_(SHEETS.PRODUK);
  const { headers: ph, rows: produkRows } = readAll_(SHEETS.PRODUK);
  const stokCol = ph.indexOf('Stok') + 1;
  const idCol = ph.indexOf('ID_Produk');

  // 1. Validasi stok & siapkan update
  const produkIndexById = {};
  produkRows.forEach(function (r, i) { produkIndexById[String(r.ID_Produk)] = i; });

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const idx = produkIndexById[String(it.ID_Produk)];
    if (idx === undefined) return fail_('Produk "' + it.Nama_Produk + '" tidak ditemukan.');
    const stokSaatIni = Number(produkRows[idx].Stok || 0);
    if (stokSaatIni < Number(it.Qty)) {
      return fail_('Stok "' + it.Nama_Produk + '" tidak cukup (sisa ' + stokSaatIni + ').');
    }
  }

  // 2. Hitung total
  let subtotal = 0;
  items.forEach(function (it) { subtotal += Number(it.Qty) * Number(it.Harga_Satuan); });
  const diskon = Number(d.diskon || 0);
  const totalBayar = Math.max(0, subtotal - diskon);
  const totalItem = items.reduce(function (s, it) { return s + Number(it.Qty); }, 0);

  const idTransaksi = 'TRX' + Utilities.getUuid().slice(0, 10).toUpperCase();
  const now = new Date();

  // 3. Simpan header transaksi
  appendRows_(SHEETS.TRANSAKSI, [[
    idTransaksi, now, session.nama || session.username, totalItem, subtotal, diskon, totalBayar,
    d.metodeBayar || 'Tunai', 'Selesai'
  ]]);

  // 4. Simpan detail transaksi (batch — satu kali setValues)
  const detailRows = items.map(function (it) {
    return [idTransaksi, it.ID_Produk, it.Nama_Produk, it.Qty, it.Harga_Satuan, Number(it.Qty) * Number(it.Harga_Satuan)];
  });
  appendRows_(SHEETS.DETAIL, detailRows);

  // 5. Update stok produk (batch — satu kali setValues untuk seluruh rentang baris produk)
  let minRow = Infinity, maxRow = -1;
  items.forEach(function (it) {
    const idx = produkIndexById[String(it.ID_Produk)];
    produkRows[idx].Stok = Number(produkRows[idx].Stok || 0) - Number(it.Qty);
    minRow = Math.min(minRow, idx);
    maxRow = Math.max(maxRow, idx);
  });
  if (maxRow > -1) {
    const blockValues = [];
    for (let i = minRow; i <= maxRow; i++) {
      blockValues.push(ph.map(function (h) { return produkRows[i][h] !== undefined ? produkRows[i][h] : ''; }));
    }
    produkSheet.getRange(minRow + 2, 1, blockValues.length, ph.length).setValues(blockValues);
  }

  // 6. Catat Log_Stok (batch)
  const logRows = items.map(function (it) {
    return [now, it.ID_Produk, 'Keluar', it.Qty, 'Transaksi ' + idTransaksi];
  });
  appendRows_(SHEETS.LOG_STOK, logRows);

  // 7. Invalidasi cache yang terpengaruh
  CacheX.remove('produk_list');
  CacheX.remove('dashboard_summary');

  return ok_({
    ID_Transaksi: idTransaksi,
    Tanggal_Waktu: now.toISOString(),
    Items: items,
    Subtotal: subtotal,
    Diskon: diskon,
    Total_Bayar: totalBayar,
    Kasir: session.nama || session.username
  }, 'Transaksi berhasil disimpan.');
}

function apiTransaksiList_(_session, d) {
  const { rows } = readAll_(SHEETS.TRANSAKSI);
  let list = rows;
  if (d.tanggal) {
    const target = String(d.tanggal);
    list = list.filter(function (r) {
      const t = r.Tanggal_Waktu instanceof Date ? r.Tanggal_Waktu : new Date(r.Tanggal_Waktu);
      return Utilities.formatDate(t, Session.getScriptTimeZone(), 'yyyy-MM-dd') === target;
    });
  }
  if (d.cari) {
    const q = String(d.cari).toLowerCase();
    list = list.filter(function (r) { return String(r.ID_Transaksi).toLowerCase().indexOf(q) > -1; });
  }
  list = list.slice().reverse().slice(0, 200); // batasi 200 transaksi terbaru untuk kecepatan
  return ok_(list);
}

function apiTransaksiVoid_(_session, d) {
  const id = d.id;
  const sh = sheet_(SHEETS.TRANSAKSI);
  const { headers, rows } = readAll_(SHEETS.TRANSAKSI);
  const idx = rows.findIndex(function (r) { return String(r.ID_Transaksi) === String(id); });
  if (idx === -1) return fail_('Transaksi tidak ditemukan.');
  if (rows[idx].Status === 'Dibatalkan') return fail_('Transaksi sudah dibatalkan sebelumnya.');

  const statusCol = headers.indexOf('Status') + 1;
  sh.getRange(idx + 2, statusCol).setValue('Dibatalkan');

  // Kembalikan stok berdasarkan Detail_Transaksi
  const { rows: details } = readAll_(SHEETS.DETAIL);
  const relevan = details.filter(function (r) { return String(r.ID_Transaksi) === String(id); });

  if (relevan.length) {
    const produkSheet = sheet_(SHEETS.PRODUK);
    const { headers: ph, rows: produkRows } = readAll_(SHEETS.PRODUK);
    const idxById = {};
    produkRows.forEach(function (r, i) { idxById[String(r.ID_Produk)] = i; });

    let minRow = Infinity, maxRow = -1;
    relevan.forEach(function (it) {
      const idx2 = idxById[String(it.ID_Produk)];
      if (idx2 === undefined) return;
      produkRows[idx2].Stok = Number(produkRows[idx2].Stok || 0) + Number(it.Qty);
      minRow = Math.min(minRow, idx2);
      maxRow = Math.max(maxRow, idx2);
    });
    if (maxRow > -1) {
      const blockValues = [];
      for (let i = minRow; i <= maxRow; i++) {
        blockValues.push(ph.map(function (h) { return produkRows[i][h] !== undefined ? produkRows[i][h] : ''; }));
      }
      produkSheet.getRange(minRow + 2, 1, blockValues.length, ph.length).setValues(blockValues);
    }

    const logRows = relevan.map(function (it) {
      return [new Date(), it.ID_Produk, 'Masuk', it.Qty, 'Void transaksi ' + id];
    });
    appendRows_(SHEETS.LOG_STOK, logRows);
  }

  CacheX.remove('produk_list');
  CacheX.remove('dashboard_summary');
  return ok_({ id: id }, 'Transaksi dibatalkan dan stok dikembalikan.');
}

// ============================================================
// 13. DASHBOARD RINGKASAN (cache 5 menit)
// ============================================================
function apiDashboardSummary_() {
  const cached = CacheX.get('dashboard_summary');
  if (cached) return ok_(cached);

  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const thisMonth = Utilities.formatDate(new Date(), tz, 'yyyy-MM');

  const { rows: trx } = readAll_(SHEETS.TRANSAKSI);
  const valid = trx.filter(function (r) { return r.Status !== 'Dibatalkan'; });

  let omzetHari = 0, trxHari = 0, omzetBulan = 0;
  valid.forEach(function (r) {
    const t = r.Tanggal_Waktu instanceof Date ? r.Tanggal_Waktu : new Date(r.Tanggal_Waktu);
    const tgl = Utilities.formatDate(t, tz, 'yyyy-MM-dd');
    const bln = Utilities.formatDate(t, tz, 'yyyy-MM');
    if (tgl === today) { omzetHari += Number(r.Total_Bayar || 0); trxHari++; }
    if (bln === thisMonth) omzetBulan += Number(r.Total_Bayar || 0);
  });

  // Produk terlaris (dari Detail_Transaksi)
  const { rows: details } = readAll_(SHEETS.DETAIL);
  const qtyByProduk = {};
  details.forEach(function (r) {
    qtyByProduk[r.Nama_Produk] = (qtyByProduk[r.Nama_Produk] || 0) + Number(r.Qty || 0);
  });
  const terlaris = Object.keys(qtyByProduk)
    .map(function (nama) { return { nama: nama, qty: qtyByProduk[nama] }; })
    .sort(function (a, b) { return b.qty - a.qty; })
    .slice(0, 5);

  const data = { omzetHari: omzetHari, trxHari: trxHari, omzetBulan: omzetBulan, produkTerlaris: terlaris };
  CacheX.put('dashboard_summary', data, CACHE_TTL.DASHBOARD);
  return ok_(data);
}

// ============================================================
// 14. SETUP OTOMATIS — jalankan SEKALI dari editor Apps Script
// ============================================================
function setupAppEnvironment() {
  Logger.log('🚀 Memulai setup ' + APP_NAME + '...');

  // 1. Spreadsheet (idempoten — pakai yang sudah ada bila SPREADSHEET_ID sudah tersimpan)
  let ss;
  const existingId = prop_('SPREADSHEET_ID');
  if (existingId) {
    try { ss = SpreadsheetApp.openById(existingId); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('🗃️ Database — ' + APP_NAME);
    setProp_('SPREADSHEET_ID', ss.getId());
  }

  // 2. Buat sheet + header sesuai skema PRD (tidak menimpa data yang sudah ada)
  const schema = {
    Produk: ['ID_Produk', 'Nama_Produk', 'Kategori', 'Harga_Beli', 'Harga_Jual', 'Stok', 'Satuan', 'Barcode', 'Status_Aktif'],
    Kategori: ['ID_Kategori', 'Nama_Kategori'],
    Transaksi: ['ID_Transaksi', 'Tanggal_Waktu', 'Kasir', 'Total_Item', 'Subtotal', 'Diskon', 'Total_Bayar', 'Metode_Bayar', 'Status'],
    Detail_Transaksi: ['ID_Transaksi', 'ID_Produk', 'Nama_Produk', 'Qty', 'Harga_Satuan', 'Subtotal_Item'],
    Log_Stok: ['Tanggal', 'ID_Produk', 'Jenis_Perubahan', 'Jumlah', 'Keterangan'],
    Pengaturan: ['Nama_Toko', 'Alamat', 'No_Telepon', 'Logo_URL', 'Footer_Struk']
  };

  Object.keys(schema).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(schema[name]);
  });

  // Hapus sheet default "Sheet1" bila masih ada dan kosong
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);

  // 3. Baris default Pengaturan (hanya jika masih kosong)
  const pengaturanSheet = ss.getSheetByName('Pengaturan');
  if (pengaturanSheet.getLastRow() < 2) {
    pengaturanSheet.appendRow([APP_NAME, '', '', '', 'Terima kasih atas kunjungan Anda']);
  }

  // 4. Kategori contoh (hanya jika masih kosong)
  const katSheet = ss.getSheetByName('Kategori');
  if (katSheet.getLastRow() < 2) {
    katSheet.appendRow(['K000001', 'Umum']);
  }

  // 5. Rahasia & akun (dibangkitkan sekali, TIDAK pernah ditimpa bila sudah ada)
  secret_(); // SESSION_SECRET

  if (!prop_('OWNER_PASS_HASH')) {
    const passOwner = sandiAcak_(10);
    const saltOwner = Utilities.getUuid();
    setProps_({
      OWNER_USERNAME: 'owner',
      OWNER_NAMA: 'Owner',
      OWNER_SALT: saltOwner,
      OWNER_PASS_HASH: hashPass_(passOwner, saltOwner)
    });
    Logger.log('🔐 AKUN OWNER (catat sekarang, hanya tampil sekali):');
    Logger.log('   Username : owner');
    Logger.log('   Password : ' + passOwner);
  }

  if (!prop_('KASIR_PASS_HASH')) {
    const passKasir = sandiAcak_(10);
    const saltKasir = Utilities.getUuid();
    setProps_({
      KASIR_USERNAME: 'kasir',
      KASIR_NAMA: 'Kasir',
      KASIR_SALT: saltKasir,
      KASIR_PASS_HASH: hashPass_(passKasir, saltKasir)
    });
    Logger.log('🔐 AKUN KASIR (catat sekarang, hanya tampil sekali):');
    Logger.log('   Username : kasir');
    Logger.log('   Password : ' + passKasir);
  }

  Logger.log('✅ Setup selesai!');
  Logger.log('📊 Spreadsheet: ' + ss.getUrl());
  Logger.log('➡️  Selanjutnya: Deploy → New deployment → Web app (Execute as: Me, Access: Anyone)');
}

/**
 * Jalankan manual dari editor bila lupa password Owner/Kasir.
 * Mencabut sesi lama akun tersebut (paksa login ulang).
 */
function resetPassword(role, newPassword) {
  role = String(role || '').toUpperCase(); // 'OWNER' atau 'KASIR'
  if (role !== 'OWNER' && role !== 'KASIR') throw new Error('role harus OWNER atau KASIR');
  const pass = newPassword || sandiAcak_(10);
  const salt = Utilities.getUuid();
  setProps_({});
  setProp_(role + '_SALT', salt);
  setProp_(role + '_PASS_HASH', hashPass_(pass, salt));
  revokeAll_(prop_(role + '_USERNAME'));
  Logger.log('🔐 Password ' + role + ' baru: ' + pass);
}

/** Rotasi SESSION_SECRET — memaksa SEMUA sesi login berakhir. */
function rotasiSecretSesi() {
  setProp_('SESSION_SECRET', acak_(64));
  Logger.log('✅ SESSION_SECRET dirotasi — semua sesi berakhir, semua harus login ulang.');
}
