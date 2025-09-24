/*
WiFi Heatmap Visualizer
- Uses Python backend endpoints to get Wi-Fi scans
- Draws canvas with animated auras for each network, a central device, and connecting lines
- Networks are positioned radially based on live RSSI, with repulsion to prevent overlap.
- Interactive canvas with pan and zoom.
- Buttons: Suggest Best WiFi (30s analysis), Reset, Toggle Auras
*/

const canvas = document.getElementById('heatmap');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const btnSuggest = document.getElementById('btnSuggest');
const btnReset = document.getElementById('btnReset');
const btnToggleAuras = document.getElementById('btnToggleAuras');
const progress = document.getElementById('progress');
const progressBar = document.querySelector('.progress-bar');
const progressText = document.getElementById('progressText');
const result = document.getElementById('result');

// Graph elements
const btnShowGraph = document.getElementById('btnShowGraph');
const graphModal = document.getElementById('graphModal');
const btnCloseGraph = document.getElementById('btnCloseGraph');
const graphCanvas = document.getElementById('graph2dModal');
const graphTooltip = document.getElementById('graphTooltip');
let gctx = null;
let gW = 0, gH = 0;
let graphPoints = [];

// Canvas interaction state
let W = 0, H = 0;
let panX = 0, panY = 0, zoom = 1.0;
let isPanning = false;
let lastPan = { x: 0, y: 0 };
let devicePos = { x: 0, y: 0 }; // Device is always at the logical origin (0,0)
let showAuras = true;

// Network data caches
let liveNetworks = [];
const networkAngles = new Map();
let smoothed = new Map();
let analysisActive = false;
let analysisWindow = new Map();

function resizeGraph(){
  if(!graphCanvas) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = graphCanvas.clientWidth || 240;
  const h = graphCanvas.clientHeight || 180;
  graphCanvas.width = Math.floor(w * dpr);
  graphCanvas.height = Math.floor(h * dpr);
  gctx = graphCanvas.getContext('2d');
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gW = w; gH = h;
  drawGraph();
}
window.addEventListener('resize', resizeGraph);

async function fetchGraphData(){
  try{
    // Fetch combined data from all saved scans
    const res = await fetch('/api/all_distance_strength');
    const j = await res.json();
    return j.points || [];
  }catch{return []}
}

let hoveredGraphIndex = -1;
function drawGraph(){
  if(!gctx) return;
  gctx.clearRect(0,0,gW,gH);
  const m = {l:48, r:12, t:18, b:36};
  gctx.strokeStyle = 'rgba(255,255,255,.15)';
  gctx.lineWidth = 1;
  gctx.beginPath();
  gctx.moveTo(m.l, gH-m.b); gctx.lineTo(gW-m.r, gH-m.b);
  gctx.moveTo(m.l, gH-m.b); gctx.lineTo(m.l, m.t);
  gctx.stroke();
  const rssiMin = -90, rssiMax = -30;
  const maxDist = Math.max(5, ...graphPoints.map(p=>p.distance||0));
  gctx.fillStyle = '#9fb0c8';
  gctx.font = '12px Inter, Segoe UI, Roboto, Arial';
  for(let ydb=-90; ydb<=-30; ydb+=10){
    const ty = m.t + (rssiMax - ydb) * ( (gH-m.b-m.t) / (rssiMax - rssiMin) );
    gctx.beginPath(); gctx.moveTo(m.l-6, ty); gctx.lineTo(m.l, ty); gctx.stroke();
    gctx.fillText(String(ydb), 8, ty+4);
  }
  for(let i=0;i<=5;i++){
    const d = (maxDist * i)/5;
    const tx = m.l + d * ((gW-m.l-m.r) / maxDist);
    gctx.beginPath(); gctx.moveTo(tx, gH-m.b); gctx.lineTo(tx, gH-m.b+6); gctx.stroke();
    const label = d<1 ? d.toFixed(1) : Math.round(d);
    gctx.fillText(String(label), tx-6, gH-10);
  }
  gctx.fillStyle = '#b9c2cf';
  gctx.fillText('Distance (m)', gW/2 - 34, gH-12);
  gctx.save();
  gctx.translate(16, gH/2 + 20);
  gctx.rotate(-Math.PI/2);
  gctx.fillText('Strength (dBm)', 0, 0);
  gctx.restore();
  graphPoints.forEach((p, idx)=>{
    const x = m.l + (p.distance||0) * ((gW-m.l-m.r) / maxDist);
    const y = m.t + (rssiMax - p.rssi) * ((gH-m.b-m.t)/(rssiMax - rssiMin));
    const col = p.band === '5 GHz' ? 'rgba(76,201,240,.9)' : 'rgba(0,230,118,.9)';
    p._x = x; p._y = y; p._r = 5;
    gctx.fillStyle = col;
    gctx.beginPath(); gctx.arc(x, y, 4, 0, Math.PI*2); gctx.fill();
    if(idx === hoveredGraphIndex){
      gctx.strokeStyle = 'rgba(255,255,255,.9)';
      gctx.lineWidth = 2;
      gctx.beginPath(); gctx.arc(x, y, 7, 0, Math.PI*2); gctx.stroke();
    }
  });
}

