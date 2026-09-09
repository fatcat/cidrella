function ipv4Number(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error(`Invalid oracle IPv4 address: ${ip}`);
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function ipv4Text(value) {
  return [24, 16, 8, 0].map(shift => Math.floor(value / (2 ** shift)) % 256).join('.');
}

export function expectedIpv4Split(cidr, targetPrefix, gatewayPolicy) {
  const [address, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const parentSize = 2 ** (32 - prefix);
  const childSize = 2 ** (32 - targetPrefix);
  const base = Math.floor(ipv4Number(address) / parentSize) * parentSize;
  const results = [];
  for (let offset = 0; offset < parentSize; offset += childSize) {
    const network = base + offset;
    const broadcast = network + childSize - 1;
    results.push({
      cidr: `${ipv4Text(network)}/${targetPrefix}`,
      network: ipv4Text(network),
      broadcast: ipv4Text(broadcast),
      gateway: gatewayPolicy === 'first' ? ipv4Text(network + 1)
        : gatewayPolicy === 'last' ? ipv4Text(broadcast - 1) : null
    });
  }
  return results;
}

export function numericIpv4(ip) {
  return ipv4Number(ip);
}
