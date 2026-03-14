#!/usr/bin/env bash
# test-dns-blocking.sh — Tests GeoIP and blocklist DNS blocking via CIDRella's dnsmasq
#
# This script performs DNS lookups only (no HTTP connections).
# It queries the local dnsmasq server and checks whether blocked domains
# return NXDOMAIN (or a redirect IP) as expected.
#
# All test domains are statically embedded. To regenerate, run:
#   ssh root@<cidrella-host> "sqlite3 /var/lib/cidrella/cidrella.db \
#     \"SELECT domain FROM blocklist_domains WHERE category_slug = '<slug>' ORDER BY RANDOM() LIMIT 20;\""
#
# Usage: ./scripts/test-dns-blocking.sh [dns-server-ip]
#        Default DNS server: 127.0.0.1
#
# Note: Must be run from a host with direct DNS (UDP 53) access to the
#       CIDRella server. WSL2 cannot reach LXC DNS due to NAT routing.

set -euo pipefail

DNS_SERVER="${1:-127.0.0.1}"
TIMEOUT=5

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

pass=0
fail=0
skip=0

# ── Helpers ─────────────────────────────────────────────────────────────

query_dns() {
  local domain="$1"
  local raw
  raw=$(dig +time="$TIMEOUT" +tries=1 "@${DNS_SERVER}" "$domain" A 2>/dev/null) || true
  dns_answer=$(echo "$raw" | grep -A1 'ANSWER SECTION' | tail -1 | awk '{print $NF}') || true
  dns_status=$(echo "$raw" | grep -o 'status: [A-Z]*' | head -1 | cut -d' ' -f2) || true
  dns_status="${dns_status:-UNKNOWN}"
  [[ -z "$dns_answer" || "$dns_answer" == ";;"* ]] && dns_answer="" || true
}

expect_blocked() {
  local domain="$1" category="$2"
  query_dns "$domain"
  if [[ "$dns_status" == "UNKNOWN" ]]; then
    echo -e "  ${YELLOW}SKIP${RESET}  ${domain}  ${DIM}(no response from server)${RESET}"
    (( skip++ )) || true
  elif [[ "$dns_status" == "NXDOMAIN" ]] || [[ "$dns_answer" == "0.0.0.0" ]]; then
    echo -e "  ${GREEN}PASS${RESET}  ${domain}  ${DIM}(${dns_status})${RESET}"
    (( pass++ )) || true
  elif [[ "$dns_status" == "NOERROR" ]]; then
    echo -e "  ${RED}FAIL${RESET}  ${domain}  → ${dns_answer}  ${DIM}(${dns_status} — expected block)${RESET}"
    (( fail++ )) || true
  else
    echo -e "  ${YELLOW}SKIP${RESET}  ${domain}  ${DIM}(${dns_status})${RESET}"
    (( skip++ )) || true
  fi
}

expect_allowed() {
  local domain="$1" note="$2"
  query_dns "$domain"
  if [[ "$dns_status" == "NOERROR" && -n "$dns_answer" ]]; then
    echo -e "  ${GREEN}PASS${RESET}  ${domain}  → ${dns_answer}  ${DIM}(${note})${RESET}"
    (( pass++ )) || true
  elif [[ "$dns_status" == "NXDOMAIN" ]]; then
    echo -e "  ${RED}FAIL${RESET}  ${domain}  ${DIM}(NXDOMAIN — expected to resolve; ${note})${RESET}"
    (( fail++ )) || true
  else
    echo -e "  ${YELLOW}SKIP${RESET}  ${domain}  ${DIM}(${dns_status}; ${note})${RESET}"
    (( skip++ )) || true
  fi
}

expect_geoip_blocked() {
  local domain="$1" country="$2"
  query_dns "$domain"
  if [[ "$dns_status" == "UNKNOWN" ]]; then
    echo -e "  ${YELLOW}SKIP${RESET}  ${domain}  ${DIM}(no response from server; ${country})${RESET}"
    (( skip++ )) || true
  elif [[ "$dns_status" == "NXDOMAIN" ]] || [[ "$dns_status" == "NOERROR" && -z "$dns_answer" ]]; then
    echo -e "  ${GREEN}PASS${RESET}  ${domain}  ${DIM}(${dns_status} empty — ${country} blocked)${RESET}"
    (( pass++ )) || true
  elif [[ "$dns_status" == "NOERROR" && -n "$dns_answer" ]]; then
    echo -e "  ${RED}FAIL${RESET}  ${domain}  → ${dns_answer}  ${DIM}(resolved — expected GeoIP block for ${country})${RESET}"
    (( fail++ )) || true
  else
    echo -e "  ${YELLOW}SKIP${RESET}  ${domain}  ${DIM}(${dns_status}; ${country})${RESET}"
    (( skip++ )) || true
  fi
}

