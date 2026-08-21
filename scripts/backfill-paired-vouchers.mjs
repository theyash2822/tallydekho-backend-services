// Backfill paired Receipt/Payment vouchers that were dropped when a Sales/Purchase
// invoice's first Tally push was deferred (see CHANGELOG 2026-08-21).
//
// Safe by design: it reuses ensurePairedVoucherForQueueEntry, which skips any invoice
// that already has its child voucher, and forwardToTally cannot reach Tally from a
// standalone process — the receipt is queued and pushed by the server's normal
// retry/desktop-pull machinery.
//
//   node scripts/backfill-paired-vouchers.mjs                      # dry run, all missing
//   node scripts/backfill-paired-vouchers.mjs --refs=A,B --commit   # queue specific refs
import 'dotenv/config';
import { query } from '../src/db/index.js';
import { ensurePairedVoucherForQueueEntry } from '../src/routes/tally-write.js';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const refsArg = args.find(a => a.startsWith('--refs='));
const onlyRefs = refsArg ? refsArg.slice('--refs='.length).split(',').map(s => s.trim()).filter(Boolean) : null;

const inr = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });

const { rows } = await query(`
  SELECT av.tdk_reference_no, av.write_queue_id, av.party_name, av.total_amount,
         av.tally_voucher_no, wq.entry_type, wq.attempt_count, wq.status,
         COALESCE(wq.payload->'collect_payment', wq.payload->'make_payment') AS pay,
         v.guid IS NOT NULL AS in_tally, COALESCE(v.is_cancelled, false) AS cancelled
    FROM app_vouchers av
    JOIN write_queue wq ON wq.id = av.write_queue_id
    LEFT JOIN vouchers v ON v.company_guid = av.company_guid AND v.reference = av.tdk_reference_no
   WHERE wq.entry_type IN ('sales', 'purchase')
     AND wq.status = 'success'
     AND COALESCE(wq.payload->'collect_payment'->>'ledgerName',
                  wq.payload->'make_payment'->>'ledgerName') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM app_vouchers ch
        WHERE ch.parent_invoice_uuid = av.invoice_uuid
          AND ch.voucher_type IN ('receipt', 'payment')
     )
   ORDER BY av.created_at`);

const targets = onlyRefs ? rows.filter(r => onlyRefs.includes(r.tdk_reference_no)) : rows;

console.log(`${commit ? 'COMMIT' : 'DRY RUN'} — ${targets.length} invoice(s) owed a paired voucher\n`);
for (const r of targets) {
  const kind = r.entry_type === 'sales' ? 'Receipt' : 'Payment';
  console.log(
    `${r.tdk_reference_no}  ${kind.padEnd(7)}  ${inr(r.pay?.amount ?? 0).padStart(15)}  ` +
    `${r.pay?.ledgerName ?? '?'}  <- ${r.party_name}  ` +
    `[tally_vch=${r.tally_voucher_no || 'pending'} in_tally=${r.in_tally} cancelled=${r.cancelled} attempts=${r.attempt_count}]`
  );
}

if (onlyRefs) {
  const missing = onlyRefs.filter(ref => !targets.some(t => t.tdk_reference_no === ref));
  if (missing.length) console.log(`\nNot eligible (already paired, or not a success/sales/purchase row): ${missing.join(', ')}`);
}

if (!commit) {
  console.log('\nNo changes made. Re-run with --commit to queue these vouchers.');
  process.exit(0);
}

let ok = 0, skipped = 0, failed = 0;
for (const r of targets) {
  const result = await ensurePairedVoucherForQueueEntry(r.write_queue_id, null);
  if (!result) { skipped++; console.log(`SKIP  ${r.tdk_reference_no} (already paired or not owed)`); }
  else if (result.ok) { ok++; console.log(`QUEUED ${r.tdk_reference_no} -> ${result.tdkRef}${result.queued ? ' (desktop offline, will push on reconnect)' : ''}`); }
  else { failed++; console.log(`FAIL  ${r.tdk_reference_no}: ${result.error}`); }
}
console.log(`\nqueued=${ok} skipped=${skipped} failed=${failed}`);
process.exit(0);
