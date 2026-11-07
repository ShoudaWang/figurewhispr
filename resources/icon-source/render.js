// Usage: electron render.js <outDir>  — renders icon.svg / icon-small.svg to PNGs and builds icon.ico
const { app, BrowserWindow } = require("electron");
const fs = require("fs"), path = require("path");
const dir = __dirname, out = process.argv[process.argv.length - 1];
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024];
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html,<html><body></body></html>");
  const big = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
  const small = fs.readFileSync(path.join(dir, "icon-small.svg"), "utf8");
  const pngs = {};
  for (const s of SIZES) {
    const svg = s <= 32 ? small : big;
    const url = await win.webContents.executeJavaScript(`new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${s};
        const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${s}, ${s}); res(c.toDataURL('image/png')); };
      img.onerror = rej;
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString("base64"))};
    })`);
    pngs[s] = Buffer.from(url.split(",")[1], "base64");
    fs.writeFileSync(path.join(out, `icon-${s}.png`), pngs[s]);
  }
  // ICO with PNG-encoded entries
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
  const dirs = []; let offset = 6 + 16 * icoSizes.length;
  for (const s of icoSizes) {
    const d = Buffer.alloc(16); const data = pngs[s];
    d.writeUInt8(s >= 256 ? 0 : s, 0); d.writeUInt8(s >= 256 ? 0 : s, 1); d.writeUInt8(0, 2); d.writeUInt8(0, 3);
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(data.length, 8); d.writeUInt32LE(offset, 12);
    offset += data.length; dirs.push(d);
  }
  fs.writeFileSync(path.join(out, "icon.ico"), Buffer.concat([header, ...dirs, ...icoSizes.map((s) => pngs[s])]));
  // preview sheet on light and dark
  const sheet = await win.webContents.executeJavaScript(`new Promise(async (res) => {
    const load = (b64) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
    const items = ${JSON.stringify([256, 128, 64, 48, 32, 24, 16].map((s) => [s, pngs[s].toString("base64")]))};
    const c = document.createElement('canvas'); c.width = 1000; c.height = 640; const g = c.getContext('2d');
    for (const [row, bgc] of [[0, '#F3F4F6'], [1, '#1F1F1F']]) {
      g.fillStyle = bgc; g.fillRect(0, row * 320, 1000, 320);
      let x = 32;
      for (const [s, b64] of items) { const im = await load(b64); g.drawImage(im, x, row * 320 + (320 - s) / 2); x += s + 32; }
    }
    res(c.toDataURL('image/png'));
  })`);
  fs.writeFileSync(path.join(out, "preview.png"), Buffer.from(sheet.split(",")[1], "base64"));
  app.quit();
});
