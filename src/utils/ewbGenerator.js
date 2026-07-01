// ── EWB Generation Utility ────────────────────────────────────────────────────
// Shared between api-v1.js (manual generate route) and tally-write.js (auto-EWB hook)
// Wire real NIC EWB API calls inside generateEWB when credentials are provisioned.

import { query } from '../db/schema.js';

/**
 * Validate dispatch details, build NIC EWB payload, and (in production) submit to NIC API.
 * @param {string}  companyGuid
 * @param {object}  voucher          - row from the vouchers table
 * @param {object}  company          - { gstin, name, pincode, state_code }
 * @param {object}  creds            - { gstin, username, … } from integration_settings.ewaybill
 * @param {object}  dispatchDetails  - { dispatch_from, ship_to, transport_mode, distance, vehicle_number, … }
 * @returns {Promise<{ ewbNo, ewbDate, validUpto }>}
 * @throws  Error when dispatch details are missing or EWB credentials are not provisioned
 */
export async function generateEWB(companyGuid, voucher, company, creds, dispatchDetails) {
  // ── 1. Validate required dispatch fields ──────────────────────────────────
  const missing = [];
  if (!dispatchDetails?.dispatch_from)  missing.push('Dispatch From');
  if (!dispatchDetails?.ship_to)         missing.push('Ship To');
  if (!dispatchDetails?.transport_mode)  missing.push('Transport Mode');
  if (missing.length > 0) {
    throw new Error(`Missing dispatch details: ${missing.join(', ')}`);
  }

  // ── 2. Load line items ────────────────────────────────────────────────────
  const { rows: items } = await query(
    `SELECT * FROM voucher_inventory_items WHERE voucher_guid = $1 AND company_guid = $2`,
    [voucher.guid, companyGuid]
  );
  const { rows: gstRows } = await query(
    `SELECT * FROM gst_voucher_details WHERE voucher_guid = $1 AND company_guid = $2`,
    [voucher.guid, companyGuid]
  );
  const g = gstRows[0] || {};

  // ── 3. Map transport mode to NIC code ────────────────────────────────────
  const transModeMap = { 'Rail': '2', 'Air': '3', 'Ship': '4' };
  const transMode = transModeMap[dispatchDetails.transport_mode] || '1'; // default Road

  // ── 4. Build NIC EWB API payload ─────────────────────────────────────────
  const ewbPayload = {
    supplyType:      'O',
    subSupplyType:   '1',
    docType:         'INV',
    docNo:           voucher.voucher_number,
    docDate:         (voucher.date || '').split('-').reverse().join('/'), // YYYY-MM-DD → DD/MM/YYYY
    fromGstin:       company.gstin,
    fromTrdName:     company.name,
    fromAddr1:       dispatchDetails.dispatch_from_address1 || dispatchDetails.dispatch_from,
    fromAddr2:       dispatchDetails.dispatch_from_address2 || '',
    fromPlace:       dispatchDetails.dispatch_from,
    fromPincode:     parseInt(dispatchDetails.dispatch_from_pincode) || parseInt(company.pincode) || 0,
    fromStateCode:   parseInt(company.state_code)  || 27,
    toGstin:         g.buyer_gstin                 || 'URP',
    toTrdName:       voucher.party_name            || '',
    toAddr1:         dispatchDetails.ship_to_address1 || dispatchDetails.ship_to,
    toAddr2:         dispatchDetails.ship_to_address2 || '',
    toPlace:         dispatchDetails.ship_to,
    toPincode:       parseInt(dispatchDetails.ship_to_pincode) || parseInt(g.buyer_pincode) || 0,
    toStateCode:     parseInt(g.buyer_state_code)  || 27,
    transMode,
    transDistance:   dispatchDetails.distance       || 0,
    transporterName: dispatchDetails.transporter_name  || '',
    transporterId:   dispatchDetails.transporter_id    || '',
    transDocNo:      dispatchDetails.transport_doc_no  || '',
    transDocDate:    dispatchDetails.transport_doc_date ? dispatchDetails.transport_doc_date.split('-').reverse().join('/') : '', // YYYY-MM-DD → DD/MM/YYYY
    vehicleNo:       dispatchDetails.vehicle_number    || '',
    vehicleType:     ((dispatchDetails.vehicle_type || '').toLowerCase().includes('over') || (dispatchDetails.vehicle_type || '').toUpperCase() === 'ODC') ? 'O' : 'R',
    itemList: items.map((item, i) => ({
      itemNo:        i + 1,
      productName:   item.stock_item_name  || '',
      productDesc:   item.stock_item_name  || '',
      hsnCode:       item.hsn_code         || '0000',
      quantity:      parseFloat(item.actual_qty) || 1,
      qtyUnit:       item.unit              || 'NOS',
      cgstRate:      parseFloat(g.cgst_rate)   || 0,
      sgstRate:      parseFloat(g.sgst_rate)   || 0,
      igstRate:      parseFloat(g.igst_rate)   || 0,
      cessRate:      0,
      taxableAmount: parseFloat(item.amount)   || 0,
    })),
    totalValue:   parseFloat(voucher.amount)      || 0,
    cgstValue:    parseFloat(g.cgst_amount)       || 0,
    sgstValue:    parseFloat(g.sgst_amount)       || 0,
    igstValue:    parseFloat(g.igst_amount)       || 0,
    cessValue:    0,
    totInvValue:  parseFloat(voucher.amount)      || 0,
    ...(voucher.irn ? { irn: voucher.irn } : {}),
  };

  console.log('[EWB] Payload built for', voucher.voucher_number);

  // ── 5. PRODUCTION: Replace below with actual NIC EWB API call ─────────────
  // const axios = require('axios');
  // const response = await axios.post(
  //   'https://ewaybillgst.gov.in/api/ewayapiv3/ewayitnewapiv3/generate',
  //   ewbPayload,
  //   {
  //     headers: {
  //       gstin:    creds.gstin,
  //       username: creds.username,
  //       'Content-Type': 'application/json',
  //     }
  //   }
  // );
  // return {
  //   ewbNo:     response.data.ewbNo,
  //   ewbDate:   response.data.ewbDt,
  //   validUpto: response.data.validUpto,
  // };
  // ──────────────────────────────────────────────────────────────────────────

  throw new Error(
    'EWB credentials not provisioned. Configure NIC E-Way Bill credentials in Settings to enable EWB generation.'
  );
}
