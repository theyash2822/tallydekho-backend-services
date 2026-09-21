/**
 * Future billing tests must not write into shared live wallets.
 * Use an isolated fixture user + rollback, or a unique marker, then clean only that marker.
 */
export const BILLING_TEST_MARKER = 'tdk_billing_fixture';

export function billingFixtureMobile(suffix = '000') {
  return `00000${String(suffix).padStart(5, '0')}`.slice(-10);
}

export async function withBillingRollback(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  }
}
