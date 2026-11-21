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
  function line(width) { return textToBytes('-'.repeat(width) + '\n'); }

  function rupiah(n) {
    return 'Rp' + Number(n || 0).toLocaleString('id-ID');
  }

  // width58 = 32 kolom, width80 = 48 kolom (perkiraan font default)
  function buildReceipt(trx, toko, kertas) {
    const W = kertas === '80' ? 48 : 32;
    let b = [];
    b = b.concat(cmdInit());
    b = b.concat(cmdAlign(1), cmdBold(true), cmdSize(1, 1));
    b = b.concat(textToBytes((toko.Nama_Toko || 'KasirKu') + '\n'));
    b = b.concat(cmdSize(0, 0), cmdBold(false));
    if (toko.Alamat) b = b.concat(textToBytes(toko.Alamat + '\n'));
    if (toko.No_Telepon) b = b.concat(textToBytes(toko.No_Telepon + '\n'));
    b = b.concat(cmdAlign(0));
    b = b.concat(line(W));
    b = b.concat(textToBytes('No: ' + trx.ID_Transaksi + '\n'));
    b = b.concat(textToBytes(new Date(trx.Tanggal_Waktu).toLocaleString('id-ID') + '\n'));
    b = b.concat(textToBytes('Kasir: ' + (trx.Kasir || '-') + '\n'));
    b = b.concat(line(W));

    trx.Items.forEach(function (it) {
      const nama = String(it.Nama_Produk);
      b = b.concat(textToBytes(nama.length > W ? nama.slice(0, W) + '\n' : nama + '\n'));
      const kiri = it.Qty + ' x ' + rupiah(it.Harga_Satuan);
      const kanan = rupiah(it.Qty * it.Harga_Satuan);
      const spasi = Math.max(1, W - kiri.length - kanan.length);
      b = b.concat(textToBytes(kiri + ' '.repeat(spasi) + kanan + '\n'));
    });

    b = b.concat(line(W));
    const row = function (label, val) {
      const spasi = Math.max(1, W - label.length - val.length);
      return textToBytes(label + ' '.repeat(spasi) + val + '\n');
    };
    b = b.concat(row('Subtotal', rupiah(trx.Subtotal)));
    if (trx.Diskon) b = b.concat(row('Diskon', '-' + rupiah(trx.Diskon)));
    b = b.concat(cmdBold(true));
    b = b.concat(row('TOTAL', rupiah(trx.Total_Bayar)));
    b = b.concat(cmdBold(false));
    b = b.concat(line(W));
    b = b.concat(cmdAlign(1));
    b = b.concat(textToBytes((toko.Footer_Struk || 'Terima kasih') + '\n'));
    b = b.concat(cmdFeed(3));
    b = b.concat(cmdCut());
    return b;
  }

  async function printThermal(trx, toko, kertas) {
    const bytes = buildReceipt(trx, toko, kertas || localStorage.getItem('kasirku_kertas') || '58');
    await writeBytes(bytes);
  }

  // ---- Fallback: cetak via dialog print browser (printer apa saja) ----
  function printFallback(trx, toko) {
    const win = window.open('', '_blank', 'width=320,height=600');
    const itemsHtml = trx.Items.map(function (it) {
      return '<tr><td colspan="2">' + it.Nama_Produk + '</td></tr>' +
        '<tr><td>' + it.Qty + ' x Rp' + Number(it.Harga_Satuan).toLocaleString('id-ID') + '</td>' +
        '<td style="text-align:right">Rp' + Number(it.Qty * it.Harga_Satuan).toLocaleString('id-ID') + '</td></tr>';
    }).join('');
    win.document.write(
      '<html><head><title>Struk</title><style>' +
      'body{font-family:monospace;font-size:12px;width:280px;margin:0 auto}' +
      'table{width:100%;border-collapse:collapse}' +
      'hr{border:none;border-top:1px dashed #000}' +
      '.center{text-align:center}.bold{font-weight:bold}' +
      '</style></head><body>' +
      '<div class="center bold">' + (toko.Nama_Toko || 'KasirKu') + '</div>' +
      '<div class="center">' + (toko.Alamat || '') + '</div>' +
      '<div class="center">' + (toko.No_Telepon || '') + '</div><hr>' +
      '<div>No: ' + trx.ID_Transaksi + '</div>' +
      '<div>' + new Date(trx.Tanggal_Waktu).toLocaleString('id-ID') + '</div>' +
      '<div>Kasir: ' + (trx.Kasir || '-') + '</div><hr>' +
      '<table>' + itemsHtml + '</table><hr>' +
      '<table>' +
      '<tr><td>Subtotal</td><td style="text-align:right">Rp' + Number(trx.Subtotal).toLocaleString('id-ID') + '</td></tr>' +
      (trx.Diskon ? '<tr><td>Diskon</td><td style="text-align:right">-Rp' + Number(trx.Diskon).toLocaleString('id-ID') + '</td></tr>' : '') +
      '<tr class="bold"><td>TOTAL</td><td style="text-align:right">Rp' + Number(trx.Total_Bayar).toLocaleString('id-ID') + '</td></tr>' +
      '</table><hr>' +
      '<div class="center">' + (toko.Footer_Struk || 'Terima kasih') + '</div>' +
      '</body></html>'
    );
    win.document.close();
    win.focus();
    setTimeout(function () { win.print(); }, 300);
  }

  async function cetakStruk(trx, toko) {
    if (isSupported()) {
      try {
        await printThermal(trx, toko);
        return { via: 'bluetooth' };
      } catch (e) {
        console.warn('Cetak Bluetooth gagal, fallback ke dialog print:', e);
        printFallback(trx, toko);
        return { via: 'fallback', error: e.message };
      }
    }
    printFallback(trx, toko);
    return { via: 'fallback' };
  }

  return { isSupported, connect, isConnected, cetakStruk, printFallback };
})();
