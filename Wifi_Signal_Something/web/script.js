/*
WiFi Heatmap Visualizer
- Uses Python backend endpoints to get Wi-Fi scans and save GPS
- Draws canvas with animated auras, center device, connecting lines
- Trilateration using original and two fabricated GPS+RSSI snapshots
- Buttons: Suggest Best WiFi (30s analysis), Reset, Toggle Auras
*/

const canvas = document.getElementById('heatmap');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const statusOrb = document.getElementById('statusOrb');
const btnSuggest = document.getElementById('btnSuggest');
const btnReset = document.getElementById('btnReset');
const btnToggleAuras = document.getElementById('btnToggleAuras');
const progress = document.getElementById('progress');
const progressBar = document.querySelector('.progress-bar');
const progressText = document.getElementById('progressText');
const result = document.getElementById('result');

let W = 0, H = 0;
let devicePos = {x: 0, y: 0};
let zoom = 1.0; // pixels per meter scale
let showAuras = true;

// Persistent obstacles
let obstacles = [];
const OBSTACLE_KEY = 'wifi_obstacles_v1';

// Network data caches
let liveNetworks = []; // from /api/wifi
let trilatPositions = {}; // bssid -> {x,y}

// Smoothed state
let smoothed = new Map(); // bssid -> {rssi, dist}

// Rolling analysis
let analysisActive = false;
let analysisWindow = new Map(); // bssid -> array of samples {t, rssi, dist}

function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  devicePos = {x: W/2, y: H/2};
  if (zoom === 1.0) zoom = Math.min(W, H) / 20; // 1m ≈ scale based on viewport
}
window.addEventListener('resize', resize);
resize();

function rand(a,b){return a + Math.random()*(b-a)}

function loadObstacles(){
  try{
    const raw = localStorage.getItem(OBSTACLE_KEY);
    if(raw){ obstacles = JSON.parse(raw); return; }
  }catch{}
  // create default obstacles
  obstacles = Array.from({length: 6}, ()=>{
    const w = rand(80, 200), h = rand(40, 160);
    const x = rand(100, W-100-w), y = rand(100, H-100-h);
    return {x,y,w,h, attenuation: rand(0.2,0.6)};
  });
  saveObstacles();
}
function saveObstacles(){
  localStorage.setItem(OBSTACLE_KEY, JSON.stringify(obstacles));
}
loadObstacles();

// Geometry helpers
function lineIntersectsRect(x1,y1,x2,y2, r){
  // Liang–Barsky or simple check via segment vs. rect edges
  const edges = [
    [r.x, r.y, r.x+r.w, r.y],
    [r.x+r.w, r.y, r.x+r.w, r.y+r.h],
    [r.x+r.w, r.y+r.h, r.x, r.y+r.h],
    [r.x, r.y+r.h, r.x, r.y]
  ];
  for(const [ax,ay,bx,by] of edges){ if(segmentsIntersect(x1,y1,x2,y2, ax,ay,bx,by)) return true; }
  return false;
}
function segmentsIntersect(x1,y1,x2,y2, x3,y3,x4,y4){
  function ccw(ax,ay,bx,by,cx,cy){return (cy-ay)*(bx-ax) > (by-ay)*(cx-ax)}
  return (ccw(x1,y1,x3,y3,x4,y4) !== ccw(x2,y2,x3,y3,x4,y4)) && (ccw(x1,y1,x2,y2,x3,y3) !== ccw(x1,y1,x2,y2,x4,y4));
}

// Color utilities
function lerp(a,b,t){return a + (b-a)*t}
function clamp(v,a,b){return Math.max(a, Math.min(b,v))}
function rssiToColor(rssi){ // map -90..-30 to red..green
  const t = clamp((rssi + 90)/60, 0, 1);
  const r = Math.floor(lerp(255, 20, t));
  const g = Math.floor(lerp(40, 255, t));
  return `rgb(${r},${g},80)`;
}
function mixColor(c1, c2, t){
  function parse(c){const m=c.match(/rgb\((\d+),(\d+),(\d+)\)/); return {r:+m[1],g:+m[2],b:+m[3]}}
  const a=parse(c1), b=parse(c2);
  return `rgb(${Math.floor(lerp(a.r,b.r,t))},${Math.floor(lerp(a.g,b.g,t))},${Math.floor(lerp(a.b,b.b,t))})`;
}

// RSSI to distance (meters) using log-distance path loss model
function rssiToDistance(rssi, band){
  const n = band === '5 GHz' ? 2.4 : 2.1; // path loss exponent
  const P0 = band === '5 GHz' ? -45 : -40; // RSSI at 1m
  const d = Math.pow(10, (P0 - rssi) / (10*n));
  return clamp(d, 0.5, 100);
}