async function openGraph(){
  if(!graphModal) return;
  graphModal.style.display = 'flex';
  graphModal.classList.add('show');
  graphPoints = await fetchGraphData();
  resizeGraph();
}
function closeGraph(){
  if(!graphModal) return;
  graphModal.classList.remove('show');
  graphModal.style.display = 'none';
  if(graphTooltip) graphTooltip.style.display = 'none';
}

if(btnShowGraph){ btnShowGraph.addEventListener('click', openGraph); }
if(btnCloseGraph){ btnCloseGraph.addEventListener('click', closeGraph); }
if(graphModal){
  graphModal.addEventListener('click', (e)=>{
    if(e.target && e.target.classList && e.target.classList.contains('modal-backdrop')){
      closeGraph();
    }
  });
}

if(graphCanvas){
  graphCanvas.addEventListener('mousemove', (e) => {
    if(!graphCanvas) return;
    const rect = graphCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let found = -1;
    for(let i=0;i<graphPoints.length;i++){
        const p = graphPoints[i];
        const dx = x - (p._x||0);
        const dy = y - (p._y||0);
        const r = (p._r||5) + 4;
        if(dx*dx + dy*dy <= r*r){ found = i; break; }
    }
    hoveredGraphIndex = found;
    drawGraph();
    if(found>=0 && graphTooltip){
        const p = graphPoints[found];
        const parentRect = graphTooltip.parentElement.getBoundingClientRect();
        graphTooltip.style.left = (e.clientX - parentRect.left + 14) + 'px';
        graphTooltip.style.top = (e.clientY - parentRect.top + 14) + 'px';
        graphTooltip.innerHTML = `<b>${p.ssid||'(hidden SSID)'}</b><br>${p.bssid||''}<br>${p.band||''}<br>RSSI: ${Math.round(p.rssi)} dBm<br>Distance: ${(p.distance||0).toFixed(1)} m`;
        graphTooltip.style.display = 'block';
    }else if(graphTooltip){
        graphTooltip.style.display = 'none';
    }
  });
  graphCanvas.addEventListener('mouseleave', ()=>{ hoveredGraphIndex=-1; drawGraph(); if(graphTooltip) graphTooltip.style.display='none'; });
}


function resize() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function rand(a,b){return a + Math.random()*(b-a)}
function lerp(a,b,t){return a + (b-a)*t}
function clamp(v,a,b){return Math.max(a, Math.min(b,v))}
function rssiToColor(rssi){
  const t = clamp((rssi + 90)/60, 0, 1);
  const r = Math.floor(lerp(255, 20, t));
  const g = Math.floor(lerp(40, 255, t));
  return `rgb(${r},${g},80)`;
}

function rssiToDistance(rssi, band){
  const n = band === '5 GHz' ? 2.7 : 2.2;
  const P0 = band === '5 GHz' ? -47 : -42;
  const d = Math.pow(10, (P0 - rssi) / (10*n));
  return clamp(d, 0.5, 100);
}

function updateSmoothed(network){
  const key = network.bssid;
  const prev = smoothed.get(key) || {rssi: network.rssi, dist: rssiToDistance(network.rssi, network.band)};
  const newRssi = lerp(prev.rssi, network.rssi, 0.08);
  const newDist = lerp(prev.dist, rssiToDistance(newRssi, network.band), 0.08);
  smoothed.set(key, {rssi: newRssi, dist: newDist});
  return smoothed.get(key);
}

