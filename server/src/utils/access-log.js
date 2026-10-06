// The anomaly sidecar queries /api/internal/* about once a second, every
// request a success, and logging them buried everything else in the journal
// (26,536 of 29,298 lines in seven hours on one install). A successful
// internal request is left out of the access log; a failed one is still
// logged.
export function skipAccessLog(req, res) {
  return req.originalUrl.startsWith('/api/internal/') && res.statusCode < 400;
}
