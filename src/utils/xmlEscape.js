/**
 * Escaping for text we interpolate into Tally import XML.
 *
 * Every user/DB value must pass through exactly one of these on its way into a
 * template. Escaping twice turns `&` into `&amp;amp;` in Tally; not escaping
 * lets `&` / `<` break the envelope. Unicode (Hindi, ₹) and newlines pass
 * through untouched.
 */
function escapeXmlChars(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Element text content: `<NAME>${xmlText(v)}</NAME>` */
export function xmlText(value) {
  return escapeXmlChars(value);
}

/** Double-quoted attribute value: `NAME="${xmlAttr(v)}"` */
export function xmlAttr(value) {
  return escapeXmlChars(value);
}
