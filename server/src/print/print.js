import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PS1 = resolve(__dirname, 'rawprint.ps1');

const run = (cmd, args, timeout = 20000) => new Promise((res, rej) =>
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
    err ? rej(new Error((stderr || err.message).trim().split('\n')[0])) : res(stdout)));

/** Imprimantes installées dans Windows. */
export async function listPrinters() {
  if (process.platform !== 'win32') return [];
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | Select-Object Name,DriverName,PortName | ConvertTo-Json -Compress']);
  if (!out.trim()) return [];
  const j = JSON.parse(out);
  return (Array.isArray(j) ? j : [j]).map((p) => ({ name: p.Name, driver: p.DriverName, port: p.PortName }));
}

/**
 * Image 1 bit (bit à 1 = point noir, lignes de width/8 octets, MSB à gauche) -> commandes ESC/POS.
 * Envoyée par bandes : certaines imprimantes ne supportent pas une seule très grande image.
 */
export function escposFromBitmap({ width, height, data }, { cut = true } = {}) {
  const bytesPerRow = width / 8;
  const parts = [Buffer.from([0x1b, 0x40])]; // ESC @ : initialisation
  const BAND = 200;
  for (let y = 0; y < height; y += BAND) {
    const h = Math.min(BAND, height - y);
    parts.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 255, bytesPerRow >> 8, h & 255, h >> 8])); // GS v 0
    parts.push(data.subarray(y * bytesPerRow, (y + h) * bytesPerRow));
  }
  parts.push(Buffer.from([0x1b, 0x64, 0x04])); // ESC d 4 : avance de 4 lignes
  if (cut) parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // GS V 66 0 : coupe partielle
  return Buffer.concat(parts);
}

export function validateBitmap(b) {
  const width = Number(b?.width); const height = Number(b?.height);
  if (!Number.isInteger(width) || width < 8 || width > 832 || width % 8) return null;
  if (!Number.isInteger(height) || height < 1 || height > 6000) return null;
  const data = Buffer.from(String(b.data ?? ''), 'base64');
  if (data.length !== (width / 8) * height) return null;
  return { width, height, data };
}

function sendTcp(host, port, bytes) {
  return new Promise((res, rej) => {
    const s = net.connect({ host, port, timeout: 5000 }, () => s.end(bytes));
    s.on('close', (hadErr) => !hadErr && res());
    s.on('timeout', () => { s.destroy(); rej(new Error('Imprimante réseau injoignable (délai dépassé)')); });
    s.on('error', (e) => rej(new Error(`Imprimante réseau injoignable (${e.code ?? e.message})`)));
  });
}

async function sendUsb(name, bytes) {
  if (process.platform !== 'win32') throw new Error('Impression USB supportée sous Windows uniquement');
  const known = await listPrinters();
  if (!known.some((p) => p.name === name)) throw new Error(`Imprimante « ${name} » introuvable dans Windows`);
  const tmp = resolve(tmpdir(), `ticket-${randomBytes(6).toString('hex')}.bin`);
  await writeFile(tmp, bytes);
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Printer', name, '-Path', tmp], 30000);
  } finally { unlink(tmp).catch(() => {}); }
}

// Un ticket à la fois : évite que deux impressions simultanées se mélangent.
let chain = Promise.resolve();

/** target : "usb:<nom Windows>" ou "tcp:<ip>:<port>" (ou "file:" en test si PRINT_TO_FILE_DIR est défini). */
export function sendToPrinter(target, bytes) {
  const job = chain.then(async () => {
    const [kind, ...rest] = String(target ?? '').split(':');
    const val = rest.join(':');
    if (kind === 'usb' && val) return sendUsb(val, bytes);
    if (kind === 'tcp') {
      const m = val.match(/^([\w.\-]+)(?::(\d{1,5}))?$/);
      const port = Number(m?.[2] ?? 9100);
      if (!m || port < 1 || port > 65535) throw new Error('Adresse réseau invalide');
      return sendTcp(m[1], port, bytes);
    }
    if (kind === 'file' && process.env.PRINT_TO_FILE_DIR) {
      await mkdir(process.env.PRINT_TO_FILE_DIR, { recursive: true });
      return writeFile(resolve(process.env.PRINT_TO_FILE_DIR, 'ticket.bin'), bytes);
    }
    throw new Error('Aucune imprimante configurée');
  });
  chain = job.catch(() => {});
  return job;
}