print_header() {
  echo ""
  echo -e "${BOLD}$1${RESET}"
  echo "─────────────────────────────────────────────────────"
}

run_category() {
  local category="$1"
  shift
  print_header "BLOCKLIST: ${category} (${#} domains)"
  for d in "$@"; do
    expect_blocked "$d" "$category"
  done
}

run_geoip() {
  local cc="$1"
  shift
  print_header "GEOIP: ${cc} (${#} domains)"
  for d in "$@"; do
    expect_geoip_blocked "$d" "$cc"
  done
}

# ── Main ────────────────────────────────────────────────────────────────

if ! command -v dig &>/dev/null; then
  echo -e "${RED}Error: 'dig' not found. Install with: sudo apt install dnsutils${RESET}"
  exit 1
fi

echo ""
echo -e "${BOLD}CIDRella DNS Blocking Test${RESET}"
echo "═══════════════════════════════════════════════════════"
echo -e "DNS Server:  ${CYAN}${DNS_SERVER}${RESET}"
echo -e "Timestamp:   $(date -Iseconds)"
echo ""

echo -n "Checking DNS server reachability... "
if dig +short +time=2 +tries=1 "@${DNS_SERVER}" google.com A &>/dev/null; then
  echo -e "${GREEN}OK${RESET}"
else
  echo -e "${RED}UNREACHABLE${RESET}"
  echo "Cannot reach DNS server at ${DNS_SERVER}. Aborting."
  exit 1
fi

# ════════════════════════════════════════════════════════════════════════
# BLOCKLIST TESTS — static domains pulled from CIDRella DB
# ════════════════════════════════════════════════════════════════════════

run_category "malware" \
  af0jrpm70o.neliver.com \
  pnh9fq9bvlbfpnych.gdn \
  whenwordscountretreat.com \
  aubedutemps.info \
  7438.info \
  jewuqyjywyv.eu \
  celebrityandmodels.com \
  kasrl.org \
  halenessfitness.com \
  error-0oirh6.stream \
  freeload.pinoymms.tk \
  hg2710.com \
  tellsooner.tk \
  ncsmichigan.com \
  duxyrxhfwilv.com \
  albatros-projekt.info \
  computer-99by9.stream \
  fedraquintanilla.cmail5.com \
  001games.com \
  007guard.com

run_category "phishing" \
  cho.co.th \
  dex-huobiglo.info \
  partnersupport-lnstagram.com \
  applecloud2159.com \
  lexinfusion.com \
  jejesagency.com \
  lefansquoise.ga \
  prefaciocursos.com.br \
  mutually.cf \
  hibcoprotector.com \
  transosonic.com \
  vr-login-freischalten.com \
  bulgachev.ru \
  mvnpdevelopment.com \
  athodesigns.com \
  dremsm.gob.pe \
  dhisw.edu.eg \
  oklahomasbestpropertymanagement.com \
  0ft439d-amazon.com \
  accounts-google-com.com

run_category "ransomware" \
  27lelchgcvs2wpm7.rt4e34.win \
  vyohacxzoue32vvk.2hr4fs.top \
  cerberhhyed5frqa.xltnet.win \
  52uo5k3t73ypjije.86rhzr.bid \
  vyohacxzoue32vvk.xsf5a8.top \
  52uo5k3t73ypjije.8a0sf6.top \
  unocl45trpuoefft.na2iuz.bid \
  4kqd3hmqgptupi3p.6ntrb6.top \
  zjfq4lnfbs7pncr5.tor2web.org \
  oqwygprskqv65j72.1j1x2b.top \
  p27dokhpz2n7nvgr.1m3xsy.top \
  52uo5k3t73ypjije.b8ll6n.top \
  4kqd3hmqgptupi3p.v11z5e.top \
  cerberhhyed5frqa.fgfid6.win \
  52uo5k3t73ypjije.68xmf9.bid \
  p27dokhpz2n7nvgr.12hxjv.top \
  kbv5s.kylepasse.at \
  ffoqr3ug7m726zou.ukswcu.bid \
  unocl45trpuoefft.0kousz.bid \
  cerberhhyed5frqa.lfotp5.top

run_category "redirect" \
  coolprox.com \
  hidebill.info \
  goldshop.ga \
  smellstock.tk \
  collegeproxy91.cn \
  schoolwebserver.info \
  quittingsafesurf.info \
  trsohbet.com \
  widedeposit.tk \
  oldold.cf \
  usanowanonymous20web.tk \
  physique4ever.com \
  free-justunlock65.tk \
  elite-surfing.info \
  mode5.info \
  xzzzzz.info \
  reliableproxy.com \
  peaktensionproxy.tk \
  surfvisa.co.cc \
  ineforex.co.cc

