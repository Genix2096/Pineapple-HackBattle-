import json
import os
import random
from typing import Dict, Any, Tuple

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
GPS_ORIGINAL = os.path.join(DATA_DIR, 'gps_original.json')
GPS_COPY1 = os.path.join(DATA_DIR, 'gps_copy1.json')
GPS_COPY2 = os.path.join(DATA_DIR, 'gps_copy2.json')
WIFI_ORIGINAL = os.path.join(DATA_DIR, 'wifi_original.json')
WIFI_COPY1 = os.path.join(DATA_DIR, 'wifi_copy1.json')
WIFI_COPY2 = os.path.join(DATA_DIR, 'wifi_copy2.json')


def ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)


def save_json(path: str, data: Any):
    ensure_data_dir()
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


def load_json(path: str) -> Any:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def meters_to_deg_offsets(meters: float, lat: float) -> Tuple[float, float]:
    # Approximate conversion near given latitude
    dlat = meters / 111_320.0
    dlon = meters / (40075000.0 * (abs(lat) if lat != 0 else 0.0001) / 360.0)
    return dlat, dlon


def fabricate_coords(base_lat: float, base_lon: float, max_offset_m: float = 8.0) -> Tuple[float, float]:
    # Random small offset within circle of radius max_offset_m
    r = random.uniform(1.0, max_offset_m)
    theta = random.uniform(0, 6.283185307)
    dlat_m, dlon_m = r * 0.7, r  # slight anisotropy
    dlat, dlon = meters_to_deg_offsets(dlat_m, base_lat)[0], meters_to_deg_offsets(dlon_m, base_lat)[1]
    return base_lat + dlat * (1 if random.random()>0.5 else -1), base_lon + dlon * (1 if random.random()>0.5 else -1)


def save_original_gps(lat: float, lon: float) -> Dict[str, Any]:
    data = {"lat": lat, "lon": lon, "label": "Original"}
    save_json(GPS_ORIGINAL, data)
    return data


def generate_gps_copies(lat: float, lon: float) -> Dict[str, Any]:
    lat1, lon1 = fabricate_coords(lat, lon)
    lat2, lon2 = fabricate_coords(lat, lon)
    data1 = {"lat": lat1, "lon": lon1, "label": "Copy1"}
    data2 = {"lat": lat2, "lon": lon2, "label": "Copy2"}
    save_json(GPS_COPY1, data1)
    save_json(GPS_COPY2, data2)
    return {"copy1": data1, "copy2": data2}


def save_original_wifi(wifi_data: Dict[str, Any]) -> Dict[str, Any]:
    # wifi_data expected to have list under 'networks'
    tagged = {"label": "Original", **wifi_data}
    save_json(WIFI_ORIGINAL, tagged)
    return tagged


def fabricate_wifi_copy(wifi_data: Dict[str, Any]) -> Dict[str, Any]:
    # Apply small realistic variations to RSSI and signal_percent
    import copy
    new_data = copy.deepcopy(wifi_data)
    new_data["label"] = "Copy"
    for n in new_data.get("networks", []):
        # random RSSI fluctuation within ±5 dBm, bounded
        if n.get("rssi") is not None:
            dr = random.randint(-5, 5)
            n["rssi"] = int(max(-95, min(-25, n["rssi"] + dr)))
        if n.get("signal_percent") is not None:
            dp = random.randint(-8, 8)
            n["signal_percent"] = int(max(1, min(100, n["signal_percent"] + dp)))
    return new_data


def generate_wifi_copies(wifi_data: Dict[str, Any]) -> Dict[str, Any]:
    copy1 = fabricate_wifi_copy(wifi_data)
    copy1["label"] = "Copy1"
    copy2 = fabricate_wifi_copy(wifi_data)
    copy2["label"] = "Copy2"
    save_json(WIFI_COPY1, copy1)
    save_json(WIFI_COPY2, copy2)
    return {"copy1": copy1, "copy2": copy2}


def list_data_files() -> Dict[str, str]:
    ensure_data_dir()
    return {
        "gps_original": GPS_ORIGINAL,
        "gps_copy1": GPS_COPY1,
        "gps_copy2": GPS_COPY2,
        "wifi_original": WIFI_ORIGINAL,
        "wifi_copy1": WIFI_COPY1,
        "wifi_copy2": WIFI_COPY2,
    }
