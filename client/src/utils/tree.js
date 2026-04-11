// Shared tree-walk helpers for subnet hierarchies

/**
 * Collect all allocated subnets from a nested node tree.
 * Matches nodes where status === 'allocated', filtered by optional query string.
 *
 * @param {Array}  nodes  - root node array (each node may have .children)
 * @param {string} query  - optional filter string matched against cidr/name
 * @returns {Array} flat array of matching subnet objects
 */
export function collectAllocatedSubnets(nodes, query = '') {
  const result = [];
  const q = query.toLowerCase();
  function collect(nodes) {
    for (const s of nodes) {
      if (s.status === 'allocated') {
        if (!q || s.cidr.includes(q) || s.name?.toLowerCase().includes(q)) {
          result.push(s);
        }
      }
      if (s.children) collect(s.children);
    }
  }
  collect(nodes);
  return result;
}
