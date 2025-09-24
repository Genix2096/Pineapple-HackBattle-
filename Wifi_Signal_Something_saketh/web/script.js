/*
WiFi Heatmap Visualizer
- Uses Python backend endpoints to get Wi-Fi scans
- Draws canvas with animated auras for each network, a central device, and connecting lines
- Networks are positioned radially based on live RSSI values, using a non-linear scale and a repulsion algorithm to prevent overlap.
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

// Graph elements (Distance vs Strength in Modal)
const btnShowGraph = document.getElementById('btnShowGraph');
const graphModal = document.getElementById('graphModal');
const btnCloseGraph = document.getElementById('btnCloseGraph');
const graphCanvas = document.getElementById('graph2dModal');
const graphTooltip = document.getElementById('graphTooltip');
let gctx = null;
let gW = 0, gH = 0;
let graphPoints = [];

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
    const res = await fetch('/api/distance_strength');
    const j = await res.json();
    return j.points || [];
  }catch{return []}
}

let hoveredGraphIndex = -1;
function drawGraph(){
  if(!gctx) return;
  gctx.clearRect(0,0,gW,gH);
  const m = {l:48, r:12, t:18, b:36};
  // axes
  gctx.strokeStyle = 'rgba(255,255,255,.15)';
  gctx.lineWidth = 1;
  gctx.beginPath();
  gctx.moveTo(m.l, gH-m.b); gctx.lineTo(gW-m.r, gH-m.b);
  gctx.moveTo(m.l, gH-m.b); gctx.lineTo(m.l, m.t);
  gctx.stroke();
  // ticks and labels
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
  // axis labels
  gctx.fillStyle = '#b9c2cf';
  gctx.fillText('Distance (m)', gW/2 - 34, gH-12);
  gctx.save();
  gctx.translate(16, gH/2 + 20);
  gctx.rotate(-Math.PI/2);
  gctx.fillText('Strength (dBm)', 0, 0);
  gctx.restore();
  // points
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

async function refreshGraph(){
  graphPoints = await fetchGraphData();
  drawGraph();
}

function isGraphOpen(){
  return graphModal && (graphModal.classList.contains('show') || graphModal.style.display === 'flex');
}

function openGraph(){
  if(!graphModal) return;
  graphModal.style.display = 'flex';
  graphModal.classList.add('show');
  resizeGraph();
  refreshGraph();
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

// Hover interaction on the graph canvas
function handleGraphHover(e){
  if(!graphCanvas || !isGraphOpen()) return;
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
}
if(graphCanvas){
  graphCanvas.addEventListener('mousemove', handleGraphHover);
  graphCanvas.addEventListener('mouseleave', ()=>{ hoveredGraphIndex=-1; drawGraph(); if(graphTooltip) graphTooltip.style.display='none'; });
}

let W = 0, H = 0;
let devicePos = {x: 0, y: 0};
let showAuras = true;

// Network data caches
let liveNetworks = []; // from /api/wifi
const networkAngles = new Map(); // Store a stable angle for each BSSID

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
}
window.addEventListener('resize', resize);
resize();

function rand(a,b){return a + Math.random()*(b-a)}

// Color utilities
function lerp(a,b,t){return a + (b-a)*t}
function clamp(v,a,b){return Math.max(a, Math.min(b,v))}
function rssiToColor(rssi){ // map -90..-30 to red..green
  const t = clamp((rssi + 90)/60, 0, 1);
  const r = Math.floor(lerp(255, 20, t));
  const g = Math.floor(lerp(40, 255, t));
  return `rgb(${r},${g},80)`;
}

// RSSI to distance (meters) using log-distance path loss model
function rssiToDistance(rssi, band){
  const n = band === '5 GHz' ? 2.7 : 2.2; // path loss exponent
  const P0 = band === '5 GHz' ? -47 : -42; // RSSI at 1m
  const d = Math.pow(10, (P0 - rssi) / (10*n));
  return clamp(d, 0.5, 100);
}

// Smooth fluctuations
function updateSmoothed(network){
  const key = network.bssid;
  const prev = smoothed.get(key) || {rssi: network.rssi, dist: rssiToDistance(network.rssi, network.band)};
  const targetRssi = network.rssi;
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

function drawHotspot(node){
  const {canvasPos, rssi, dist, meta} = node;

  // connection line
  ctx.save();
  ctx.strokeStyle = `rgba(180, 220, 255, 0.25)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); 
  ctx.moveTo(devicePos.x, devicePos.y); 
  ctx.lineTo(canvasPos.x, canvasPos.y); 
  ctx.stroke();

  // aura
  if(showAuras){
    const maxGlow = clamp(((-rssi - 30)/60), 0.2, 1.0);
    const glowR = (18 + 90 * maxGlow);
    const grad = ctx.createRadialGradient(canvasPos.x, canvasPos.y, 4, canvasPos.x, canvasPos.y, glowR);
    const col = rssiToColor(rssi);
    const a0 = (0.5).toFixed(3);
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
  ctx.fillStyle = '#cdd8e7';
  ctx.font = '12px Inter, Segoe UI, Roboto, Arial';
  ctx.textAlign = 'center';
  const label = `${meta.ssid || '(No SSID)'}`;
  const details = `${Math.round(dist)} m · ${Math.round(rssi)} dBm`;
  ctx.fillText(label, canvasPos.x, canvasPos.y - 12);
  ctx.fillText(details, canvasPos.x, canvasPos.y + 22);
  
  ctx.restore();
}

// Hover tooltip logic
let displayNodes = []; // Store final positions for hover detection
canvas.addEventListener('mousemove', (e)=>{
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hoveredHotspot = null;

    for (const node of displayNodes) {
        const dx = mx - node.x;
        const dy = my - node.y;
        if (dx * dx + dy * dy < 15 * 15) { // Increased hover radius
            hoveredHotspot = { x: mx, y: my, meta: node.meta };
            break;
        }
    }

    if(hoveredHotspot){
        tooltip.style.left = (hoveredHotspot.x+12)+'px';
        tooltip.style.top = (hoveredHotspot.y+12)+'px';
        const {meta} = hoveredHotspot;
        tooltip.innerHTML = `<b>${meta.ssid}</b><br>${meta.bssid}<br>${meta.band} / ${meta.wifi_standard}<br>${meta.auth || ''}`;
        tooltip.style.display = 'block';
    } else {
        tooltip.style.display = 'none';
    }
});


function draw(){
    ctx.clearRect(0,0,W,H);
    drawGrid();
    drawDevice();

    const MIN_RADIUS = 80;
    const MAX_RADIUS = Math.min(W, H) * 0.5 - 80;
    const goldenAngleIncrement = Math.PI * (3 - Math.sqrt(5));

    // 1. Calculate ideal positions and create display nodes
    displayNodes = []; // Clear for this frame
    liveNetworks.forEach(n => {
        const smooth = updateSmoothed(n);

        if (!networkAngles.has(n.bssid)) {
            const newAngle = (networkAngles.size * goldenAngleIncrement);
            networkAngles.set(n.bssid, newAngle);
        }
        const angle = networkAngles.get(n.bssid);

        const rssiT = (clamp(smooth.rssi, -90, -30) + 90) / 60;
        const radiusT = Math.pow(1 - rssiT, 0.7); // Non-linear spacing
        const displayRadius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * radiusT;

        const x = devicePos.x + displayRadius * Math.cos(angle);
        const y = devicePos.y + displayRadius * Math.sin(angle);

        displayNodes.push({
            id: n.bssid,
            x: x,
            y: y,
            rssi: smooth.rssi,
            dist: smooth.dist,
            meta: n
        });
    });

    // 2. Apply repulsion simulation for spacing
    const iterations = 5;
    const repulsionStrength = 0.6;
    const minSeparation = 110; // Minimum pixels between node centers

    for (let iter = 0; iter < iterations; iter++) {
        for (let i = 0; i < displayNodes.length; i++) {
            for (let j = i + 1; j < displayNodes.length; j++) {
                const nodeA = displayNodes[i];
                const nodeB = displayNodes[j];
                const dx = nodeB.x - nodeA.x;
                const dy = nodeB.y - nodeA.y;
                const distanceSq = dx * dx + dy * dy;

                if (distanceSq > 0 && distanceSq < minSeparation * minSeparation) {
                    const distance = Math.sqrt(distanceSq);
                    const force = (minSeparation - distance) / distance * repulsionStrength;
                    const moveX = dx * force * 0.5;
                    const moveY = dy * force * 0.5;
                    
                    nodeA.x -= moveX;
                    nodeA.y -= moveY;
                    nodeB.x += moveX;
                    nodeB.y += moveY;
                }
            }
        }
    }

    // 3. Draw the final, spaced-out nodes
    for (const node of displayNodes) {
        drawHotspot({
            canvasPos: { x: node.x, y: node.y },
            rssi: node.rssi,
            dist: node.dist,
            meta: node.meta
        });
    }
}


async function loop(){
  await fetchWifi();
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
      if(best){
        result.innerHTML = `Best WiFi: <b>${best.meta.ssid}</b> — ${best.meta.band}, ~${best.avgDist.toFixed(1)} m`;
      }else{
        result.innerHTML = 'No sufficient data to suggest.';
      }
      result.style.display = 'block';
      setTimeout(()=>{ result.style.display='none'; }, 10000);
      analysisActive = false;
    }
  }
  requestAnimationFrame(step);
});

btnToggleAuras.addEventListener('click', ()=>{ showAuras = !showAuras; });

btnReset.addEventListener('click', async ()=>{
  // Clear the stored angles to reshuffle the layout
  networkAngles.clear();
});


// Init
(async function init(){
  setInterval(()=>{ if(isGraphOpen()) refreshGraph(); }, 1000);
  loop();
 })();