run_category "scam" \
  automatedequity.com \
  chipteeamz.com \
  poweradblocker.com \
  easyshoppingus.com \
  fastpayoption.com \
  escoptions.com \
  fxcryptomine.com \
  directtrade24.com \
  connectwalletnow.com \
  friday99.com \
  trade-option.org \
  arvetellefsen.no \
  prdapp3-as2.qualityhealth.com \
  cdn2.qualityhealth.com \
  server.get-cracked.com \
  download.get-cracked.com \
  store.trendsharks.com \
  pjs.outlet.com \
  t.promotionsonlineusa.com \
  store.helpnanacenter.helpscoutdocs.com

run_category "tracking" \
  mkt3261.com \
  mkt683.com \
  mkt1315.com \
  trkyme.com \
  mkt173.com \
  brilig.com \
  mkt5444.com \
  ctd001.net \
  mkt948.com \
  21sme.com \
  mkt2753.com \
  mkt6809.com \
  tracking.mediabeam.com \
  mkt3920.com \
  rtbconnect.biz \
  mkt380.com \
  mkt8553.com \
  ninjapd.com \
  mkt4325.com \
  countess.twitch.tv

# ── Blocklist control: should resolve normally ──
print_header "BLOCKLIST: Control (should resolve normally)"
for d in google.com github.com cloudflare.com wikipedia.org ubuntu.com; do
  expect_allowed "$d" "not on blocklist"
done

# ════════════════════════════════════════════════════════════════════════
# GEOIP TESTS — well-known domains hosted in blocked countries
# Preference: government, state media, banks, telecoms (avoid CDN-fronted sites)
# ════════════════════════════════════════════════════════════════════════

# CN: Government, state media, domestic portals (behind Great Firewall)
run_geoip "CN" \
  taobao.com baidu.com qq.com 163.com sohu.com sina.com.cn \
  people.com.cn jd.com cctv.com huanqiu.com csdn.net \
  iqiyi.com youku.com douyin.com weibo.com cnki.net \
  icbc.com.cn ccb.com boc.cn chinatelecom.com.cn

# RU: Government, state media, banks (hosted on RU infra)
run_geoip "RU" \
  kremlin.ru government.ru yandex.ru mail.ru vk.com ok.ru \
  ria.ru tass.ru rbc.ru lenta.ru gazeta.ru nalog.gov.ru \
  kommersant.ru rambler.ru sberbank.ru vtb.ru cbr.ru \
  rostelecom.ru mos.ru gosuslugi.ru

# IR: Government, state news agencies, domestic portals
run_geoip "IR" \
  president.ir leader.ir isna.ir irna.ir farsnews.ir \
  tasnimnews.com yjc.ir khabaronline.ir tabnak.ir mashreghnews.ir \
  hamshahrionline.ir alef.ir entekhab.ir mehrnews.com asriran.com \
  tebyan.net ict.gov.ir irandoc.ac.ir pbo.ir cbi.ir

# KP: Very few domains exist (all on 175.45.176.0/22, often unreachable)
print_header "GEOIP: KP (5 domains)"
echo -e "  ${DIM}Note: KP domains are frequently unreachable — SKIPs expected.${RESET}"
for d in star.co.kp kcna.kp naenara.com.kp rodong.rep.kp ma.gov.kp; do
  expect_geoip_blocked "$d" "KP"
done

# ── GeoIP control: should resolve normally ──
print_header "GEOIP: Control (US/EU — should resolve normally)"
for d in google.com github.com cloudflare.com bbc.co.uk lemonde.fr; do
  expect_allowed "$d" "US/EU — not geo-blocked"
done

# ════════════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════════════

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${BOLD}Results${RESET}"
echo "═══════════════════════════════════════════════════════"
total=$((pass + fail + skip))
echo -e "  ${GREEN}Passed:  ${pass}${RESET}"
echo -e "  ${RED}Failed:  ${fail}${RESET}"
echo -e "  ${YELLOW}Skipped: ${skip}${RESET}"
echo -e "  Total:   ${total}"
echo ""

if [[ $fail -gt 0 ]]; then
  echo -e "${RED}Some tests failed.${RESET} Check that:"
  echo "  - Blocklist is enabled and lists are downloaded"
  echo "  - GeoIP is enabled and the DNS proxy is running"
  echo "  - dnsmasq is running and reachable at ${DNS_SERVER}"
  exit 1
elif [[ $skip -gt $((total / 3)) ]]; then
  echo -e "${YELLOW}Many tests skipped — DNS resolution issues or domains expired.${RESET}"
  exit 0
else
  echo -e "${GREEN}All tests passed.${RESET}"
  exit 0
fi