// Smooth fluctuations
function updateSmoothed(network){
  const key = network.bssid;
  const prev = smoothed.get(key) || {rssi: network.rssi, dist: rssiToDistance(network.rssi, network.band)};
  // Gradual drift ±2 dBm
  const targetRssi = network.rssi + rand(-2,2);
  const newRssi = lerp(prev.rssi, targetRssi, 0.08);
  const dist = rssiToDistance(newRssi, network.band);
  const newDist = lerp(prev.dist, dist, 0.08);
  const data = {rssi: newRssi, dist: newDist};
  smoothed.set(key, data);
  return data;
}

async function fetchWifi(){
  try{
    const res = await fetch('/api/wifi');
    const j = await res.json();
    liveNetworks = j.networks || [];
  }catch(e){
    liveNetworks = [];
  }
}

async function sendGPS(){
  if(!('geolocation' in navigator)) return;
  return new Promise((resolve)=>{
    navigator.geolocation.getCurrentPosition(async pos=>{
      const {latitude:lat, longitude:lon} = pos.coords;
      try{
        await fetch('/api/save_gps', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({lat, lon})});
      }catch{}
      resolve();
    }, ()=>resolve(), {enableHighAccuracy:true, timeout:8000, maximumAge:60000});
  });
}

async function fetchAllData(){
  try{
    const res = await fetch('/api/data');
    return await res.json();
  }catch{return null}
}

// Trilateration from 3 measurements of same hotspot
function trilaterate(hotspotKey, snapshots){
  // snapshots: [{lat,lon, dist}, ...] length>=3
  if(snapshots.length < 3) return null;
  // Convert lat/lon to local meters relative to first point
  const ref = snapshots[0];
  function toXY(s){
    const x = (s.lon - ref.lon) * (40075000 * Math.cos(ref.lat*Math.PI/180) / 360);
    const y = (s.lat - ref.lat) * 111320;
    return {x,y};
  }
  const P = snapshots.map(s=>({p:toXY(s), d:s.dist}));
  // Solve least squares via linearization
  // (x-x1)^2+(y-y1)^2-d1^2 = (x-x2)^2+(y-y2)^2-d2^2 -> linear in x,y
  const A = [];
  const b = [];
  const p1 = P[0];
  for(let i=1;i<P.length;i++){
    const pi = P[i];
    const Ai = [2*(pi.p.x - p1.p.x), 2*(pi.p.y - p1.p.y)];
    const bi = (p1.p.x**2 - pi.p.x**2) + (p1.p.y**2 - pi.p.y**2) + (pi.d**2 - p1.d**2);
    A.push(Ai); b.push(bi);
  }
  // Solve Ax=b for x via normal equations (A^T A) x = A^T b
  const AtA00 = A.reduce((s,row)=>s+row[0]*row[0],0);
  const AtA01 = A.reduce((s,row)=>s+row[0]*row[1],0);
  const AtA11 = A.reduce((s,row)=>s+row[1]*row[1],0);
  const Atb0 = A.reduce((s,row,i)=>s+row[0]*b[i],0);
  const Atb1 = A.reduce((s,row,i)=>s+row[1]*b[i],0);
  const det = AtA00*AtA11 - AtA01*AtA01;
  if(Math.abs(det) < 1e-6) return null;
  const x = ( AtA11*Atb0 - AtA01*Atb1 )/det;
  const y = ( -AtA01*Atb0 + AtA00*Atb1 )/det;
  // Return position in meters relative to ref; convert to canvas with center at device
  return {x, y};
}

async function computeTrilateration(){
  const data = await fetchAllData();
  if(!data) return;
  // Build snapshots for each BSSID across original and two copies
  const gps = [data.gps_original, data.gps_copy1, data.gps_copy2].filter(Boolean);
  const wifi = [data.wifi_original, data.wifi_copy1, data.wifi_copy2].filter(Boolean);
  if(gps.length<3 || wifi.length<3) return;
  const byBssid = new Map();
  for(let i=0;i<3;i++){
    const g = gps[i];
    const w = wifi[i];
    if(!g || !w || !w.networks) continue;
    for(const n of w.networks){
      const dist = rssiToDistance(n.rssi, n.band);
      const list = byBssid.get(n.bssid) || [];
      list.push({lat:g.lat, lon:g.lon, dist, band:n.band});
      byBssid.set(n.bssid, list);
    }
  }
  byBssid.forEach((snapshots, bssid)=>{
    const pos = trilaterate(bssid, snapshots);
    if(pos){
      trilatPositions[bssid] = pos; // meters relative to gps_original
    }
  });
}

