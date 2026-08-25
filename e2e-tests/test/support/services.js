const path = require('node:path');
const { spawn } = require('node:child_process');
const { waitForCondition } = require('./wait');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TRANSACTION_SERVICE_DIR = path.join(REPO_ROOT, 'transaction-service');
const ANTIFRAUD_SERVICE_DIR = path.join(REPO_ROOT, 'antifraud-service');

/**
 * Levanta un servicio real (`node src/index.js`) como proceso hijo en su
 * propio directorio, para que cargue su propio .env. Reenvía su stdout/
 * stderr con un prefijo, para poder ver los logs de trazabilidad de ambos
 * servicios entreverados si algo falla.
 */
function spawnService(cwd, label) {
  const child = spawn(process.execPath, ['src/index.js'], { cwd });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${label}] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${label}] ${chunk}`);
  });
  child.on('error', (err) => {
    console.error(`[${label}] no se pudo lanzar el proceso`, err);
  });

  return child;
}

async function waitForHealth(url, timeoutMs) {
  await waitForCondition(async () => {
    try {
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  }, timeoutMs, 300);
}

module.exports = {
  REPO_ROOT,
  TRANSACTION_SERVICE_DIR,
  ANTIFRAUD_SERVICE_DIR,
  spawnService,
  waitForHealth,
};
