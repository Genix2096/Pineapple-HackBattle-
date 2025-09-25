"""
WiFi Coverage and Deadzone Visualization Server

- Serves a web-based interface showing probabilistic zones for WiFi networks.
- Highlights nodes, estimated coverage zones, and dead zones.
- Aggregates data from multiple static nodes sending JSON scan data.
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
import json
import os
import time
from typing import Dict, List, Tuple
import math

ROOT_DIR = os.path.dirname(__file__)
WEB_DIR = os.path.join(ROOT_DIR, 'web')  # Serve static HTML/JS from here
DATA_DIR = os.path.join(ROOT_DIR, 'data')

# --- In-memory Storage ---
client_scan_data: Dict[str, List[dict]] = {}  # laptop_id -> list of network scans
client_last_seen: Dict[str, float] = {}
client_fixed_positions: Dict[str, Tuple[float, float]] = {}  # optional: client-provided

ACTIVE_TIMEOUT_SEC = 10.0

# Grid configuration
GRID_WIDTH = 30.0  # meters
GRID_HEIGHT = 30.0
CELL_SIZE = 1.0  # meters
GRID_COLS = int(GRID_WIDTH / CELL_SIZE)
GRID_ROWS = int(GRID_HEIGHT / CELL_SIZE)

SERVER_POS = {"x": GRID_WIDTH / 2, "y": GRID_HEIGHT / 2}

# RSSI → distance model
TX_POWER = -30.0
PATH_LOSS_EXP = 2.2

DEADZONE_THRESHOLD = -80  # RSSI below this is considered weak coverage


def rssi_to_distance(rssi_dbm: float, tx_power: float = TX_POWER, n: float = PATH_LOSS_EXP) -> float:
    """Estimate distance (meters) from RSSI using log-distance path loss."""
    try:
        exponent = (tx_power - rssi_dbm) / (10.0 * n)
        return 10 ** exponent
    except Exception:
        return GRID_WIDTH  # fallback large value


def active_clients() -> List[str]:
    now = time.time()
    return [cid for cid, ts in client_last_seen.items() if now - ts <= ACTIVE_TIMEOUT_SEC]


def default_anchor_positions(n: int = 3) -> List[Tuple[float, float]]:
    # Place anchors on a circle around the server center
    cx, cy = SERVER_POS["x"], SERVER_POS["y"]
    radius = min(GRID_WIDTH, GRID_HEIGHT) * 0.3
    out: List[Tuple[float, float]] = []
    for i in range(n):
        ang = (2*math.pi*i)/n
        out.append((cx + radius*math.cos(ang), cy + radius*math.sin(ang)))
    return out


def resolve_client_positions() -> Dict[str, Tuple[float, float]]:
    # If clients provide positions, use them; else assign deterministic anchors
    act = sorted(active_clients())
    pos: Dict[str, Tuple[float, float]] = {}
    anchors = default_anchor_positions(3)
    # Prefer provided fixed positions
    for cid in act:
        if cid in client_fixed_positions:
            pos[cid] = client_fixed_positions[cid]
    # Assign remaining up to 3
    for cid in act:
        if cid in pos:
            continue
        if len(pos) < 3:
            pos[cid] = anchors[len(pos)]
    return pos


def trilaterate_xy(points: List[Tuple[float, float, float]]) -> Tuple[float, float] | None:
    """
    Trilaterate from the first 3 circles using a closed-form 2x2 solve.
    points: list of (xi, yi, di)
    returns (x, y) or None on failure.
    """
    try:
        if len(points) < 3:
            return None
        (x1, y1, d1), (x2, y2, d2), (x3, y3, d3) = points[:3]
        A = 2*(x2 - x1)
        B = 2*(y2 - y1)
        C = d1**2 - d2**2 - x1**2 + x2**2 - y1**2 + y2**2
        D = 2*(x3 - x1)
        E = 2*(y3 - y1)
        F = d1**2 - d3**2 - x1**2 + x3**2 - y1**2 + y3**2
        denom = A*E - B*D
        if abs(denom) < 1e-6:
            return None
        x = (C*E - B*F) / denom
        y = (A*F - C*D) / denom
        return clamp_to_grid(x, y)
    except Exception:
        return None


def clamp_to_grid(x: float, y: float) -> Tuple[float, float]:
    cx = max(0.0, min(GRID_WIDTH, x))
    cy = max(0.0, min(GRID_HEIGHT, y))
    return cx, cy


def point_to_cell(x: float, y: float) -> Tuple[int, int]:
    x, y = clamp_to_grid(x, y)
    col = int(x // CELL_SIZE)
    row = int(y // CELL_SIZE)
    col = min(max(col, 0), GRID_COLS - 1)
    row = min(max(row, 0), GRID_ROWS - 1)
    return col, row


def compute_ap_positions():
    """
    Returns (aps, meta) where aps is a list of dicts with estimated AP positions:
      {bssid, ssid, band, x, y, distance, bearing_deg, rssi_avg}
    and meta contains client positions and active client ids.
    """
    # Enforce at least 3 active clients
    act = active_clients()
    cpos = resolve_client_positions()
    meta = {
        "active_clients": act,
        "client_positions": cpos,
        "enough_clients": len(cpos) >= 3
    }
    aps: List[dict] = []
    if len(cpos) < 3:
        return aps, meta

    # Build per-BSSID readings across clients (only active & positioned ones)
    by_bssid: Dict[str, Dict[str, dict]] = {}
    for cid, nets in client_scan_data.items():
        if cid not in cpos:
            continue
        for n in nets or []:
            bssid = n.get("bssid")
            if not bssid:
                continue
            entry = by_bssid.setdefault(bssid, {})
            # Keep strongest reading per client if duplicates
            prev = entry.get(cid)
            if prev is None or (isinstance(n.get("rssi"), (int, float)) and n.get("rssi", -999) > prev.get("rssi", -999)):
                entry[cid] = n

    cx, cy = SERVER_POS["x"], SERVER_POS["y"]
    for bssid, per_client in by_bssid.items():
        # Need at least 3 clients for this BSSID
        if len(per_client) < 3:
            continue
        pts: List[Tuple[float, float, float]] = []
        rssis: List[float] = []
        ssid_val = None
        band_val = None
        for cid, n in per_client.items():
            x, y = cpos[cid]
            rssi = n.get("rssi")
            if rssi is None:
                continue
            d = rssi_to_distance(float(rssi))
            pts.append((x, y, d))
            rssis.append(float(rssi))
            ssid_val = ssid_val or n.get("ssid")
            band_val = band_val or n.get("band")
        if len(pts) < 3:
            continue
        est = trilaterate_xy(pts)
        if not est:
            continue
        ex, ey = est
        dist_from_server = math.hypot(ex - cx, ey - cy)
        bearing = (math.degrees(math.atan2(ey - cy, ex - cx)) + 360.0) % 360.0
        aps.append({
            "bssid": bssid,
            "ssid": ssid_val,
            "band": band_val,
            "x": ex,
            "y": ey,
            "distance": dist_from_server,
            "bearing_deg": bearing,
            "rssi_avg": sum(rssis)/len(rssis) if rssis else None,
        })
    # Sort closest first for convenience
    aps.sort(key=lambda a: a.get("distance") or 1e9)
    return aps, meta


def aggregate_zones() -> Tuple[list, Dict[str, Tuple[int, int]]]:
    """
    Build a heatmap from estimated AP positions (trilaterated), and return
    node positions for active clients.
    """
    heatmap = [[0.0 for _ in range(GRID_COLS)] for _ in range(GRID_ROWS)]
    # Resolve client node positions (only actives, max 3)
    node_positions: Dict[str, Tuple[int, int]] = {}
    cpos = resolve_client_positions()
    for cid, (x, y) in cpos.items():
        col, row = point_to_cell(x, y)
        node_positions[cid] = (col, row)

    # Compute AP positions; if not enough clients, return empty heatmap
    aps, _ = compute_ap_positions()

    # Spread influence around each AP position
    for ap in aps:
        ax, ay = ap["x"], ap["y"]
        col, row = point_to_cell(ax, ay)
        est_radius_m = max(2.0, ap.get("distance", 5.0) * 0.6)
        radius_cells = max(1, int(est_radius_m / CELL_SIZE))
        for r in range(row - radius_cells, row + radius_cells + 1):
            if r < 0 or r >= GRID_ROWS:
                continue
            for c in range(col - radius_cells, col + radius_cells + 1):
                if c < 0 or c >= GRID_COLS:
                    continue
                dist = math.hypot(c - col, r - row)
                if dist <= radius_cells:
                    heatmap[r][c] += max(0.0, 1.0 - (dist / radius_cells))

    return heatmap, node_positions


def respond_json(handler: SimpleHTTPRequestHandler, status: int, data):
    payload = json.dumps(data).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(payload)))
    handler.send_header('Cache-Control', 'no-store')
    handler.end_headers()
    handler.wfile.write(payload)


class AppHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = path.split('?', 1)[0].split('#', 1)[0]
        rel = path.lstrip('/') or 'index.html'
        return os.path.join(WEB_DIR, *rel.split('/'))

    def do_GET(self):
        if self.path.startswith("/api/coverage"):
            aps, meta = compute_ap_positions()
            heatmap, node_positions = aggregate_zones()
            deadzone_mask = [[1 if cell <= 0.1 else 0 for cell in row] for row in heatmap]
            respond_json(self, 200, {
                "heatmap": heatmap,
                "deadzones": deadzone_mask,
                "nodes": node_positions,
                "aps": aps,
                "meta": meta,
            })
            return
        if self.path.startswith("/api/ap_positions"):
            aps, meta = compute_ap_positions()
            respond_json(self, 200, {
                "ok": meta.get("enough_clients", False),
                "aps": aps,
                "clients": meta.get("client_positions", {}),
                "active_clients": meta.get("active_clients", []),
                "grid": {"width": GRID_WIDTH, "height": GRID_HEIGHT}
            })
            return
        if self.path.startswith("/api/all_distance_strength"):
            # Flatten all networks
            points = []
            for nets in client_scan_data.values():
                for n in nets or []:
                    rssi = n.get('rssi')
                    if rssi is None:
                        continue
                    band = n.get('band')
                    dist = rssi_to_distance(float(rssi))
                    points.append({
                        'distance': dist,
                        'rssi': float(rssi),
                        'band': band,
                        'ssid': n.get('ssid'),
                        'bssid': n.get('bssid'),
                    })
            points.sort(key=lambda p: p['distance'])
            respond_json(self, 200, {"points": points})
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/submit_scan"):
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode('utf-8'))
                laptop_id = data.get("laptop_id")
                networks = data.get("networks")
                position = data.get("position")  # optional: {x,y} in meters
                if laptop_id and networks is not None:
                    # Store networks and update heartbeat
                    client_scan_data[laptop_id] = networks
                    client_last_seen[laptop_id] = time.time()
                    if isinstance(position, dict) and "x" in position and "y" in position:
                        try:
                            x = float(position["x"]) ; y = float(position["y"]) 
                            client_fixed_positions[laptop_id] = clamp_to_grid(x, y)
                        except Exception:
                            pass
                    print(f"Received {len(networks)} networks from {laptop_id}")
                    respond_json(self, 200, {"status": "success"})
                else:
                    respond_json(self, 400, {"error": "Missing laptop_id or networks"})
            except Exception as e:
                respond_json(self, 400, {"error": str(e)})
            return


if __name__ == "__main__":
    os.makedirs(WEB_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    server_address = ('0.0.0.0', 8000)
    httpd = HTTPServer(server_address, AppHandler)
    print("WiFi Coverage Server running on port 8000")
    print(f"Serving static files from {WEB_DIR}")
    httpd.serve_forever()