function drawGrid(){
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const step = 40;
  for(let x=0;x<W;x+=step){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for(let y=0;y<H;y+=step){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  ctx.restore();
}

function drawDevice(){
  const r = 10;
  ctx.save();
  const grad = ctx.createRadialGradient(devicePos.x, devicePos.y, 2, devicePos.x, devicePos.y, 28);
  grad.addColorStop(0, 'rgba(76,201,240,.9)');
  grad.addColorStop(1, 'rgba(76,201,240,.0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(devicePos.x, devicePos.y, 28, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#4cc9f0';
  ctx.beginPath(); ctx.arc(devicePos.x, devicePos.y, r, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

function metersToCanvas(dx, dy){
  return {x: devicePos.x + dx*zoom, y: devicePos.y - dy*zoom};
}

function obstacleAttenuationOnPath(x1,y1,x2,y2){
  let atten = 1.0;
  for(const ob of obstacles){
    if(lineIntersectsRect(x1,y1,x2,y2, ob)){
      atten *= (1.0 - ob.attenuation); // reduce intensity
    }
  }
  return atten;
}

function drawHotspot(node){
  const {x, y, rssi, dist, meta} = node;
  const canvasPos = metersToCanvas(x,y);
  const lineAtten = obstacleAttenuationOnPath(devicePos.x, devicePos.y, canvasPos.x, canvasPos.y);

  // connection line
  ctx.save();
  ctx.strokeStyle = `rgba(0,255,120,${0.35*lineAtten})`;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(devicePos.x, devicePos.y); ctx.lineTo(canvasPos.x, canvasPos.y); ctx.stroke();

  // aura
  if(showAuras){
    const maxGlow = clamp(((-rssi - 30)/60), 0.2, 1.0); // stronger signal -> larger glow
    const glowR = (18 + 90 * maxGlow) * (0.6 + 0.4*lineAtten);
    const grad = ctx.createRadialGradient(canvasPos.x, canvasPos.y, 4, canvasPos.x, canvasPos.y, glowR);
    const col = rssiToColor(rssi);
    const a0 = (0.9*lineAtten).toFixed(3);
    const rgbaBase = col.replace('rgb', 'rgba').replace(')', '');
    grad.addColorStop(0, `${rgbaBase},${a0})`);
    grad.addColorStop(1, `${rgbaBase},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(canvasPos.x, canvasPos.y, glowR, 0, Math.PI*2); ctx.fill();
  }

  // node
  ctx.fillStyle = rssiToColor(rssi);
  ctx.beginPath(); ctx.arc(canvasPos.x, canvasPos.y, 6, 0, Math.PI*2); ctx.fill();

  // label
  ctx.fillStyle = 'rgba(230,237,243,.95)';
  ctx.font = '12px Inter, Segoe UI, Roboto, Arial';
  ctx.textAlign = 'left';
  const label = `${meta.ssid}  ${meta.band}  ${meta.wifi_standard}\n${Math.round(dist)} m  ${meta.encryption || meta.auth || ''}`;
  const lines = label.split('\n');
  const xoff = 10, yoff = -10;
  const bx = canvasPos.x + xoff, by = canvasPos.y + yoff - 14;
  const bw = Math.max(...lines.map(t=>ctx.measureText(t).width)) + 12;
  const bh = 14*lines.length + 8;
  ctx.fillStyle = 'rgba(15,22,38,.85)';
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#cdd8e7';
  lines.forEach((t,i)=>ctx.fillText(t, bx+6, by+14*(i+1)));
  ctx.restore();
}

// Hover tooltip for precise details
let hoverInfo = null;
canvas.addEventListener('mousemove', (e)=>{
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  hoverInfo = null;
  for(const [bssid, pos] of Object.entries(trilatPositions)){
    const c = metersToCanvas(pos.x, pos.y);
    const dx = mx - c.x, dy = my - c.y;
    if(dx*dx+dy*dy < 12*12){
      const meta = liveNetworks.find(n=>n.bssid===bssid) || {ssid:'Unknown', band:'', wifi_standard:'', encryption:''};
      hoverInfo = {x:mx, y:my, text:`${meta.ssid}\n${bssid}\n${meta.band} ${meta.wifi_standard}`};
      break;
    }
  }
  if(hoverInfo){
    tooltip.style.left = (hoverInfo.x+12)+'px';
    tooltip.style.top = (hoverInfo.y+12)+'px';
    tooltip.innerText = hoverInfo.text;
    tooltip.style.display = 'block';
  }else{
    tooltip.style.display = 'none';
  }
});

function updateStatusOrb(){
  const count = liveNetworks.length;
  const avg = liveNetworks.length? liveNetworks.reduce((s,n)=>s+n.rssi,0)/liveNetworks.length : -90;
  const col = rssiToColor(avg);
  const style = getComputedStyle(statusOrb);
  const current = style.backgroundColor || 'rgb(30,238,238)';
  // Smooth transition by setting background to gradient with new color
  statusOrb.style.boxShadow = `0 0 40px ${col.replace('rgb','rgba').replace(')',',.45)')}, inset 0 0 30px rgba(255,255,255,.08)`;
  statusOrb.style.background = `radial-gradient(circle at 30% 30%, ${mixColor(current, col, 0.2)}, ${mixColor(current, col, 0.05)})`;
}

function draw(){
  ctx.clearRect(0,0,W,H);
  drawGrid();
  drawDevice();
  // Build nodes list from trilat positions and smoothed rssi/dist
  for(const n of liveNetworks){
    const smooth = updateSmoothed(n);
    const pos = trilatPositions[n.bssid];
    if(!pos) continue;
    drawHotspot({x:pos.x, y:pos.y, rssi: smooth.rssi, dist: smooth.dist, meta: n});
  }
}

async function loop(){
  await fetchWifi();
  updateStatusOrb();
  draw();
  requestAnimationFrame(loop);
}

// Suggest Best WiFi with 30s rolling analysis
btnSuggest.addEventListener('click', async ()=>{
  if(analysisActive) return;
  analysisActive = true; analysisWindow.clear();
  result.style.display = 'none';
  progress.style.display = 'block';
  const start = performance.now();
  const DURATION = 30000; // 30 seconds
  function step(){
    const now = performance.now();
    const t = now - start;
    const pct = clamp(t / DURATION, 0, 1);
    progressBar.style.width = (pct*100).toFixed(1)+'%';
    progressText.textContent = Math.round(pct*100)+'%';
    // collect samples
    const ts = Date.now();
    for(const n of liveNetworks){
      const s = smoothed.get(n.bssid) || {rssi:n.rssi, dist:rssiToDistance(n.rssi, n.band)};
      const arr = analysisWindow.get(n.bssid) || [];
      arr.push({t:ts, rssi:s.rssi, dist:s.dist, meta:n});
      // keep only last 30s
      while(arr.length && ts - arr[0].t > 30000) arr.shift();
      analysisWindow.set(n.bssid, arr);
    }
    if(t < DURATION){
      requestAnimationFrame(step);
    }else{
      progress.style.display = 'none';
      // compute best: highest avg RSSI, with distance as tiebreaker
      let best = null;
      analysisWindow.forEach((arr, bssid)=>{
        if(arr.length<5) return;
        const avgRssi = arr.reduce((s,a)=>s+a.rssi,0)/arr.length;
        const avgDist = arr.reduce((s,a)=>s+a.dist,0)/arr.length;
        const meta = arr[arr.length-1].meta;
        const score = avgRssi - 2*avgDist; // simple score
        if(!best || score > best.score){ best = {bssid, avgRssi, avgDist, meta, score}; }
      });
      if(best){
        result.innerHTML = `Best WiFi: <b>${best.meta.ssid}</b> — ${best.meta.band}, ${best.meta.wifi_standard}, ${best.meta.encryption || best.meta.auth || ''} — ~${best.avgDist.toFixed(1)} m`;
      }else{
        result.innerHTML = 'No sufficient data to suggest.';
      }
      result.style.display = 'block';
      setTimeout(()=>{ result.style.opacity = '1'; result.style.transition = 'opacity 1s'; result.style.opacity = '0'; setTimeout(()=>{result.style.display='none'; result.style.opacity='1';}, 1100);}, 100);
      analysisActive = false;
    }
  }
  requestAnimationFrame(step);
});

btnToggleAuras.addEventListener('click', ()=>{ showAuras = !showAuras; });

btnReset.addEventListener('click', async ()=>{
  // regenerate fabricated copies and obstacles
  try{ await fetch('/api/generate_copies', {method:'POST'}); }catch{}
  obstacles = []; loadObstacles();
  // also clear trilateration to recompute
  trilatPositions = {};
  await computeTrilateration();
});

// Zoom control (mouse wheel)
canvas.addEventListener('wheel', (e)=>{
  const delta = -Math.sign(e.deltaY) * 0.1;
  zoom = clamp(zoom*(1+delta), 2, 200);
});

// Init
(async function init(){
  await sendGPS();
  await computeTrilateration();
  loop();
})();
