"""
WiFi Data Collection and Visualization Server

This script runs an HTTP server that:
1. Serves a web-based visualization interface.
2. Listens for incoming WiFi scan data from one or more clients.
3. Provides API endpoints for the web interface to fetch the collected data.

This server does NOT perform any WiFi scans itself. It only aggregates
data sent by wifi_client.py instances.
"""
from http.server import HTTPServer, SimpleHTTPRequestHandler
import json
import os
import urllib.parse
from io import BytesIO
from typing import Tuple

# NOTE: We no longer need the local scanning module.
# from rssi_windows import fetch_wifi_networks 

from gps_capture import save_original_gps, generate_gps_copies, save_original_wifi, generate_wifi_copies, list_data_files, ensure_data_dir
from wifi_graph import prepare_distance_strength

ROOT_DIR = os.path.dirname(__file__)
WEB_DIR = os.path.join(ROOT_DIR, 'web')
DATA_DIR = os.path.join(ROOT_DIR, 'data')

# --- In-memory Storage for Client Data ---
# This dictionary will store the latest scan results from each client,
# keyed by their unique laptop_id.
# Example: {'laptop-1': [network_data], 'laptop-2': [network_data]}
client_scan_data = {}
# This will hold the most recently received scan data, which can be used
# for functions like generating copies.
last_received_scan = {"networks": []}


def respond_json(handler: SimpleHTTPRequestHandler, status: int, data):
    """Helper function to send JSON responses."""
    payload = json.dumps(data).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(payload)))
    handler.send_header('Cache-Control', 'no-store')
    handler.end_headers()
    handler.wfile.write(payload)


class AppHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        """Serve files from the 'web' directory."""
        path = path.split('?', 1)[0].split('#', 1)[0]
        rel = path.lstrip('/')
        if rel == '':
            rel = 'index.html'
        full = os.path.join(WEB_DIR, *rel.split('/'))
        return full

    def do_GET(self):
        """Handle GET requests for API data and static files."""
        if self.path.startswith('/api/wifi'):
            # Combine networks from all connected clients into a single list.
            all_networks = []
            for networks in client_scan_data.values():
                all_networks.extend(networks)
            
            # Persist an "original" snapshot if not present yet, using the first
            # data we receive from a client.
            ensure_data_dir()
            if all_networks and not os.path.exists(os.path.join(DATA_DIR, 'wifi_original.json')):
                save_original_wifi({"networks": all_networks})
                generate_wifi_copies({"networks": all_networks})
            
            respond_json(self, 200, {"networks": all_networks})
            return
            
        # FIX: Changed endpoint to match the frontend request
        if self.path.startswith('/api/all_distance_strength'):
            # Combine networks from all clients for the graph.
            all_networks = []
            for networks in client_scan_data.values():
                all_networks.extend(networks)
            
            points = prepare_distance_strength(all_networks)
            respond_json(self, 200, {"points": points})
            return
            
        if self.path.startswith('/api/files'):
            respond_json(self, 200, list_data_files())
            return
            
        if self.path.startswith('/api/data'):
            files = list_data_files()
            combo = {}
            for key, path in files.items():
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        combo[key] = json.load(f)
                except Exception:
                    combo[key] = None
            respond_json(self, 200, combo)
            return
            
        # Default to serving static files (index.html, etc.)
        return super().do_GET()

    def do_POST(self):
        """Handle POST requests from clients submitting data."""
        if self.path.startswith('/api/submit_scan'):
            length = int(self.headers.get('Content-Length', '0'))
            raw_body = self.rfile.read(length)
            try:
                data = json.loads(raw_body.decode('utf-8'))
                laptop_id = data.get('laptop_id')
                networks = data.get('networks')

                if laptop_id and networks is not None:
                    # Store the received data
                    client_scan_data[laptop_id] = networks
                    global last_received_scan
                    last_received_scan = {"networks": networks}
                    print(f"Received scan data from '{laptop_id}' ({len(networks)} networks).")
                    respond_json(self, 200, {"status": "success", "message": "Data received."})
                else:
                    respond_json(self, 400, {"error": "Invalid payload; 'laptop_id' and 'networks' are required."})
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                respond_json(self, 400, {"error": f"Could not parse request body as JSON: {e}"})
            return

        if self.path.startswith('/api/save_gps'):
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode('utf-8'))
                lat = float(data.get('lat'))
                lon = float(data.get('lon'))
            except Exception:
                respond_json(self, 400, {"error": "Invalid payload"})
                return
            ensure_data_dir()
            saved = save_original_gps(lat, lon)
            copies = generate_gps_copies(lat, lon)
            respond_json(self, 200, {"saved": saved, **copies})
            return
            
        if self.path.startswith('/api/generate_copies'):
            # Regenerate wifi copies based on the most recently received scan data.
            if not last_received_scan["networks"]:
                respond_json(self, 400, {"error": "Cannot generate copies. No scan data has been received from a client yet."})
                return
            
            ensure_data_dir()
            saved = save_original_wifi(last_received_scan)
            copies = generate_wifi_copies(last_received_scan)
            respond_json(self, 200, {"wifi": {"original": saved, **copies}})
            return
            
        # Unknown POST endpoint
        respond_json(self, 404, {"error": "Not found"})


if __name__ == '__main__':
    os.chdir(WEB_DIR)
    port = int(os.environ.get('PORT', '8000'))
    
    # Bind to '0.0.0.0' to accept connections from other devices on the network.
    # '127.0.0.1' would only allow connections from the same machine.
    server_address = ('0.0.0.0', port)
    
    httpd = HTTPServer(server_address, AppHandler)
    print(f"Server is running on http://127.0.0.1:{port}")
    print("Listening for data from WiFi clients...")
    print("Open the URL in a browser to see the visualization.")
    httpd.serve_forever()
