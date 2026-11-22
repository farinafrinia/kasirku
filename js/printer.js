// ============================================================
// KasirKu — Modul Cetak Struk Thermal (Web Bluetooth ESC/POS)
// Mendukung printer thermal 58mm & 80mm yang kompatibel ESC/POS
// via Bluetooth Low Energy (BLE). Fallback: dialog print browser.
// ============================================================

const Printer = (function () {
  let device = null;
  let characteristic = null;

  // UUID umum dipakai printer thermal BLE (Serial Port Profile / umum vendor China)
  const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
  const CHAR_UUID = '00002af1-0000-1000-8000-00805f9b34fb';

  function isSupported() {
    return 'bluetooth' in navigator;
  }

  async function connect() {
    if (!isSupported()) throw new Error('Browser ini tidak mendukung Web Bluetooth. Gunakan Chrome di Android.');
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID]
    }).catch(async () => {
      // fallback: terima semua device bila service tidak cocok persis (banyak printer generik)
      return navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID]
      });
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    characteristic = await service.getCharacteristic(CHAR_UUID);
    localStorage.setItem('kasirku_printer_name', device.name || 'Printer');
    return device.name;
  }

  function isConnected() {
    return !!(device && device.gatt && device.gatt.connected);
  }

  async function writeBytes(bytes) {
    if (!isConnected()) await connect();
    // Kirim per potongan kecil (beberapa printer BLE membatasi ukuran paket ~ 100-180 byte)
    const CHUNK = 100;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      await characteristic.writeValue(new Uint8Array(chunk));
      await new Promise(function (r) { setTimeout(r, 30); });
    }
  }

  // ---- Builder perintah ESC/POS sederhana ----
  const ESC = 0x1b, GS = 0x1d;
  function textToBytes(str) {
    return Array.from(new TextEncoder().encode(str));
  }
  function cmdInit() { return [ESC, 0x40]; }
  function cmdAlign(a) { return [ESC, 0x61, a]; } // 0 kiri, 1 tengah, 2 kanan
  function cmdBold(on) { return [ESC, 0x45, on ? 1 : 0]; }
  function cmdSize(w, h) { return [GS, 0x21, (w << 4) | h]; } // 0 normal, 1 2x
  function cmdFeed(n) { return [ESC, 0x64, n]; }
  function cmdCut() { return [GS, 0x56, 1]; }
  function line(width) { return textToBytes('='.repeat(width) + '\n'); }
  function thinLine(width) { return textToBytes('-'.repeat(width) + '\n'); }

  // ---- Logo: ubah gambar menjadi raster ESC/POS (GS v 0) ----
  function loadImageEl(url) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Gambar logo gagal dimuat')); };
      img.src = url;
    });
  }
  async function imageToRaster(url, widthPx) {
    const img = await loadImageEl(url);
    const scale = widthPx / img.naturalWidth;
    const w = widthPx, h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    let data;
    try { data = ctx.getImageData(0, 0, w, h).data; }
    catch (e) { throw new Error('Logo tidak bisa dibaca (CORS). Gunakan URL gambar yang mengizinkan akses lintas origin.'); }
    const widthBytes = Math.ceil(w / 8);
    const bytes = [];
    for (let y = 0; y < h; y++) {
      for (let xB = 0; xB < widthBytes; xB++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = xB * 8 + bit;
          let on = 0;
          if (x < w) {
            const idx = (y * w + x) * 4;
            const gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            const alpha = data[idx + 3];
            on = (alpha > 80 && gray < 160) ? 1 : 0;
          }
          byte |= on << (7 - bit);
        }
        bytes.push(byte);
      }
    }
    return { widthBytes: widthBytes, height: h, bytes: bytes };
  }
  function cmdRaster(raster) {
    const xL = raster.widthBytes & 0xff, xH = (raster.widthBytes >> 8) & 0xff;
    const yL = raster.height & 0xff, yH = (raster.height >> 8) & 0xff;
    return [GS, 0x76, 0x30, 0, xL, xH, yL, yH].concat(raster.bytes);
  }

  // ---- QR Code: perintah bawaan firmware printer (GS ( k) ----
  function cmdQr(data, moduleSize) {
    const bytes = textToBytes(data);
    const storeLen = bytes.length + 3;
    const pL = storeLen & 0xff, pH = (storeLen >> 8) & 0xff;
    let cmds = [];
    cmds = cmds.concat([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);           // model 2
    cmds = cmds.concat([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize || 5]);        // ukuran modul
    cmds = cmds.concat([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]);                  // koreksi error: M
    cmds = cmds.concat([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30], bytes);                // simpan data
    cmds = cmds.concat([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);                  // cetak
    return cmds;
  }

  function rupiah(n) {
    return 'Rp' + Number(n || 0).toLocaleString('id-ID');
  }
  function cmdReverse(on) { return [GS, 0x42, on ? 1 : 0]; } // GS B n — mode cetak terbalik (putih di atas hitam), dipakai untuk [BOX]

  // ============================================================
  // MESIN TEMPLATE STRUK — bahasa direktif teks, bisa diubah Owner
  // sendiri tanpa menyentuh kode. Lihat Printer.templateDefault &
  // Printer.panduanTemplate untuk daftar lengkap direktif/variabel.
  // ============================================================
  // ---- Mode Mudah = "Struk Builder": susun baris seperti formulir ----
  // Setiap baris adalah satu "blok" bertipe tertentu (teks, garis, logo, dst)
  // dengan properti gaya sendiri (rata, tebal, ukuran). Blok bisa ditambah,
  // dihapus, dan diurutkan ulang — hasilnya dirangkai jadi template direktif
  // yang sama persis dipakai mesin cetak, sehingga satu mesin render untuk
  // Mode Mudah maupun Mode Lanjutan.
  const LABEL_BLOK = {
    logo: 'Logo Toko', judul_toko: 'Nama Toko', alamat_toko: 'Alamat Toko', telepon_toko: 'No. Telepon Toko',
    teks: 'Teks Bebas', garis: 'Garis Pembatas', spasi: 'Spasi Kosong',
    info_transaksi: 'Info Transaksi', daftar_item: 'Daftar Barang', ringkasan_total: 'Subtotal & Total',
    footer: 'Footer', qr: 'QR Code'
  };
  function blokBaru(type) {
    const b = { type: type };
    if (type === 'judul_toko') { b.align = 'C'; b.bold = true; b.size = 'sangat_besar'; }
    if (type === 'teks') { b.align = 'C'; b.bold = false; b.size = 'normal'; b.boxed = false; b.text = 'Tulis teks di sini'; }
    if (type === 'footer') { b.align = 'C'; }
    if (type === 'garis') { b.jenis = 'putus'; }
    // Catatan: "Metode Bayar" sengaja TIDAK ada di info_transaksi (atas) — sesuai
    // permintaan pengguna, baris Bayar ditaruh di bawah, menyatu dengan
    // ringkasan_total (dekat TOTAL), bukan di dekat No. Struk/Tanggal/Kasir.
    if (type === 'info_transaksi') { b.noStruk = true; b.tanggal = true; b.kasir = true; }
    if (type === 'daftar_item') { b.headerKolom = false; }
    if (type === 'ringkasan_total') { b.totalBoxed = false; b.metode = true; b.bayarTunai = true; }
    return b;
  }
  function blokDefault() {
    return [
      blokBaru('logo'),
      blokBaru('judul_toko'),
      { type: 'alamat_toko' },
      { type: 'telepon_toko' },
      { type: 'garis', jenis: 'tebal' },
      blokBaru('info_transaksi'),
      { type: 'garis', jenis: 'putus' },
      { type: 'daftar_item' },
      { type: 'garis', jenis: 'putus' },
      blokBaru('ringkasan_total'),
      { type: 'garis', jenis: 'tebal' },
      blokBaru('footer'),
      { type: 'qr' }
    ];
  }
  // ---- 9 template siap pakai (3 Cafe/Resto, 3 Toko/Minimarket, 3 Laundry) ----
  // Dibangun dari blok yang sama persis dipakai Struk Builder, supaya bisa
  // langsung "dipakai" (load ke Builder) atau dipilih langsung saat cetak.
  function templatePresetDefault() {
    const T = function (text, opt) { return Object.assign({ type: 'teks', align: 'C', bold: false, size: 'normal', boxed: false, text: text }, opt || {}); };
    const G = function (jenis) { return { type: 'garis', jenis: jenis }; };
    const INFO = function (opt) { return Object.assign({ type: 'info_transaksi', noStruk: true, tanggal: true, kasir: true }, opt || {}); };
    const JUDUL = function (opt) { return Object.assign({ type: 'judul_toko', align: 'C', bold: true, size: 'sangat_besar', boxed: false }, opt || {}); };
    const ALAMAT = { type: 'alamat_toko' }, TELP = { type: 'telepon_toko' }, LOGO = { type: 'logo' }, QR = { type: 'qr' }, ITEM = { type: 'daftar_item' };
    const ITEM_HDR = { type: 'daftar_item', headerKolom: true };
    const TOTAL = function (opt) { return Object.assign({ type: 'ringkasan_total', totalBoxed: false, metode: true, bayarTunai: true }, opt || {}); };
    const FOOTER = function (opt) { return Object.assign({ type: 'footer', align: 'C' }, opt || {}); };

    return [
      // ---- CAFE / RESTO ----
      {
        id: 'cafe1', nama: 'Cafe Modern', kategori: 'cafe', blocks: [
          LOGO, JUDUL(), ALAMAT, TELP, G('tebal'), INFO(), G('putus'), ITEM, G('putus'), TOTAL(), G('tebal'),
          T('Semua pesanan tidak dapat dibatalkan setelah 15 menit.', { size: 'normal' }),
          FOOTER(), QR
        ]
      },
      {
        id: 'cafe2', nama: 'Cafe Minimalis', kategori: 'cafe', blocks: [
          JUDUL({ align: 'L', size: 'besar' }),
          INFO({ noStruk: false, metode: false }),
          G('putus'), ITEM, G('putus'), TOTAL(), FOOTER({ align: 'L' })
        ]
      },
      {
        id: 'cafe3', nama: 'Resto Elegan', kategori: 'cafe', blocks: [
          LOGO, JUDUL(), ALAMAT, TELP, G('tebal'), INFO(), G('putus'), ITEM, G('putus'),
          TOTAL({ totalBoxed: true }), G('tebal'),
          T('Terima kasih telah berkunjung, sampai jumpa lagi!'),
          FOOTER(), QR
        ]
      },
      // 3 template tambahan berikut meniru TATA LETAK dari contoh struk nyata yang
      // dikirim pengguna (bukan logo/merek — hanya susunan & gaya baris-barisnya).
      {
        id: 'cafe4', nama: 'Resto Kolom Lengkap (Subtotal, Pajak, Total Besar)', kategori: 'cafe', blocks: [
          JUDUL({ size: 'besar' }), ALAMAT, TELP, G('tebal'), INFO(), G('putus'),
          ITEM_HDR, G('putus'), TOTAL({ totalBoxed: true, metode: false }),
          FOOTER()
        ]
      },
      {
        id: 'cafe5', nama: 'Kasir POS Modern (Struk Kertas Kasir)', kategori: 'cafe', blocks: [
          LOGO, JUDUL(), ALAMAT, TELP,
          T('RECEIPT', { bold: true }), G('putus'), INFO(), G('putus'),
          ITEM_HDR, G('putus'), TOTAL({ totalBoxed: true }), G('tebal'), FOOTER(), QR
        ]
      },
      {
        id: 'cafe6', nama: 'Kedai Minuman Kekinian (Nomor Order Besar)', kategori: 'cafe', blocks: [
          LOGO, T('ORDER NO: {{NOTA}}', { bold: true, size: 'sangat_besar' }), G('putus'),
          INFO({ noStruk: false }), G('putus'), ITEM, G('putus'), TOTAL({ totalBoxed: true }), G('tebal'),
          T('Terima kasih, sampai jumpa lagi! 💛'),
          FOOTER(), QR
        ]
      },
      // ---- TOKO SEMBAKO / MINIMARKET ----
      {
        id: 'toko1', nama: 'Minimarket Ringkas', kategori: 'toko', blocks: [
          JUDUL({ size: 'besar' }), G('putus'), INFO({ kasir: false, metode: false }), G('putus'), ITEM, G('putus'), TOTAL(),
          T('Barang yang sudah dibeli tidak dapat dikembalikan.', { size: 'normal' })
        ]
      },
      {
        id: 'toko2', nama: 'Toko Sembako Lengkap', kategori: 'toko', blocks: [
          LOGO, JUDUL(), ALAMAT, TELP, G('tebal'), INFO(), G('putus'), ITEM, G('putus'), TOTAL(), G('tebal'), FOOTER(), QR
        ]
      },
      {
        id: 'toko3', nama: 'Mini Market Promo', kategori: 'toko', blocks: [
          JUDUL(), T('~ PROMO HARI INI ~', { bold: true, boxed: true }), ALAMAT, G('putus'), INFO(), G('putus'), ITEM, G('putus'), TOTAL(), G('tebal'),
          T('Follow IG kami untuk info promo terbaru!'),
          FOOTER(), QR
        ]
      },
      // ---- LAUNDRY ----
      {
        id: 'laundry1', nama: 'Laundry Simpel', kategori: 'laundry', blocks: [
          JUDUL({ size: 'besar' }), ALAMAT, TELP, G('putus'), INFO({ metode: false }),
          G('putus'), ITEM, G('putus'), TOTAL(),
          T('Estimasi selesai: 2-3 hari kerja', { size: 'normal' }),
          FOOTER()
        ]
      },
      {
        id: 'laundry2', nama: 'Laundry Express', kategori: 'laundry', blocks: [
          LOGO, JUDUL(),
          T('⚡ LAYANAN EXPRESS 6 JAM ⚡', { bold: true, boxed: true }),
          G('tebal'), INFO(), G('putus'), ITEM, G('putus'), TOTAL({ totalBoxed: true }), G('tebal'), FOOTER(), QR
        ]
      },
      {
        id: 'laundry3', nama: 'Laundry Lengkap (+ Nota Pengambilan)', kategori: 'laundry', blocks: [
          LOGO, JUDUL(), ALAMAT, TELP, G('tebal'), INFO(), G('putus'), ITEM, G('putus'), TOTAL(), G('putus'),
          T('Harap simpan struk ini sebagai bukti pengambilan.', { bold: true }),
          T('Cucian hilang akibat struk tidak dibawa bukan tanggung jawab kami.', { size: 'normal' }),
          FOOTER(), QR
        ]
      }
    ];
  }
  const LABEL_KATEGORI = { custom: 'Template Saya', cafe: 'Cafe / Resto', toko: 'Toko / Minimarket', laundry: 'Laundry' };
  // Gabungkan: template tersimpan milik toko (JSON dari Pengaturan) + 9 preset bawaan.
  function daftarLibrary(pengaturan) {
    let simpanan = [];
    try { simpanan = JSON.parse((pengaturan && pengaturan.Template_Library) || '[]'); } catch (e) { simpanan = []; }
    if (!Array.isArray(simpanan)) simpanan = [];
    return simpanan.concat(templatePresetDefault());
  }
  // Ambil teks template siap-cetak untuk satu id pilihan. '__aktif__' = pakai
  // Template_Struk yang sedang dikonfigurasi di Pengaturan (default/lama).
  function templateUntukId(pengaturan, id) {
    if (!id || id === '__aktif__') return pengaturan.Template_Struk || TEMPLATE_DEFAULT;
    const semua = daftarLibrary(pengaturan);
    const found = semua.find(function (t) { return t.id === id; });
    return found ? blocksToTemplate(found.blocks) : (pengaturan.Template_Struk || TEMPLATE_DEFAULT);
  }

  function tagGaya_(b) {
    let t = (b.align === 'C' ? '[C]' : b.align === 'R' ? '[R]' : b.align === 'L' ? '[L]' : '');
    if (b.bold) t += '[B]';
    if (b.size === 'besar') t += '[H]'; else if (b.size === 'sangat_besar') t += '[2]';
    if (b.boxed) t += '[BOX]';
    return t;
  }
  function blokKeBaris_(b) {
    switch (b.type) {
      case 'logo': return ['[LOGO]'];
      case 'judul_toko': return [tagGaya_(b) + '{{TOKO_NAMA}}'];
      case 'alamat_toko': return ['{{?TOKO_ALAMAT}}[C]{{TOKO_ALAMAT}}', '{{/TOKO_ALAMAT}}'];
      case 'telepon_toko': return ['{{?TOKO_WA}}[C]{{TOKO_WA}}', '{{/TOKO_WA}}'];
      case 'teks': return b.text ? [tagGaya_(b) + b.text] : [];
      case 'garis': return [b.jenis === 'tebal' ? '[=]' : '[-]'];
      case 'spasi': return ['[FEED]'];
      case 'info_transaksi': {
        const baris = [];
        if (b.noStruk) baris.push('No. Struk : {{NOTA}}');
        if (b.tanggal) baris.push('Tanggal   : {{TANGGAL|tgl}} {{JAM}}');
        if (b.kasir) baris.push('Kasir     : {{KASIR}}');
        return baris;
      }
      case 'daftar_item': {
        const baris = [];
        if (b.headerKolom) baris.push('[LR]Nama Barang||Jumlah', '[-]');
        baris.push('{{#ITEM}}', '{{NAMA}}', '[LR]{{QTY}} x {{HARGA|rp}}||{{SUB|rp}}', '{{/ITEM}}');
        return baris;
      }
      case 'ringkasan_total': {
        const baris = ['[LR]Subtotal||{{SUBTOTAL|rp}}', '{{?DISKON}}[LR]Diskon||-{{DISKON|rp}}', '{{/DISKON}}',
          '{{?PAJAK}}[LR]Pajak||{{PAJAK|rp}}', '{{/PAJAK}}',
          '[B][H]' + (b.totalBoxed ? '[BOX]' : '') + '[LR]TOTAL||{{TOTAL|rp}}'];
        // Baris Bayar/Tunai/Kembalian ditaruh DI BAWAH, setelah TOTAL — bukan di atas dekat No. Struk.
        if (b.metode) baris.push('[LR]Metode Bayar||{{METODE}}');
        if (b.bayarTunai) baris.push('{{?TUNAI}}[LR]Tunai||{{DITERIMA|rp}}', '[LR]Kembali||{{KEMBALI|rp}}', '{{/TUNAI}}');
        return baris;
      }
      case 'footer': return [(b.align === 'L' ? '[L]' : b.align === 'R' ? '[R]' : '[C]') + '{{FOOTER}}'];
      case 'qr': return ['[C][QR]'];
      default: return [];
    }
  }
  function blocksToTemplate(blocks) {
    let baris = [];
    (blocks || []).forEach(function (b) { baris = baris.concat(blokKeBaris_(b)); });
    baris.push('[FEED]', '[CUT]');
    return baris.join('\n');
  }

  const TEMPLATE_DEFAULT = blocksToTemplate(blokDefault());

  const PANDUAN_TEMPLATE = [
    { kode: '[C] [L] [R]', ket: 'Rata tengah / kiri / kanan untuk baris itu' },
    { kode: '[B]', ket: 'Teks tebal' },
    { kode: '[2]', ket: 'Ukuran 2x (lebar & tinggi)' },
    { kode: '[H]', ket: 'Tinggi 2x saja' },
    { kode: '[BOX]', ket: 'Teks disorot (putih di atas hitam)' },
    { kode: '[LR]kiri||kanan', ket: 'Teks rata kiri & kanan dalam 1 baris, mis. [LR]Subtotal||{{SUBTOTAL|rp}}' },
    { kode: '[-]  [=]', ket: 'Garis putus-putus / garis tebal selebar kertas' },
    { kode: '[LOGO]', ket: 'Cetak logo toko (dari URL Logo di atas)' },
    { kode: '[QR]isi', ket: 'Cetak QR code. Kosongkan isi untuk QR ringkasan transaksi otomatis' },
    { kode: '[FEED]', ket: 'Beri jarak/baris kosong' },
    { kode: '[CUT]', ket: 'Potong kertas otomatis — wajib ada di baris terakhir template' },
    { kode: '{{TOKO_NAMA}} {{TOKO_ALAMAT}} {{TOKO_WA}}', ket: 'Data toko dari Pengaturan' },
    { kode: '{{NOTA}} {{TANGGAL|tgl}} {{JAM}} {{KASIR}} {{METODE}}', ket: 'Data transaksi (METODE = Tunai/Non Tunai)' },
    { kode: '{{#ITEM}} ... {{/ITEM}}', ket: 'Diulang untuk setiap barang. Di dalamnya pakai {{NAMA}} {{QTY}} {{HARGA|rp}} {{SUB|rp}}' },
    { kode: '{{?KUNCI}} ... {{/KUNCI}}', ket: 'Baris di dalamnya hanya dicetak bila KUNCI berisi/tidak nol, mis. {{?DISKON}}...{{/DISKON}}' },
    { kode: '{{SUBTOTAL|rp}} {{TOTAL|rp}} {{DISKON|rp}} {{PAJAK|rp}}', ket: 'Angka uang' },
    { kode: '{{DITERIMA|rp}} {{KEMBALI|rp}}', ket: 'Uang tunai diterima & kembalian (hanya bermakna saat METODE=Tunai)' },
    { kode: '{{?TUNAI}} ... {{/TUNAI}}', ket: 'Baris di dalamnya hanya dicetak bila metode bayar Tunai' },
    { kode: '{{FOOTER}}', ket: 'Teks footer dari Pengaturan' },
    { kode: '|rp |angka |kapital |kecil |tgl', ket: 'Filter format: Rupiah, angka ribuan, HURUF BESAR, huruf kecil, tanggal Indonesia' }
  ];

  function ctxDariTrx(trx, toko) {
    const tgl = trx.Tanggal_Waktu ? new Date(trx.Tanggal_Waktu) : new Date();
    return {
      TOKO_NAMA: toko.Nama_Toko || 'KasirKu',
      TOKO_ALAMAT: toko.Alamat || '',
      TOKO_WA: toko.No_Telepon || '',
      NOTA: trx.ID_Transaksi || '-',
      TANGGAL: tgl.toISOString(),
      JAM: tgl.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      KASIR: trx.Kasir || '-',
      METODE: trx.Metode_Bayar || 'Tunai',
      ITEM: (trx.Items || []).map(function (it) {
        return { NAMA: it.Nama_Produk, QTY: it.Qty, HARGA: it.Harga_Satuan, SUB: it.Qty * it.Harga_Satuan };
      }),
      SUBTOTAL: trx.Subtotal || 0,
      DISKON: trx.Diskon || 0,
      PAJAK: trx.Pajak || 0,
      TOTAL: trx.Total_Bayar || 0,
      TUNAI: (trx.Metode_Bayar || 'Tunai') === 'Tunai',
      DITERIMA: trx.Diterima !== undefined ? trx.Diterima : (trx.Total_Bayar || 0),
      KEMBALI: trx.Kembalian || 0,
      FOOTER: toko.Footer_Struk || 'Terima kasih atas kunjungan Anda'
    };
  }

  function formatTglIndo(v) {
    const bln = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const d = v ? new Date(v) : new Date();
    if (isNaN(d.getTime())) return String(v || '');
    return d.getDate() + ' ' + bln[d.getMonth()] + ' ' + d.getFullYear();
  }
  function terapkanFilter_(nilai, mods) {
    let v = nilai, stop = false;
    for (let i = 0; i < mods.length && !stop; i++) {
      const m = mods[i];
      if (m === 'kosong0') { if (!v || Number(v) === 0) { v = ''; stop = true; } }
      else if (m === 'rp') v = rupiah(v);
      else if (m === 'angka') v = Number(v || 0).toLocaleString('id-ID');
      else if (m === 'kapital') v = String(v == null ? '' : v).toUpperCase();
      else if (m === 'kecil') v = String(v == null ? '' : v).toLowerCase();
      else if (m === 'tgl') v = formatTglIndo(v);
    }
    return v == null ? '' : String(v);
  }
  // Render rekursif: loop {{#K}}..{{/K}} → kondisi {{?K}}..{{/K}} → variabel {{K|filter}}
  function renderTeks_(tpl, ctx) {
    tpl = tpl.replace(/\{\{#(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g, function (_, key, inner) {
      const arr = ctx[key];
      if (!Array.isArray(arr)) return '';
      return arr.map(function (item) { return renderTeks_(inner, Object.assign({}, ctx, item)); }).join('');
    });
    tpl = tpl.replace(/\{\{\?(\w+)\}\}\n?([\s\S]*?)\{\{\/\1\}\}\n?/g, function (_, key, inner) {
      const v = ctx[key];
      const truthy = v !== undefined && v !== null && v !== '' && v !== 0 && v !== '0' && v !== false;
      return truthy ? renderTeks_(inner, ctx) : '';
    });
    tpl = tpl.replace(/\{\{([A-Za-z0-9_]+)((?:\|[a-z0-9_]+)*)\}\}/g, function (_, key, modsRaw) {
      const mods = modsRaw ? modsRaw.split('|').slice(1) : [];
      return terapkanFilter_(ctx[key], mods);
    });
    return tpl;
  }
  function bungkusTeks_(teks, W) {
    teks = String(teks || '');
    if (teks.length <= W) return [teks];
    const kata = teks.split(' ');
    const baris = []; let cur = '';
    kata.forEach(function (k) {
      if (k.length > W) { // kata tunggal lebih panjang dari kertas: potong paksa
        if (cur) { baris.push(cur); cur = ''; }
        for (let i = 0; i < k.length; i += W) baris.push(k.slice(i, i + W));
        return;
      }
      const cand = cur ? cur + ' ' + k : k;
      if (cand.length > W) { baris.push(cur); cur = k; } else { cur = cand; }
    });
    if (cur) baris.push(cur);
    return baris;
  }
  function parseBaris_(line) {
    let align = 'L', bold = false, big = false, tall = false, boxed = false, rest = line;
    for (;;) {
      const m = rest.match(/^\[([A-Z0-9=\-]+)\]/);
      if (!m) break;
      const tag = m[1];
      rest = rest.slice(m[0].length);
      if (tag === 'C') align = 'C';
      else if (tag === 'L') align = 'L';
      else if (tag === 'R') align = 'R';
      else if (tag === 'B') bold = true;
      else if (tag === '2') big = true;
      else if (tag === 'H') tall = true;
      else if (tag === 'BOX') boxed = true;
      else if (tag === '-') return { type: 'rule', ch: '-' };
      else if (tag === '=') return { type: 'rule', ch: '=' };
      else if (tag === 'FEED') return { type: 'feed' };
      else if (tag === 'CUT') return { type: 'cut' };
      else if (tag === 'LOGO') return { type: 'logo' };
      else if (tag === 'QR') return { type: 'qr', data: rest.trim() };
      else if (tag === 'LR') {
        const parts = rest.split('||');
        return { type: 'lr', left: parts[0] || '', right: parts[1] || '', bold: bold, big: big, tall: tall, boxed: boxed };
      }
      // tag tak dikenal (mis. [BAR] belum didukung) — abaikan, lanjut cetak sisa teks apa adanya
    }
    if (line.trim() === '') return { type: 'blank' };
    return { type: 'text', text: rest, align: align, bold: bold, big: big, tall: tall, boxed: boxed };
  }
  function parseTemplate_(tpl, ctx) {
    const rendered = renderTeks_(tpl, ctx);
    return rendered.split('\n').map(parseBaris_);
  }

  // ---- Baris hasil parse → byte ESC/POS ----
  async function barisKeBytes_(baris, W, widthPx, toko, warnings) {
    const alignCode = { L: 0, C: 1, R: 2 };
    let b = [];
    for (const row of baris) {
      if (row.type === 'blank') { b = b.concat(textToBytes('\n')); }
      else if (row.type === 'rule') { b = b.concat(textToBytes(row.ch.repeat(W) + '\n')); }
      else if (row.type === 'feed') { b = b.concat(cmdFeed(2)); }
      else if (row.type === 'cut') { b = b.concat(cmdCut()); }
      else if (row.type === 'logo') {
        if (toko.Logo_URL) {
          try {
            const raster = await imageToRaster(toko.Logo_URL, widthPx);
            b = b.concat(cmdAlign(1), cmdRaster(raster), textToBytes('\n'), cmdAlign(0));
          } catch (e) {
            warnings.push('Logo tidak tercetak: ' + e.message);
          }
        }
      } else if (row.type === 'qr') {
        const payload = row.data || ('KasirKu-Struk');
        b = b.concat(cmdAlign(1), cmdQr(payload, W >= 48 ? 6 : 5), textToBytes('\n'), cmdAlign(0));
      } else if (row.type === 'lr') {
        const kanan = row.right;
        const Wlr = row.big ? Math.max(1, Math.floor(W / 2)) : W;
        const avail = Math.max(1, Wlr - kanan.length - 1);
        if (row.bold) b = b.concat(cmdBold(true));
        if (row.boxed) b = b.concat(cmdReverse(true));
        if (row.big || row.tall) b = b.concat(cmdSize(row.big ? 1 : 0, (row.big || row.tall) ? 1 : 0));
        if (row.left.length <= avail) {
          const spasi = Math.max(1, Wlr - row.left.length - kanan.length);
          b = b.concat(textToBytes(row.left + ' '.repeat(spasi) + kanan + '\n'));
        } else {
          bungkusTeks_(row.left, Wlr).forEach(function (l) { b = b.concat(textToBytes(l + '\n')); });
          const spasi = Math.max(1, Wlr - kanan.length);
          b = b.concat(textToBytes(' '.repeat(spasi) + kanan + '\n'));
        }
        if (row.big || row.tall) b = b.concat(cmdSize(0, 0));
        if (row.boxed) b = b.concat(cmdReverse(false));
        if (row.bold) b = b.concat(cmdBold(false));
      } else if (row.type === 'text') {
        b = b.concat(cmdAlign(alignCode[row.align] || 0));
        if (row.bold) b = b.concat(cmdBold(true));
        if (row.boxed) b = b.concat(cmdReverse(true));
        if (row.big || row.tall) b = b.concat(cmdSize(row.big ? 1 : 0, (row.big || row.tall) ? 1 : 0));
        const lebarEfektif = row.big ? Math.max(1, Math.floor(W / 2)) : W;
        bungkusTeks_(row.text, lebarEfektif).forEach(function (l) { b = b.concat(textToBytes(l + '\n')); });
        if (row.big || row.tall) b = b.concat(cmdSize(0, 0));
        if (row.boxed) b = b.concat(cmdReverse(false));
        if (row.bold) b = b.concat(cmdBold(false));
        if (row.align !== 'L') b = b.concat(cmdAlign(0));
      }
    }
    return b;
  }

  async function buildReceipt(trx, toko, kertas) {
    const W = kertas === '80' ? 48 : 32;
    const widthPx = kertas === '80' ? 576 : 384;
    const tpl = toko.Template_Struk || TEMPLATE_DEFAULT;
    const ctx = ctxDariTrx(trx, toko);
    const baris = parseTemplate_(tpl, ctx);
    const warnings = [];
    let b = cmdInit();
    b = b.concat(await barisKeBytes_(baris, W, widthPx, toko, warnings));
    // Jaga-jaga: bila template kustom lupa [CUT], tetap beri jarak secukupnya.
    if (baris.every(function (r) { return r.type !== 'cut'; })) b = b.concat(cmdFeed(3), cmdCut());
    return { bytes: b, warnings: warnings };
  }

  async function printThermal(trx, toko, kertas) {
    const hasil = await buildReceipt(trx, toko, kertas || localStorage.getItem('kasirku_kertas') || '58');
    await writeBytes(hasil.bytes);
    return hasil.warnings;
  }

  // ---- Pratinjau HTML (dipakai di halaman Pengaturan & dialog print fallback) ----
  function barisKeHtml_(baris, toko) {
    const alignCss = { L: 'left', C: 'center', R: 'right' };
    const esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    let html = '';
    baris.forEach(function (row) {
      if (row.type === 'blank') html += '<div>&nbsp;</div>';
      else if (row.type === 'rule') html += '<div style="border-top:1px ' + (row.ch === '=' ? 'solid' : 'dashed') + ' #000;margin:3px 0"></div>';
      else if (row.type === 'feed') html += '<div style="height:10px"></div>';
      else if (row.type === 'cut') html += '<div style="border-top:2px dashed #999;margin:6px 0;font-size:0.7em;color:#999;text-align:center">✂ potong di sini</div>';
      else if (row.type === 'logo') {
        html += toko.Logo_URL
          ? '<div style="text-align:center;margin:4px 0"><img src="' + esc(toko.Logo_URL) + '" style="max-width:70%;max-height:90px" onerror="this.outerHTML=\'<div style=&quot;color:#c00;font-size:0.8em&quot;>⚠️ Logo gagal dimuat dari URL ini</div>\'"></div>'
          : '<div style="color:#999;font-size:0.8em;text-align:center">(logo belum diisi)</div>';
      } else if (row.type === 'qr') {
        html += '<div style="text-align:center;margin:6px 0;font-size:0.72em;color:#666">[QR: ' + esc(row.data || 'ringkasan transaksi') + ']</div>';
      } else if (row.type === 'lr') {
        const styleLr = (row.bold ? 'font-weight:bold;' : '') + ((row.big || row.tall) ? 'font-size:1.3em;' : '') +
          (row.boxed ? 'background:#000;color:#fff;padding:2px 4px;' : '');
        html += '<div style="display:flex;justify-content:space-between;gap:8px;' + styleLr + '"><span>' + esc(row.left) + '</span><span>' + esc(row.right) + '</span></div>';
      } else if (row.type === 'text') {
        const style = 'text-align:' + alignCss[row.align] + ';' +
          (row.bold ? 'font-weight:bold;' : '') +
          (row.boxed ? 'background:#000;color:#fff;display:inline-block;padding:0 4px;' : '') +
          (row.big ? 'font-size:1.6em;' : row.tall ? 'transform:scaleY(1.6);transform-origin:left;' : '');
        html += '<div style="' + style + '">' + esc(row.text) + '</div>';
      }
    });
    return html;
  }
  function renderPreviewHtml(templateStr, trx, toko, kertas) {
    const W = kertas === '80' ? 48 : 32;
    const tpl = templateStr || TEMPLATE_DEFAULT;
    const ctx = ctxDariTrx(trx, toko);
    const baris = parseTemplate_(tpl, ctx);
    return barisKeHtml_(baris, toko);
  }
  function contohTrx() {
    return {
      ID_Transaksi: 'TRX-CONTOH', Tanggal_Waktu: new Date().toISOString(), Kasir: 'Owner', Metode_Bayar: 'Tunai',
      Items: [
        { Nama_Produk: 'Nasi Lalap', Qty: 2, Harga_Satuan: 10000 },
        { Nama_Produk: 'Es Teh Manis', Qty: 1, Harga_Satuan: 5000 }
      ],
      Subtotal: 25000, Diskon: 0, Pajak: 2500, Total_Bayar: 27500, Diterima: 30000, Kembalian: 2500
    };
  }

  // ---- Fallback: cetak via dialog print browser (printer apa saja) ----
  function printFallback(trx, toko) {
    const win = window.open('', '_blank', 'width=320,height=600');
    const tpl = toko.Template_Struk || TEMPLATE_DEFAULT;
    const isi = renderPreviewHtml(tpl, trx, toko, localStorage.getItem('kasirku_kertas') || '58');
    win.document.write(
      '<html><head><title>Struk</title><style>' +
      'body{font-family:monospace;font-size:12px;width:280px;margin:0 auto}' +
      '</style></head><body>' + isi + '</body></html>'
    );
    win.document.close();
    win.focus();
    setTimeout(function () { win.print(); }, 300);
  }

  async function cetakStruk(trx, toko) {
    if (isSupported()) {
      try {
        const warnings = await printThermal(trx, toko);
        return { via: 'bluetooth', warnings: warnings };
      } catch (e) {
        console.warn('Cetak Bluetooth gagal, fallback ke dialog print:', e);
        printFallback(trx, toko);
        return { via: 'fallback', error: e.message };
      }
    }
    printFallback(trx, toko);
    return { via: 'fallback' };
  }

  return {
    isSupported, connect, isConnected, cetakStruk, printFallback,
    renderPreviewHtml, contohTrx,
    blocksToTemplate, blokBaru, blokDefault, labelBlok: LABEL_BLOK,
    templateDefault: TEMPLATE_DEFAULT,
    panduanTemplate: PANDUAN_TEMPLATE,
    templatePresetDefault, labelKategori: LABEL_KATEGORI,
    daftarLibrary, templateUntukId
  };
})();
