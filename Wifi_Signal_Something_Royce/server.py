from http.server import HTTPServer, SimpleHTTPRequestHandler
import json
import os
import urllib.parse
from io import BytesIO
from typing import Tuple, List, Dict, Any

from rssi_windows import fetch_wifi_networks
from gps_capture import save_original_gps, generate_gps_copies, save_original_wifi, generate_wifi_copies, list_data_files, ensure_data_dir, load_json
from wifi_graph import prepare_distance_strength

ROOT_DIR = os.path.dirname(__file__)
WEB_DIR = os.path.join(ROOT_DIR, 'web')
DATA_DIR = os.path.join(ROOT_DIR, 'data')


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
        # Serve files from web directory by default
        path = path.split('?', 1)[0].split('#', 1)[0]
        rel = path.lstrip('/')
        if rel == '':
            rel = 'index.html'
        full = os.path.join(WEB_DIR, *rel.split('/'))
        return full

    def do_GET(self):
        if self.path.startswith('/api/wifi'):
            networks = fetch_wifi_networks()
            ensure_data_dir()
            if not os.path.exists(os.path.join(DATA_DIR, 'wifi_original.json')):
                save_original_wifi({"networks": networks})
                generate_wifi_copies({"networks": networks})
            respond_json(self, 200, {"networks": networks})
            return

        if self.path.startswith('/api/all_distance_strength'):
            # Combine all wifi scans for a comprehensive graph
            files = list_data_files()
            all_networks: Dict[str, Any] = {} # Use dict to dedupe by BSSID
            for key in ['wifi_original', 'wifi_copy1', 'wifi_copy2']:
                data = load_json(files[key])
                if data and 'networks' in data:
                    for n in data['networks']:
                        # If BSSID already exists, keep the one with stronger RSSI
                        if n.get('bssid') and n.get('rssi') is not None:
                            bssid = n['bssid']
                            if bssid not in all_networks or n['rssi'] > all_networks[bssid]['rssi']:
                                all_networks[bssid] = n
            
            points = prepare_distance_strength(list(all_networks.values()))
            respond_json(self, 200, {"points": points})
            return

        if self.path.startswith('/api/files'):
            respond_json(self, 200, list_data_files())
            return
            
        if self.path.startswith('/api/data'):
            files = list_data_files()
            combo = {}
            for key, path in files.items():
                combo[key] = load_json(path)
            respond_json(self, 200, combo)
            return
        
        # default static
        return super().do_GET()

    def do_POST(self):
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
            networks = fetch_wifi_networks()
            ensure_data_dir()
            saved = save_original_wifi({"networks": networks})
            copies = generate_wifi_copies({"networks": networks})
            respond_json(self, 200, {"wifi": {"original": saved, **copies}})
            return
        # Unknown
        respond_json(self, 404, {"error": "Not found"})


if __name__ == '__main__':
    os.chdir(WEB_DIR)
    port = int(os.environ.get('PORT', '8000'))
    httpd = HTTPServer(('127.0.0.1', port), AppHandler)
    print(f"Serving on http://127.0.0.1:{port}")
    print("Open this URL in a modern browser.")
    httpd.serve_forever()

