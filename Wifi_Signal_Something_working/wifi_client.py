"""
WiFi Scanning Client

This script continuously scans for Wi-Fi networks using pywifi and sends
the results to the main visualization server. Run this on one or more
laptops on the same network as the server.
"""
import asyncio
import json
import socket
import time
import requests
import pywifi

# --- CONFIGURATION ---
# IMPORTANT: Change this to the IP address of your main server laptop.
# Example: SERVER_URL = "http://192.168.1.10:8000/api/submit_scan"
SERVER_URL = "http://10.213.9.152:8000/api/submit_scan" 

# A unique ID for this laptop. The computer's hostname is a good default.
LAPTOP_ID = socket.gethostname()

# --- pywifi Real-time Scanning ---
try:
    wifi = pywifi.PyWiFi()
    iface = wifi.interfaces()[0]
except Exception as e:
    print(f"Error initializing WiFi interface: {e}")
    iface = None

def rssi_to_distance(rssi, tx_power=-42, n=2.7):
    """RSSI-to-distance conversion."""
    if rssi is None: return None
    try:
        return 10 ** ((tx_power - float(rssi)) / (10 * n))
    except Exception:
        return None

async def scan_and_send():
    """Continuously scans for networks and sends them to the server."""
    if not iface:
        print("No WiFi interface found. Exiting.")
        return

    while True:
        print("Starting new scan...")
        networks = []
        try:
            iface.scan()
            await asyncio.sleep(2.5) # Give it time to complete
            results = iface.scan_results()
            
            seen_bssid = set()
            for net in results:
                # --- START OF NEW ERROR HANDLING BLOCK ---
                try:
                    bssid = getattr(net, 'bssid', '')
                    if not bssid or bssid in seen_bssid:
                        continue
                    seen_bssid.add(bssid)

                    rssi = getattr(net, 'signal', None)
                    dist = rssi_to_distance(rssi)

                    auth_str = 'Unknown'
                    if hasattr(net, 'akm') and isinstance(net.akm, list):
                        auth_parts = []
                        for a in net.akm:
                            auth_parts.append(a.name if hasattr(a, 'name') else str(a))
                        auth_str = "/".join(auth_parts)

                    encr_str = 'Unknown'
                    if hasattr(net, 'cipher') and hasattr(net.cipher, 'name'):
                        encr_str = net.cipher.name
                    elif hasattr(net, 'cipher'):
                        encr_str = str(net.cipher)
                    
                    networks.append({
                        'ssid': getattr(net, 'ssid', ''),
                        'bssid': bssid,
                        'rssi': rssi,
                        'signal_percent': max(0, min(100, 2 * (rssi + 100))) if rssi else 0,
                        'distance': round(dist, 2) if dist is not None else None,
                        'band': "5 GHz" if hasattr(net, 'freq') and net.freq > 5000 else "2.4 GHz",
                        'channel': net.channel if hasattr(net, 'channel') else None,
                        'auth': auth_str,
                        'encryption': encr_str,
                        'wifi_standard': 'WiFi 4/5/6' # Heuristic
                    })
                except Exception as e:
                    # If one network profile fails to parse, print a warning and continue
                    print(f"  [!] Warning: Could not parse a network profile. Error: {e}. Skipping it.")
                    continue
                # --- END OF NEW ERROR HANDLING BLOCK ---
            
            print(f" - Found {len(networks)} unique networks.")

            # Send the data to the server
            payload = {
                "laptop_id": LAPTOP_ID,
                "networks": networks
            }
            try:
                response = requests.post(SERVER_URL, json=payload, timeout=5)
                if response.status_code == 200:
                    print(" - Successfully sent data to server.")
                else:
                    print(f" - ERROR: Server responded with status {response.status_code}: {response.text}")
            except requests.exceptions.RequestException as e:
                print(f" - ERROR: Could not send data to server: {e}")

        except Exception as e:
            print(f"An error occurred during the scan loop: {e}")
        
        # Wait before the next scan cycle
        await asyncio.sleep(2)

if __name__ == "__main__":
    print(f"--- WiFi Scanning Client ---")
    print(f"This machine's ID: {LAPTOP_ID}")
    print(f"Sending data to server at: {SERVER_URL}")
    print("Starting scanner... (Press Ctrl+C to stop)")
    try:
        asyncio.run(scan_and_send())
    except KeyboardInterrupt:
        print("\nScanner stopped.")

