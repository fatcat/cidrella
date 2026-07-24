// Curated, offline device/OS fingerprint ruleset. Tunable in one place.
// Each rule contributes a candidate {device_type?, os_family?, confidence}; the
// classifier (utils/device-classifier.js) combines candidates across signals.
//
// Signals, strongest→weakest: DHCP option 60 (vendor class), option 55
// (parameter-request-list signature), supplied hostname, MAC OUI vendor.

// DHCP option 60 (vendor class identifier), substring match (case-insensitive).
export const OPT60_RULES = [
  { test: /MSFT/i,           os_family: 'Windows',   device_type: 'Computer',   confidence: 85 },
  { test: /android-dhcp/i,   os_family: 'Android',   device_type: 'Smartphone', confidence: 85 },
  { test: /dhcpcd/i,         os_family: 'Linux',     device_type: 'Computer',   confidence: 55 },
  { test: /\budhcp/i,        os_family: 'Linux',     device_type: 'IoT',        confidence: 45 },
  { test: /PXEClient/i,                              device_type: 'Computer',   confidence: 40 },
  { test: /\bHP\b|Hewlett|JetDirect/i,              device_type: 'Printer',    confidence: 50 },
];

// DHCP option 55 (parameter request list), exact match on the normalized csv.
// Order is OS-specific and fairly stable, so an exact hit is a strong signal.
export const OPT55_SIGNATURES = [
  { fp: '1,3,6,15,31,33,43,44,46,47,121,249,252', os_family: 'Windows',   device_type: 'Computer',   confidence: 80 },
  { fp: '1,15,3,6,44,46,47,31,33,121,249,43',     os_family: 'Windows',   device_type: 'Computer',   confidence: 75 },
  { fp: '1,121,3,6,15,119,252,95,44,46',          os_family: 'macOS',     device_type: 'Computer',   confidence: 75 },
  { fp: '1,121,3,6,15,119,252',                   os_family: 'Apple iOS', device_type: 'Smartphone', confidence: 70 },
  { fp: '1,3,6,15,119,252',                       os_family: 'Apple iOS', device_type: 'Smartphone', confidence: 60 },
  { fp: '1,3,6,15,26,28,51,58,59,43',             os_family: 'Android',   device_type: 'Smartphone', confidence: 70 },
  { fp: '1,33,3,6,15,26,28,51,58,59,43,114',      os_family: 'Android',   device_type: 'Smartphone', confidence: 72 },
];

// Supplied hostname, regex match (case-insensitive).
export const HOSTNAME_RULES = [
  { test: /(^|[-_.])android/i,                 os_family: 'Android',   device_type: 'Smartphone', confidence: 70 },
  { test: /iphone/i,                           os_family: 'Apple iOS', device_type: 'Smartphone', confidence: 75 },
  { test: /ipad/i,                             os_family: 'Apple iOS', device_type: 'Tablet',     confidence: 75 },
  { test: /(macbook|imac|mac-?mini|\bmbp\b|\bmba\b)/i, os_family: 'macOS', device_type: 'Computer', confidence: 70 },
  { test: /desktop-/i,                         os_family: 'Windows',   device_type: 'Computer',   confidence: 65 },
  { test: /(raspberry|raspberrypi|\brpi\b)/i,  os_family: 'Linux',     device_type: 'Computer',   confidence: 65 },
  { test: /(chromecast|google-?home|nest)/i,                           device_type: 'IoT',        confidence: 60 },
  { test: /(roku|fire-?tv|apple-?tv|shield)/i,                         device_type: 'Media',      confidence: 60 },
  { test: /(printer|epson|canon|brother)/i,                            device_type: 'Printer',    confidence: 65 },
];

// MAC OUI vendor string (from mac-vendor lookup), weak corroborating signal.
export const OUI_RULES = [
  { test: /hikvision|dahua|axis comm/i,                                device_type: 'IP Camera', confidence: 65 },
  { test: /espressif|tuya|shelly|sonoff/i,                             device_type: 'IoT',       confidence: 60 },
  { test: /raspberry/i,                         os_family: 'Linux',    device_type: 'Computer',  confidence: 55 },
  { test: /ubiquiti|mikrotik|aruba|\bcisco\b|netgear|tp-link/i,        device_type: 'Network',   confidence: 45 },
  { test: /hewlett|hp inc|brother|epson|canon|lexmark/i,              device_type: 'Printer',   confidence: 40 },
];
