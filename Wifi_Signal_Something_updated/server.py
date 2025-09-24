"""
Dedicated WiFi Visualization Server using FastAPI.

This server does NOT scan for WiFi. It receives scan data from multiple
client laptops and aggregates it for the visualization frontend.
"""
import asyncio
import json
import os
import time
import socket
from typing import List, Dict, Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Import the project's data handling and graph preparation modules
from gps_capture import save_original_gps, generate_gps_copies, save_original_wifi, generate_wifi_copies, ensure_data_dir
from wifi_graph import prepare_distance_strength

# --- Configuration ---
ROOT_DIR = os.path.dirname(__file__)
WEB_DIR = os.path.join(ROOT_DIR, 'web')
DATA_DIR = os.path.join(ROOT_DIR, 'data')

app = FastAPI()

# --- In-Memory Data Store ---
# This dictionary will hold the latest scan data from each client.
# Structure: { "client_id_1": {"data": [...], "timestamp": ...}, "client_id_2": ... }
client_scans: Dict[str, Dict[str, Any]] = {}

# --- API Endpoints ---

class ScanPayload(BaseModel):
    laptop_id: str
    networks: List[Dict[str, Any]]

@app.post("/api/submit_scan")
async def submit_scan_data(payload: ScanPayload):
    """Receives Wi-Fi scan data from a client laptop."""
    client_scans[payload.laptop_id] = {
        "data": payload.networks,
        "timestamp": time.time()
    }
    print(f"Received scan data from {payload.laptop_id} ({len(payload.networks)} networks)")
    return {"status": "ok", "message": f"Data received from {payload.laptop_id}"}

@app.get("/api/wifi")
async def get_wifi():
    """Aggregates and returns the latest data from all active clients."""
    now = time.time()
    active_scans = {
        cid: scan for cid, scan in client_scans.items()
        if now - scan.get('timestamp', 0) < 30  # Consider clients active if data is < 30s old
    }

    # Combine and de-duplicate networks, keeping the strongest signal
    deduped_networks = {}
    for client_id, scan in active_scans.items():
        for network in scan.get('data', []):
            bssid = network.get('bssid')
            if not bssid:
                continue
            
            network_with_source = {**network, 'source_laptop': client_id}
            
            if bssid not in deduped_networks or network.get('rssi', -999) > deduped_networks[bssid].get('rssi', -999):
                deduped_networks[bssid] = network_with_source

    return JSONResponse(content={"networks": list(deduped_networks.values())})

# The following endpoints for the graph and data generation remain as they were,
# but now they will use the client data when needed.
@app.get("/api/all_distance_strength")
async def get_all_distance_strength():
    all_points = []
    # This part still relies on generated files, which is fine.
    files_to_check = ['wifi_original.json', 'wifi_copy1.json', 'wifi_copy2.json']
    for filename in files_to_check:
        try:
            with open(os.path.join(DATA_DIR, filename), 'r', encoding='utf-8') as f:
                data = json.load(f)
                points = prepare_distance_strength(data.get("networks", []))
                all_points.extend(points)
        except Exception:
            continue
    return JSONResponse(content={"points": all_points})

class GpsPayload(BaseModel):
    lat: float
    lon: float

@app.post("/api/save_gps")
async def post_save_gps(payload: GpsPayload):
    ensure_data_dir()
    # Use the most recent client data to create the base files
    combined_networks = list(get_wifi().body.get("networks", []))
    if not os.path.exists(os.path.join(DATA_DIR, 'wifi_original.json')) and combined_networks:
        save_original_wifi({"networks": combined_networks})
        generate_wifi_copies({"networks": combined_networks})
    
    saved = save_original_gps(payload.lat, payload.lon)
    copies = generate_gps_copies(payload.lat, payload.lon)
    return JSONResponse(content={"saved": saved, **copies})

@app.post("/api/generate_copies")
async def post_generate_copies():
    ensure_data_dir()
    combined_networks = list(get_wifi().body.get("networks", []))
    if combined_networks:
        saved = save_original_wifi({"networks": combined_networks})
        copies = generate_wifi_copies({"networks": combined_networks})
        return JSONResponse(content={"wifi": {"original": saved, **copies}})
    return JSONResponse(content={"error": "No client data available to generate copies"}, status_code=400)


# --- Static File Serving ---
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="static")


if __name__ == "__main__":
    # Auto-detect IP for clear instructions
    hostname = socket.gethostname()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip_address = s.getsockname()[0]
        s.close()
    except Exception:
        ip_address = socket.gethostbyname(hostname)

    print("--- WiFi Visualization Server (Receiver Mode) ---")
    print(f"\n[ 1 ] Server is running and listening on: http://{ip_address}:8000")
    print(f"[ 2 ] Use the URL above in your client scripts.")
    print(f"[ 3 ] Open the URL in your browser to see the live visualization.")
    
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)

