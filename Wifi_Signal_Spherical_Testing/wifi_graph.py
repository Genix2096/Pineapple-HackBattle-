"""
Utilities to convert RSSI to estimated distance and to prepare
(distance, strength) points for plotting.

The RSSI→distance uses a simple log-distance path loss model.
This is a rough estimate and depends on environment and band.
"""
from __future__ import annotations
from typing import List, Dict, Any


def rssi_to_distance(rssi: float, band: str | None = None) -> float:
    """Convert RSSI (dBm) to approximate distance (meters).

    Log-distance path loss model:
      d = 10^((P0 - RSSI) / (10 * n))
    Where:
      - P0: reference RSSI at 1 meter (depends on band)
      - n: path loss exponent (environment-dependent)

    Heuristics used here aim for more realistic indoor estimates:
      - 2.4 GHz: P0 ≈ -40 dBm, n ≈ 2.2
      - 5 GHz:   P0 ≈ -47 dBm, n ≈ 2.7
    These are still rough and for visualization only.
    """
    try:
        rssi = float(rssi)
    except Exception:
        return 0.0
    b = (band or '').strip()
    if b == '5 GHz':
        n = 2.7
        p0 = -47.0
    elif b == '2.4 GHz':
        n = 2.2
        p0 = -40.0
    else:
        # Fallback if band unknown
        n = 2.4
        p0 = -43.0
    d = 10 ** ((p0 - rssi) / (10.0 * n))
    # Clamp to sensible bounds for visualization (typical indoor/outdoor mix)
    if d < 0.0:
        d = 0.0
    if d > 200.0:
        d = 200.0
    return d


def prepare_distance_strength(networks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Map parsed networks to points for distance-strength graph.

    Input networks are expected to contain keys: rssi, band, ssid, bssid.
    Output points list contains: distance (m), rssi (dBm), band, ssid, bssid.
    """
    points: List[Dict[str, Any]] = []
    for n in networks or []:
        rssi = n.get('rssi')
        band = n.get('band')
        if rssi is None:
            continue
        dist = rssi_to_distance(rssi, band)
        points.append({
            'distance': dist,
            'rssi': float(rssi),
            'band': band,
            'ssid': n.get('ssid'),
            'bssid': n.get('bssid'),
        })
    # Sort by distance ascending for nicer plotting on client
    points.sort(key=lambda p: p['distance'])
    return points
