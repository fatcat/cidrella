#!/usr/bin/env python3
"""
Import Pi-hole DNS records and DHCP reservations into CIDRella.

Reads a Pi-hole pihole.toml config file and imports:
  - dns.hosts → A records in a forward DNS zone
  - dns.cnameRecords → CNAME records in the same zone
  - dhcp.hosts → DHCP reservations (matched to existing subnets)

Usage:
  python3 import-pihole.py <pihole.toml> <cidrella-url> [options]

Examples:
  python3 import-pihole.py pihole.toml https://cidrella.local:3443 -u admin -p admin
  python3 import-pihole.py pihole.toml https://10.0.3.232:3443 --dry-run
"""

import argparse
import getpass
import ipaddress
import json
import re
import ssl
import sys
import tomllib
import urllib.request
import urllib.error


# ── Helpers ──────────────────────────────────────────────────────────────────

def api(base_url, method, path, token=None, body=None, ctx=None):
    """Make an API request and return parsed JSON."""
    url = f"{base_url}/api{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, context=ctx) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        try:
            err_body = json.loads(err_body)
        except Exception:
            pass
        return {"_error": True, "_status": e.code, "_detail": err_body}


def login(base_url, username, password, ctx):
    """Authenticate and return JWT token."""
    result = api(base_url, "POST", "/auth/login", body={
        "username": username,
        "password": password
    }, ctx=ctx)
    if result.get("_error"):
        print(f"  ✗ Login failed: {result['_detail']}")
        sys.exit(1)
    return result["token"]


def parse_pihole_toml(path):
    """Parse pihole.toml and extract DNS hosts, CNAME records, and DHCP hosts."""
    with open(path, "rb") as f:
        cfg = tomllib.load(f)

    dns_hosts = []
    for entry in cfg.get("dns", {}).get("hosts", []):
        parts = entry.split(None, 1)
        if len(parts) == 2:
            ip, hostname = parts
            dns_hosts.append({"ip": ip, "hostname": hostname})

    cname_records = []
    for entry in cfg.get("dns", {}).get("cnameRecords", []):
        parts = entry.split(",")
        if len(parts) >= 2:
            cname_records.append({"alias": parts[0].strip(), "target": parts[1].strip()})

    dhcp_hosts = []
    for entry in cfg.get("dhcp", {}).get("hosts", []):
        parts = entry.split(",")
        if len(parts) >= 3:
            mac, ip, hostname = parts[0].strip(), parts[1].strip(), parts[2].strip()
            dhcp_hosts.append({"mac": mac, "ip": ip, "hostname": hostname})

    return dns_hosts, cname_records, dhcp_hosts


def detect_zone_name(dns_hosts, cname_records):
    """Detect the common domain from hostnames."""
    all_names = [h["hostname"] for h in dns_hosts] + [c["alias"] for c in cname_records]
    if not all_names:
        return None
    # Find the longest common domain suffix
    parts_list = [name.split(".") for name in all_names]
    min_len = min(len(p) for p in parts_list)
    common = []
    for i in range(1, min_len + 1):
        segment = parts_list[0][-i]
        if all(p[-i] == segment for p in parts_list):
            common.insert(0, segment)
        else:
            break
    return ".".join(common) if common else None


def record_name(hostname, zone_name):
    """Strip zone suffix from hostname to get the record name."""
    if hostname == zone_name:
        return "@"
    suffix = f".{zone_name}"
    if hostname.endswith(suffix):
        return hostname[:-len(suffix)]
    return hostname


def ip_in_cidr(ip_str, cidr_str):
    """Check if an IP is within a CIDR range."""
    try:
        return ipaddress.ip_address(ip_str) in ipaddress.ip_network(cidr_str, strict=False)
    except ValueError:
        return False


def flatten_subnets(folders_data):
    """Recursively flatten the nested subnet tree from the API response."""
    subnets = []
    for folder in folders_data.get("folders", []):
        for subnet in folder.get("subnets", []):
            _collect_subnets(subnet, subnets)
    return subnets


def _collect_subnets(node, acc):
    acc.append(node)
    for child in node.get("children", []):
        _collect_subnets(child, acc)


