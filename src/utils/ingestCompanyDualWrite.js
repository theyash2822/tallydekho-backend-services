/**
 * Company Identity Phase 3D — ingest ALS + optional client wrap.
 * Explicit company_id on all INSERT writers; no SQL rewrite.
 */
import { AsyncLocalStorage } from 'async_hooks';

export const ingestCompanyCtx = new AsyncLocalStorage();

export function currentCompanyId() {
  const id = ingestCompanyCtx.getStore()?.companyId;
  return id == null ? null : Number(id);
}

/**
 * Thin wrap retained for ingest transaction clients.
 * Does NOT mutate SQL — writers must supply company_id explicitly.
 */
export function wrapIngestClient(client) {
  return client;
}
