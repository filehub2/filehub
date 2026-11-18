'use strict';
// Starts the FileHub web server and a Cloudflare Quick Tunnel.
// Whenever cloudflared announces a new trycloudflare.com URL, public/config.json is updated.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_FILE = path.join(PUBLIC_DIR, 'config.json');
const PORT = Number(process.env.PORT || 3001);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLOUDFLARED = process.env.CLOUDFLARED_BIN || 'cloudflared';
let server;
let tunnel;
let stopping = false;
let restartTimer;
let currentUrl = '';

function log(...args) { console.log('[FileHub-Manager]', ...args); }

async function saveConfig(status, url = currentUrl, message = '') {
  const config = {
    app: 'FileHub',
    version: '1.0.1',
    publicUrl: url || '',
    tunnelStatus: status,
    updatedAt: new Date().toISOString(),
    message: message || ''
  };
  const temp = CONFIG_FILE + '.tmp';
  await fs.promises.mkdir(PUBLIC_DIR, { recursive: true });
  await fs.promises.writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
  await fs.promises.rename(temp, CONFIG_FILE);
}

function handleTunnelText(text) {
  const all = String(text);
  // Quick Tunnel URL is printed by cloudflared in its startup log.
  const matches = all.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig);
  if (!matches || !matches.length) return;
  const found = matches[matches.length - 1].replace(/[),.;]+$/, '');
  if (found && found !== currentUrl) {
    currentUrl = found;
    saveConfig('online', currentUrl, 'Cloudflare Tunnel conectado').then(() => {
      log('Novo endereço público registrado em public/config.json:', currentUrl);
    }).catch(err => log('Falha ao atualizar config.json:', err.message));
  }
}

function startServer() {
  log(`Iniciando servidor web na porta ${PORT}...`);
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => process.stdout.write(chunk));
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  server.on('error', err => { log('Não foi possível iniciar server.js:', err.message); process.exit(1); });
  server.on('exit', (code, signal) => {
    if (!stopping) {
      log(`Servidor web encerrou (code=${code}, signal=${signal}). Encerrando o gerenciador para o systemd reiniciar.`);
      process.exit(code || 1);
    }
  });
}

function startTunnel() {
  if (stopping) return;
  log('Iniciando Cloudflare Quick Tunnel para', ORIGIN);
  tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', ORIGIN], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const collect = chunk => {
    const text = chunk.toString();
    process.stdout.write(text);
    handleTunnelText(text);
  };
  tunnel.stdout.on('data', collect);
  tunnel.stderr.on('data', collect);
  tunnel.on('error', err => {
    log('Erro ao iniciar cloudflared:', err.message);
    saveConfig('error', '', 'cloudflared não iniciou: ' + err.message).catch(() => {});
  });
  tunnel.on('exit', (code, signal) => {
    if (stopping) return;
    currentUrl = '';
    saveConfig('reconnecting', '', 'Tunnel desconectado; tentando reconectar').catch(() => {});
    log(`Cloudflare Tunnel encerrou (code=${code}, signal=${signal}). Nova tentativa em 5 segundos.`);
    restartTimer = setTimeout(startTunnel, 5000);
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  await saveConfig('stopped', '', 'FileHub parado').catch(() => {});
  if (tunnel && !tunnel.killed) tunnel.kill('SIGTERM');
  if (server && !server.killed) server.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  await saveConfig('starting', '', 'Iniciando FileHub e Cloudflare Tunnel');
  startServer();
  // Give the local HTTP server a moment to bind before starting the tunnel.
  setTimeout(startTunnel, 1200);
})();
