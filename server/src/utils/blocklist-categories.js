/**
 * Block List Project category catalog.
 * Source: https://blocklistproject.github.io/Lists/
 */

export const BLOCKLIST_CATEGORIES = [
  { slug: 'abuse',      name: 'Abuse',      description: 'Deceptive and abusive sites',       group: 'main' },
  { slug: 'ads',        name: 'Ads',        description: 'Ad servers and networks',            group: 'main' },
  { slug: 'crypto',     name: 'Crypto',     description: 'Cryptojacking and crypto scams',     group: 'main' },
  { slug: 'drugs',      name: 'Drugs',      description: 'Illegal drug sites',                 group: 'main' },
  { slug: 'facebook',   name: 'Facebook',   description: 'Facebook and Meta services',         group: 'main' },
  { slug: 'fraud',      name: 'Fraud',      description: 'Fraud sites',                        group: 'main' },
  { slug: 'gambling',   name: 'Gambling',   description: 'Gambling sites',                     group: 'main' },
  { slug: 'malware',    name: 'Malware',    description: 'Malware distribution hosts',         group: 'main' },
  { slug: 'phishing',   name: 'Phishing',   description: 'Phishing sites',                     group: 'main' },
  { slug: 'piracy',     name: 'Piracy',     description: 'Piracy and illegal downloads',       group: 'main' },
  { slug: 'porn',       name: 'Porn',       description: 'Adult content',                      group: 'main' },
  { slug: 'ransomware', name: 'Ransomware', description: 'Ransomware C2 and distribution',     group: 'main' },
  { slug: 'redirect',   name: 'Redirect',   description: 'Malicious redirects',                group: 'main' },
  { slug: 'scam',       name: 'Scam',       description: 'Scam sites',                         group: 'main' },
  { slug: 'tiktok',     name: 'TikTok',     description: 'TikTok domains',                     group: 'main' },
  { slug: 'torrent',    name: 'Torrent',    description: 'Torrent sites',                      group: 'main' },
  { slug: 'tracking',   name: 'Tracking',   description: 'Tracking and analytics',             group: 'main' },
  { slug: 'twitter',    name: 'Twitter',    description: 'Twitter/X domains',                  group: 'main' },
  { slug: 'basic',      name: 'Basic',      description: 'Starter protection list',            group: 'beta' },
  { slug: 'smart-tv',   name: 'Smart TV',   description: 'Smart TV telemetry',                 group: 'beta' },
  { slug: 'vaping',     name: 'Vaping',     description: 'Vaping and e-cigarette sites',       group: 'beta' },
  { slug: 'whatsapp',   name: 'WhatsApp',   description: 'WhatsApp domains',                   group: 'beta' },
];

export function getDefaultCategoryUrl(slug) {
  return `https://blocklistproject.github.io/Lists/alt-version/${slug}-nl.txt`;
}

export function getCategoryUrl(slug) {
  return getDefaultCategoryUrl(slug);
}

export function getCategoryBySlug(slug) {
  return BLOCKLIST_CATEGORIES.find(c => c.slug === slug);
}
