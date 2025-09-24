import subprocess
import json
import re
from typing import List, Dict

# Windows-only RSSI retrieval via netsh. No external dependencies.
# Parses: SSID, BSSID (MAC), Signal (RSSI), Channel, Frequency band, Security/Authentication, and estimates WiFi standard.

NETSH_CMD = [
    "netsh", "wlan", "show", "networks", "mode=bssid"
]

SSID_RE = re.compile(r"^\s*SSID\s+\d+\s*:\s*(.*)\s*$", re.I)
BSSID_RE = re.compile(r"^\s*BSSID\s+\d+\s*:\s*([0-9A-Fa-f:]{17})\s*$")
SIG_RE = re.compile(r"^\s*Signal\s*:\s*(\d+)%\s*$", re.I)
CHAN_RE = re.compile(r"^\s*Channel\s*:\s*(\d+)\s*$", re.I)
AUTH_RE = re.compile(r"^\s*Authentication\s*:\s*(.*)\s*$", re.I)
ENCR_RE = re.compile(r"^\s*Encryption\s*:\s*(.*)\s*$", re.I)


def percent_to_rssi(percent: int) -> int:
    """
    Convert Windows Wi-Fi percent to approximate RSSI in dBm.
    Empirical map: 100% ≈ -30 dBm, 0% ≈ -90 dBm, roughly linear-ish.
    """
    percent = max(0, min(100, int(percent)))
    # Linear map: -90 dBm at 0%, -30 dBm at 100%
    return int(-90 + (percent * (60 / 100)))


def channel_to_band(channel: int) -> str:
    if 1 <= channel <= 14:
        return "2.4 GHz"
    # Very rough grouping for 5 GHz common channels
    return "5 GHz" if 32 <= channel <= 196 else "Unknown"


def estimate_wifi_standard(channel: int, bandwidth_mhz: int | None = None) -> str:
    # Heuristic: 2.4 GHz channels → 802.11n (WiFi 4) or 802.11ax (WiFi 6)
    # 5 GHz channels → 802.11ac (WiFi 5) or 802.11ax (WiFi 6)
    if 1 <= channel <= 14:
        return "WiFi 4/6"
    if 32 <= channel <= 196:
        return "WiFi 5/6"
    return "Unknown"


def fetch_wifi_networks() -> List[Dict]:
    """Run netsh and parse networks to a structured list."""
    try:
        output = subprocess.check_output(NETSH_CMD, shell=False, text=True, encoding="utf-8", errors="ignore")
    except Exception as e:
        return []

    networks: List[Dict] = []
    current_ssid = None
    current_auth = None
    current_encr = None

    for line in output.splitlines():
        m = SSID_RE.match(line)
        if m:
            current_ssid = m.group(1).strip()
            current_auth = None
            current_encr = None
            continue
        m = AUTH_RE.match(line)
        if m:
            current_auth = m.group(1).strip()
            continue
        m = ENCR_RE.match(line)
        if m:
            current_encr = m.group(1).strip()
            continue
        m = BSSID_RE.match(line)
        if m and current_ssid:
            bssid = m.group(1).lower()
            networks.append({
                "ssid": current_ssid,
                "bssid": bssid,
                "signal_percent": None,
                "rssi": None,
                "channel": None,
                "band": None,
                "auth": current_auth,
                "encryption": current_encr,
                "wifi_standard": None,
            })
            continue
        m = SIG_RE.match(line)
        if m and networks:
            p = int(m.group(1))
            networks[-1]["signal_percent"] = p
            networks[-1]["rssi"] = percent_to_rssi(p)
            continue
        m = CHAN_RE.match(line)
        if m and networks:
            ch = int(m.group(1))
            networks[-1]["channel"] = ch
            networks[-1]["band"] = channel_to_band(ch)
            networks[-1]["wifi_standard"] = estimate_wifi_standard(ch)
            continue

    # Deduplicate BSSIDs and filter incomplete
    dedup = {}
    for n in networks:
        if n.get("bssid") and n.get("rssi") is not None:
            dedup[n["bssid"]] = n
    return list(dedup.values())


def main():
    data = fetch_wifi_networks()
    print(json.dumps({"networks": data}, indent=2))


if __name__ == "__main__":
    main()