async function fetchWifi(){
  try{
    const res = await fetch('/api/wifi');
    liveNetworks = (await res.json()).networks || [];
  }catch(e){
    liveNetworks = [];
  }
}

function drawGrid(){
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1 / zoom;
  const step = 40;
  const startX = Math.floor(-panX / zoom / step) * step;
  const startY = Math.floor(-panY / zoom / step) * step;
  for(let x = startX; x < startX + (W/zoom) + step; x += step){
      ctx.beginPath(); ctx.moveTo(x, startY); ctx.lineTo(x, startY + (H/zoom) + step); ctx.stroke();
  }
  for(let y = startY; y < startY + (H/zoom) + step; y += step){
      ctx.beginPath(); ctx.moveTo(startX, y); ctx.lineTo(startX + (W/zoom) + step, y); ctx.stroke();
  }
  ctx.restore();
}

function drawDevice(){
  ctx.save();
  const r = 10;
  const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 28);
  grad.addColorStop(0, 'rgba(76,201,240,.9)');
  grad.addColorStop(1, 'rgba(76,201,240,.0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0, 0, 28, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#4cc9f0';
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

function drawHotspot(node){
  const {x, y, rssi, dist, meta} = node;
  ctx.save();
  ctx.strokeStyle = `rgba(180, 220, 255, 0.25)`;
  ctx.lineWidth = 1.5 / zoom;
  ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(x,y); ctx.stroke();
  if(showAuras){
    const maxGlow = clamp(((-rssi - 30)/60), 0.2, 1.0);
    const glowR = (18 + 90 * maxGlow);
    const grad = ctx.createRadialGradient(x, y, 4, x, y, glowR);
    const col = rssiToColor(rssi);
    const rgbaBase = col.replace('rgb', 'rgba').replace(')', '');
    grad.addColorStop(0, `${rgbaBase},0.5)`);
    grad.addColorStop(1, `${rgbaBase},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, glowR, 0, Math.PI*2); ctx.fill();
  }
  ctx.fillStyle = rssiToColor(rssi);
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#cdd8e7';
  ctx.font = `${12 / zoom}px Inter, Segoe UI, Roboto, Arial`;
  ctx.textAlign = 'center';
  ctx.fillText(`${meta.ssid || '(No SSID)'}`, x, y - (12 / zoom));
  ctx.fillText(`${Math.round(dist)} m · ${Math.round(rssi)} dBm`, x, y + (22 / zoom));
  ctx.restore();
}

let displayNodes = [];
function draw(){
    ctx.save();
    ctx.clearRect(0,0,W,H);
    ctx.translate(W/2 + panX, H/2 + panY);
    ctx.scale(zoom, zoom);
    drawGrid();
    drawDevice();

    const MIN_RADIUS = 80;
    const MAX_RADIUS = Math.min(W, H) * 0.5 / zoom * 0.8;
    const goldenAngleIncrement = Math.PI * (3 - Math.sqrt(5));

    displayNodes = [];
    liveNetworks.forEach(n => {
        const smooth = updateSmoothed(n);
        if (!networkAngles.has(n.bssid)) {
            networkAngles.set(n.bssid, networkAngles.size * goldenAngleIncrement);
        }
        const angle = networkAngles.get(n.bssid);
        const rssiT = (clamp(smooth.rssi, -90, -30) + 90) / 60;
        const radiusT = Math.pow(1 - rssiT, 0.7);
        const displayRadius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * radiusT;
        displayNodes.push({
            id: n.bssid, x: displayRadius * Math.cos(angle), y: displayRadius * Math.sin(angle),
            rssi: smooth.rssi, dist: smooth.dist, meta: n
        });
    });

    const iterations = 5, repulsionStrength = 0.6;
    const minSeparation = 110;
    for (let iter = 0; iter < iterations; iter++) {
        for (let i = 0; i < displayNodes.length; i++) {
            for (let j = i + 1; j < displayNodes.length; j++) {
                const nA = displayNodes[i], nB = displayNodes[j];
                const dx = nB.x - nA.x, dy = nB.y - nA.y;
                const dSq = dx*dx + dy*dy;
                if (dSq > 0 && dSq < minSeparation*minSeparation) {
                    const d = Math.sqrt(dSq);
                    const force = (minSeparation - d) / d * repulsionStrength;
                    const moveX = dx * force * 0.5, moveY = dy * force * 0.5;
                    nA.x -= moveX; nA.y -= moveY;
                    nB.x += moveX; nB.y += moveY;
                }
            }
        }
    }

    for (const node of displayNodes) {
        drawHotspot(node);
    }
    ctx.restore();
}

// Canvas interaction listeners
canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - W/2;
    const mouseY = e.clientY - rect.top - H/2;
    const zoomFactor = 1.1;
    const oldZoom = zoom;
    if (e.deltaY < 0) { // zoom in
        zoom = Math.min(zoom * zoomFactor, 10);
    } else { // zoom out
        zoom = Math.max(zoom / zoomFactor, 0.2);
    }
    panX = mouseX - (mouseX - panX) * (zoom / oldZoom);
    panY = mouseY - (mouseY - panY) * (zoom / oldZoom);
});
canvas.addEventListener('mousedown', e => { isPanning = true; lastPan = {x: e.clientX, y: e.clientY}; });
canvas.addEventListener('mousemove', e => {
    if (isPanning) {
        panX += e.clientX - lastPan.x;
        panY += e.clientY - lastPan.y;
        lastPan = {x: e.clientX, y: e.clientY};
    }
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - W/2 - panX) / zoom;
    const my = (e.clientY - rect.top - H/2 - panY) / zoom;
    let hoveredHotspot = null;
    for (const node of displayNodes) {
        const dx = mx - node.x, dy = my - node.y;
        if (dx*dx + dy*dy < 15*15) {
            hoveredHotspot = { meta: node.meta };
            break;
        }
    }
    if(hoveredHotspot){
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top + 12) + 'px';
        const {meta} = hoveredHotspot;
        tooltip.innerHTML = `<b>${meta.ssid}</b><br>${meta.bssid}<br>${meta.band} / ${meta.wifi_standard}<br>${meta.auth || ''}`;
        tooltip.style.display = 'block';
    } else {
        tooltip.style.display = 'none';
    }
});
canvas.addEventListener('mouseup', () => { isPanning = false; });
canvas.addEventListener('mouseleave', () => { isPanning = false; tooltip.style.display='none'; });

async function loop(){
  await fetchWifi();
  draw();
  requestAnimationFrame(loop);
}

// UI Buttons
btnSuggest.addEventListener('click', async ()=>{
  if(analysisActive) return;
  analysisActive = true; analysisWindow.clear();
  result.style.display = 'none';
  progress.style.display = 'block';
  const start = performance.now();
  const DURATION = 30000;
  function step(){
    const t = performance.now() - start;
    const pct = clamp(t / DURATION, 0, 1);
    progressBar.style.width = (pct*100).toFixed(1)+'%';
    progressText.textContent = Math.round(pct*100)+'%';
    const ts = Date.now();
    for(const n of liveNetworks){
      const s = smoothed.get(n.bssid) || {rssi:n.rssi, dist:rssiToDistance(n.rssi, n.band)};
      const arr = analysisWindow.get(n.bssid) || [];
      arr.push({t:ts, rssi:s.rssi, dist:s.dist, meta:n});
      while(arr.length && ts - arr[0].t > 30000) arr.shift();
      analysisWindow.set(n.bssid, arr);
    }
    if(t < DURATION){
      requestAnimationFrame(step);
    }else{
      progress.style.display = 'none';
      let best = null;
      analysisWindow.forEach((arr, bssid)=>{
        if(arr.length<5) return;
        const avgRssi = arr.reduce((s,a)=>s+a.rssi,0)/arr.length;
        const avgDist = arr.reduce((s,a)=>s+a.dist,0)/arr.length;
        const meta = arr[arr.length-1].meta;
        const score = avgRssi - avgDist;
        if(!best || score > best.score){ best = {bssid, avgRssi, avgDist, meta, score}; }
      });
      result.innerHTML = best ? `Best WiFi: <b>${best.meta.ssid}</b> — ${best.meta.band}, ~${best.avgDist.toFixed(1)} m` : 'No sufficient data to suggest.';
      result.style.display = 'block';
      setTimeout(()=>{ result.style.display='none'; }, 10000);
      analysisActive = false;
    }
  }
  requestAnimationFrame(step);
});

btnToggleAuras.addEventListener('click', ()=>{ showAuras = !showAuras; });

btnReset.addEventListener('click', async ()=>{
  networkAngles.clear();
  panX = 0; panY = 0; zoom = 1.0;
});

(async function init(){
  loop();
})();

