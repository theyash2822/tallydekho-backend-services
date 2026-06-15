// ── IRN Generation Utility ────────────────────────────────────────────────────
// Shared between api-v1.js (manual generate route) and tally-write.js (auto-IRN hook)
// Wire real IRP/NIC/GSP API calls inside generateIRN when credentials are provisioned.

import { query } from '../db/schema.js';

/**
 * Build and (eventually) submit the NIC e-invoice API v1.03 payload for a voucher.
 * @param {string}  companyGuid
 * @param {object}  voucher        - row from the vouchers table
 * @param {object}  company        - { gstin, name, address, city, state, state_code, pincode }
 * @param {object}  creds          - { gstin, username, client_id, client_secret, … }
 * @returns {Promise<{ irn, ackNo, ackDate, signedInvoice, qrCode }>}
 * @throws  Error when IRP credentials are not provisioned or the API call fails
 */
export async function generateIRN(companyGuid, voucher, company, creds) {
  // ── 1. Load GST details ────────────────────────────────────────────────────
  const { rows: gstRows } = await query(
    `SELECT * FROM gst_voucher_details WHERE voucher_guid = $1 AND company_guid = $2`,
    [voucher.guid, companyGuid]
  );
  const gstDetail = gstRows[0] || {};

  // ── 2. Load line items ─────────────────────────────────────────────────────
  const { rows: items } = await query(
    `SELECT * FROM voucher_inventory_items WHERE voucher_guid = $1 AND company_guid = $2`,
    [voucher.guid, companyGuid]
  );

  // ── 3. Build IRP payload (NIC e-invoice API v1.03 schema) ─────────────────
  const irpPayload = {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp:  gstDetail.supply_type || 'B2B',
      RegRev:  'N',
      EcmGstin: null,
    },
    DocDtls: {
      Typ: 'INV',
      No:  voucher.voucher_number,
      Dt:  (voucher.date || '').split('-').reverse().join('/'), // YYYY-MM-DD → DD/MM/YYYY
    },
    SellerDtls: {
      Gstin: company.gstin,
      LglNm: company.name,
      Addr1: company.address   || '',
      Loc:   company.city      || company.state || '',
      Pin:   parseInt(company.pincode)    || 0,
      Stcd:  company.state_code           || '27',
    },
    BuyerDtls: {
      Gstin: gstDetail.buyer_gstin         || 'URP',
      LglNm: voucher.party_name            || '',
      Pos:   gstDetail.place_of_supply     || company.state_code || '27',
      Addr1: gstDetail.buyer_address       || '',
      Loc:   gstDetail.buyer_city          || '',
      Pin:   parseInt(gstDetail.buyer_pincode) || 0,
      Stcd:  gstDetail.buyer_state_code    || '27',
    },
    ValDtls: {
      AssVal:    parseFloat(voucher.amount)           || 0,
      CgstVal:   parseFloat(gstDetail.cgst_amount)   || 0,
      SgstVal:   parseFloat(gstDetail.sgst_amount)   || 0,
      IgstVal:   parseFloat(gstDetail.igst_amount)   || 0,
      TotInvVal: parseFloat(voucher.amount)           || 0,
    },
    ItemList: items.map((item, i) => ({
      SlNo:       String(i + 1),
      PrdDesc:    item.stock_item_name || '',
      IsServc:    'N',
      HsnCd:      item.hsn_code        || '0000',
      Qty:        parseFloat(item.actual_qty) || 1,
      Unit:       item.unit             || 'NOS',
      UnitPrice:  parseFloat(item.rate)  || 0,
      TotAmt:     parseFloat(item.amount) || 0,
      AssAmt:     parseFloat(item.amount) || 0,
      GstRt:      parseFloat(item.tax_rate) || 0,
      IgstAmt:    0,
      CgstAmt:    0,
      SgstAmt:    0,
      TotItemVal: parseFloat(item.amount) || 0,
    })),
  };

  // ── 4. PRODUCTION: Replace below with actual NIC/GSP API call ────────────
  // Example with NIC sandbox:
  // const response = await axios.post(
  //   'https://einvoice1-uat.nic.in/eivital/dec/v1.03/invoice',
  //   irpPayload,
  //   {
  //     headers: {
  //       'client_id':     creds.client_id,
  //       'client_secret': creds.client_secret,
  //       'user_name':     creds.username,
  //       'Gstin':         creds.gstin,
  //       'Content-Type':  'application/json',
  //     }
  //   }
  // );
  // return {
  //   irn:           response.data.data.Irn,
  //   ackNo:         response.data.data.AckNo,
  //   ackDate:       response.data.data.AckDt,
  //   signedInvoice: response.data.data.SignedInvoice,
  //   qrCode:        response.data.data.QRCodeUrl,
  // };
  // ─────────────────────────────────────────────────────────────────────────

  // Placeholder: log payload and throw until real credentials are wired
  console.log('[IRN] Payload ready for IRP:', JSON.stringify(irpPayload).slice(0, 200));
  throw new Error(
    'IRP credentials not yet provisioned. Configure GSP/NIC credentials in Settings → E-Invoice to enable IRN generation.'
  );
}
