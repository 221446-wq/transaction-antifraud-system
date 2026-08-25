function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sondea `fn` hasta que devuelva un valor truthy, o hasta agotar `timeoutMs`.
 * `fn` puede ser sync o async.
 */
async function waitForCondition(fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timeout: la condición no se cumplió tras ${timeoutMs}ms.`);
    }
    await sleep(intervalMs);
  }
}

module.exports = { sleep, waitForCondition };
