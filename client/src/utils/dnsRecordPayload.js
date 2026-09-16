// Builds the write body for a DNS record from the editor form (D-02, T-21).
// The form keeps every field so switching type back and forth loses nothing,
// but only the fields the chosen type owns are sent: MX and SRV carry
// priority, SRV alone carries weight and port. Zero is a real value for
// those and for TTL; null means "not set" and is sent as null so the server
// keeps its default rather than a stale number from a previous type.
const NUMERIC = ['priority', 'weight', 'port', 'ttl'];

const OWNS = {
  MX: ['priority'],
  SRV: ['priority', 'weight', 'port'],
};

export function dnsRecordPayload(form) {
  const type = String(form.type || '').toUpperCase();
  const owned = OWNS[type] || [];
  const payload = {
    name: form.name,
    type,
    value: form.value,
    enabled: form.enabled !== false,
  };
  for (const field of NUMERIC) {
    if (field !== 'ttl' && !owned.includes(field)) {
      payload[field] = null;
      continue;
    }
    const raw = form[field];
    payload[field] = raw === '' || raw == null || Number.isNaN(Number(raw)) ? null : Number(raw);
  }
  return payload;
}
