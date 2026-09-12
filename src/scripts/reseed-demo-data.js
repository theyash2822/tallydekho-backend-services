#!/usr/bin/env node
/**
 * Reseed all Demo Company rows with full dashboard/stocks/graphs sample data.
 * Usage: node src/scripts/reseed-demo-data.js
 */
import { reseedAllDemoCompanies } from '../services/demoDataService.js';

const results = await reseedAllDemoCompanies();
const ok = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok);
console.log(JSON.stringify({ ok, fail: fail.length, results }, null, 2));
if (fail.length) process.exit(1);
process.exit(0);
