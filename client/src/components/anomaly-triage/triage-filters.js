// Queue filter chips on the triage page. Ids match the classifier's pattern
// names in anomaly-pattern.js, plus 'all'. Learning devices are a count in
// the status rail, not queue rows: there is nothing scored to triage yet.
export const QUEUE_FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'escalating', label: 'Escalating' },
  { id: 'recurring', label: 'Recurring' },
  { id: 'flagged', label: 'Flagged' },
  { id: 'resolved', label: 'Resolved' },
]);
