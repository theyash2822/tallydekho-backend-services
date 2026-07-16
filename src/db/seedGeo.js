/**
 * Seed Tally country / state-or-emirate masters from data/geo_tally_states.json.
 * Idempotent: skips if geo_countries already has rows.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '../../data/geo_tally_states.json');

export async function seedGeoMasters() {
  const { rows: existing } = await query('SELECT COUNT(*)::int AS n FROM geo_countries');
  if ((existing[0]?.n || 0) > 0) {
    console.log(`[geo] skip seed — ${existing[0].n} countries already present`);
    return { skipped: true, countries: existing[0].n };
  }

  if (!fs.existsSync(DATA_PATH)) {
    console.warn('[geo] seed file missing:', DATA_PATH);
    return { skipped: true, reason: 'missing_file' };
  }

  const payload = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const countries = payload.countries || [];
  const states = payload.states || [];

  for (const c of countries) {
    await query(
      `INSERT INTO geo_countries (name, referred_as, division_label)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET
         referred_as = EXCLUDED.referred_as,
         division_label = EXCLUDED.division_label`,
      [c.name, c.referred_as || null, c.division_label || 'State']
    );
  }

  for (const s of states) {
    await query(
      `INSERT INTO geo_states (country_name, state_name)
       VALUES ($1, $2)
       ON CONFLICT (country_name, state_name) DO NOTHING`,
      [s.country_name, s.state_name]
    );
  }

  console.log(`[geo] seeded ${countries.length} countries, ${states.length} states/divisions`);
  return { skipped: false, countries: countries.length, states: states.length };
}