def find_subnet_for_ip(ip_str, subnets):
    """Find the most specific (longest prefix) subnet containing the IP."""
    best = None
    for s in subnets:
        cidr = s.get("cidr") or f"{s.get('network_address')}/{s.get('prefix_length')}"
        if ip_in_cidr(ip_str, cidr):
            pl = s.get("prefix_length", 0)
            if best is None or pl > best.get("prefix_length", 0):
                best = s
    return best


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Import Pi-hole DNS & DHCP config into CIDRella"
    )
    parser.add_argument("toml_file", help="Path to pihole.toml")
    parser.add_argument("url", help="CIDRella base URL (e.g. https://10.0.3.232:3443)")
    parser.add_argument("-u", "--username", default="admin", help="CIDRella username (default: admin)")
    parser.add_argument("-p", "--password", help="CIDRella password (prompted if omitted)")
    parser.add_argument("-z", "--zone", help="Force DNS zone name (auto-detected if omitted)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be imported without making changes")
    parser.add_argument("--skip-dns", action="store_true", help="Skip DNS record import")
    parser.add_argument("--skip-dhcp", action="store_true", help="Skip DHCP reservation import")
    parser.add_argument("--no-verify-ssl", action="store_true", help="Disable TLS certificate verification")
    args = parser.parse_args()

    # SSL context
    ctx = None
    if args.no_verify_ssl:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    # Password
    password = args.password or getpass.getpass(f"Password for {args.username}: ")

    # ── Parse ────────────────────────────────────────────────────────────
    print(f"\n── Parsing {args.toml_file}")
    dns_hosts, cname_records, dhcp_hosts = parse_pihole_toml(args.toml_file)
    print(f"  Found {len(dns_hosts)} A records, {len(cname_records)} CNAMEs, {len(dhcp_hosts)} DHCP reservations")

    zone_name = args.zone or detect_zone_name(dns_hosts, cname_records)
    if not zone_name and not args.skip_dns:
        print("  ✗ Could not auto-detect zone name. Use --zone to specify.")
        sys.exit(1)
    if zone_name:
        print(f"  Zone: {zone_name}")

    if args.dry_run:
        print("\n── Dry run — showing planned imports\n")
        if not args.skip_dns:
            print("  DNS A records:")
            for h in dns_hosts:
                name = record_name(h["hostname"], zone_name)
                print(f"    {name:40s} A    {h['ip']}")
            print("  DNS CNAME records:")
            for c in cname_records:
                name = record_name(c["alias"], zone_name)
                target = c["target"]
                # Strip zone suffix from target if same zone
                if target.endswith(f".{zone_name}"):
                    target = target[:-len(f".{zone_name}")]
                print(f"    {name:40s} CNAME {target}")
        if not args.skip_dhcp:
            print("  DHCP reservations:")
            for d in dhcp_hosts:
                print(f"    {d['mac']:20s} {d['ip']:16s} {d['hostname']}")
        print("\n  Re-run without --dry-run to import.")
        return

    # ── Authenticate ─────────────────────────────────────────────────────
    print(f"\n── Logging in to {args.url}")
    token = login(args.url, args.username, password, ctx)
    print("  ✓ Authenticated")

    # ── DNS Import ───────────────────────────────────────────────────────
    if not args.skip_dns:
        print(f"\n── Importing DNS records into zone '{zone_name}'")

        # Find or create zone
        zones = api(args.url, "GET", "/dns/zones", token, ctx=ctx)
        if isinstance(zones, dict) and zones.get("_error"):
            print(f"  ✗ Failed to list zones: {zones['_detail']}")
            sys.exit(1)

        zone = next((z for z in zones if z["name"] == zone_name and z["type"] == "forward"), None)

        if zone:
            print(f"  Using existing zone: {zone_name} (id={zone['id']})")
        else:
            print(f"  Creating zone: {zone_name}")
            zone = api(args.url, "POST", "/dns/zones", token, body={
                "name": zone_name,
                "type": "forward"
            }, ctx=ctx)
            if zone.get("_error"):
                print(f"  ✗ Failed to create zone: {zone['_detail']}")
                sys.exit(1)
            print(f"  ✓ Created zone (id={zone['id']})")

        zone_id = zone["id"]

        # Fetch existing records to avoid duplicates
        zone_detail = api(args.url, "GET", f"/dns/zones/{zone_id}", token, ctx=ctx)
        existing = set()
        if not zone_detail.get("_error"):
            for r in zone_detail.get("records", []):
                existing.add((r["type"], r["name"], r["value"]))

        # Import A records
        a_ok, a_skip, a_fail = 0, 0, 0
        for h in dns_hosts:
            name = record_name(h["hostname"], zone_name)
            if ("A", name, h["ip"]) in existing:
                a_skip += 1
                continue
            result = api(args.url, "POST", f"/dns/zones/{zone_id}/records", token, body={
                "name": name,
                "type": "A",
                "value": h["ip"]
            }, ctx=ctx)
            if result.get("_error"):
                print(f"    ✗ A {name} → {h['ip']}: {result['_detail']}")
                a_fail += 1
            else:
                a_ok += 1
                existing.add(("A", name, h["ip"]))
        print(f"  A records:     {a_ok} created, {a_skip} skipped (exist), {a_fail} failed")

        # Import CNAME records
        c_ok, c_skip, c_fail = 0, 0, 0
        for c in cname_records:
            name = record_name(c["alias"], zone_name)
            # CNAME value is the full target domain
            target = c["target"]
            if ("CNAME", name, target) in existing:
                c_skip += 1
                continue
            result = api(args.url, "POST", f"/dns/zones/{zone_id}/records", token, body={
                "name": name,
                "type": "CNAME",
                "value": target
            }, ctx=ctx)
            if result.get("_error"):
                print(f"    ✗ CNAME {name} → {target}: {result['_detail']}")
                c_fail += 1
            else:
                c_ok += 1
                existing.add(("CNAME", name, target))
        print(f"  CNAME records: {c_ok} created, {c_skip} skipped (exist), {c_fail} failed")

    # ── DHCP Import ──────────────────────────────────────────────────────
    if not args.skip_dhcp:
        print(f"\n── Importing DHCP reservations")

        # Fetch subnets to match IPs
        subnet_data = api(args.url, "GET", "/subnets", token, ctx=ctx)
        if subnet_data.get("_error"):
            print(f"  ✗ Failed to list subnets: {subnet_data['_detail']}")
            sys.exit(1)

        all_subnets = flatten_subnets(subnet_data)
        # Only consider allocated (configured) leaf subnets
        leaf_subnets = [s for s in all_subnets if s.get("child_count", 0) == 0]

        if not leaf_subnets:
            print("  ✗ No subnets found in CIDRella. Create subnets first.")
            sys.exit(1)
        print(f"  Found {len(leaf_subnets)} leaf subnets to match against")

        # Fetch existing reservations
        existing_res = api(args.url, "GET", "/dhcp/reservations", token, ctx=ctx)
        if isinstance(existing_res, dict) and existing_res.get("_error"):
            existing_res = []
        existing_macs = {(r["subnet_id"], r["mac_address"].lower()) for r in existing_res}
        existing_ips = {(r["subnet_id"], r["ip_address"]) for r in existing_res}

        d_ok, d_skip, d_fail, d_no_subnet = 0, 0, 0, 0
        for d in dhcp_hosts:
            mac = d["mac"].lower()
            # Normalize MAC: strip leading "01:" client-id prefix if present
            mac_parts = mac.split(":")
            if len(mac_parts) == 7 and mac_parts[0] == "01":
                mac = ":".join(mac_parts[1:])

            subnet = find_subnet_for_ip(d["ip"], leaf_subnets)
            if not subnet:
                print(f"    ⚠ No subnet found for {d['ip']} ({d['hostname']}) — skipping")
                d_no_subnet += 1
                continue

            sid = subnet["id"]
            if (sid, mac) in existing_macs or (sid, d["ip"]) in existing_ips:
                d_skip += 1
                continue

            result = api(args.url, "POST", "/dhcp/reservations", token, body={
                "subnet_id": sid,
                "mac_address": mac,
                "ip_address": d["ip"],
                "hostname": d["hostname"],
                "description": "Imported from Pi-hole"
            }, ctx=ctx)
            if result.get("_error"):
                cidr = f"{subnet.get('network_address')}/{subnet.get('prefix_length')}"
                print(f"    ✗ {mac} → {d['ip']} (subnet {cidr}): {result['_detail']}")
                d_fail += 1
            else:
                d_ok += 1
                existing_macs.add((sid, mac))
                existing_ips.add((sid, d["ip"]))
        print(f"  Reservations:  {d_ok} created, {d_skip} skipped (exist), {d_fail} failed, {d_no_subnet} no matching subnet")

    # ── Done ─────────────────────────────────────────────────────────────
    print("\n── Import complete\n")


if __name__ == "__main__":
    main()
