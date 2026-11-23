/* Trail Fetcher UI */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const api = async (url, opts = {}) => {
    const r = await fetch(url, { ...opts, headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {} });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  const km = (m) => (m / 1000).toFixed(1) + " km";
  const mi = (m) => (m / 1609.344).toFixed(1) + " mi";
  const STATUS = { pushed: "In Wanderer", queued: "Queued", new: "Not pushed", duplicate: "Already in Wanderer", skipped: "Skipped", error: "Error" };
  const COLORS = { pushed: "#2f6b3b", queued: "#1a62b4", new: "#c05a00", duplicate: "#6b7d2f", skipped: "#888", error: "#b3261e" };
  const SRC = { usgs: "USGS", osm: "OSM", upload: "Upload" };

  // ---------- map ----------
  const saved = JSON.parse(localStorageGet("view") || "null");
  const map = L.map("map", { zoomControl: true }).setView(saved ? [saved.lat, saved.lng] : [39.5, -98.35], saved ? saved.z : 4);
  const base = {
    "Topo": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)" }),
    "Streets": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
    "USGS Topo": L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "USGS The National Map" }),
  };
  base[localStorageGet("base") || "Topo"]?.addTo(map) || base.Topo.addTo(map);
  L.control.layers(base, null, { position: "bottomleft" }).addTo(map);
  map.on("baselayerchange", (e) => localStorageSet("base", e.name));
  const trailLayer = L.layerGroup().addTo(map);

  function localStorageGet(k) { try { return localStorage.getItem("tf_" + k); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem("tf_" + k, v); } catch { /* ignore */ } }

  const toastEl = $("#toast");
  let toastT;
  function toast(msg, ms = 4000) {
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastT);
    if (ms) toastT = setTimeout(() => (toastEl.hidden = true), ms);
  }

  const bboxStr = (b) => [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(",");

  // ---------- area box (move + resize) ----------
  let box = null, handles = [], mover = null;
  const boxBtn = $("#boxBtn");
  function showBox(bounds) {
    bounds = bounds || map.getBounds().pad(-0.2);
    if (!box) {
      box = L.rectangle(bounds, { color: "#2f6b3b", weight: 2, dashArray: "6 4", fillOpacity: 0.08, interactive: false }).addTo(map);
      const icon = L.divIcon({ className: "box-handle", iconSize: [18, 18] });
      handles = [0, 1, 2, 3].map((i) => {
        const m = L.marker([0, 0], { icon, draggable: true, keyboard: false }).addTo(map);
        m.on("drag", () => {
          const b = box.getBounds();
          const corners = [b.getSouthWest(), b.getNorthWest(), b.getNorthEast(), b.getSouthEast()];
          const opp = corners[(i + 2) % 4];
          box.setBounds(L.latLngBounds(m.getLatLng(), opp));
          placeHandles(i);
          updateAreaInfo();
        });
        return m;
      });
      mover = L.marker([0, 0], { icon: L.divIcon({ className: "box-move", html: "✥", iconSize: [28, 28] }), draggable: true }).addTo(map);
      let start;
      mover.on("dragstart", () => (start = { c: mover.getLatLng(), b: box.getBounds() }));
      mover.on("drag", () => {
        const d = mover.getLatLng(), dl = d.lat - start.c.lat, dn = d.lng - start.c.lng;
        const sw = start.b.getSouthWest(), ne = start.b.getNorthEast();
        box.setBounds(L.latLngBounds([sw.lat + dl, sw.lng + dn], [ne.lat + dl, ne.lng + dn]));
        placeHandles(-1, true);
        updateAreaInfo();
      });
    }
    box.setBounds(bounds);
    placeHandles();
    boxBtn.classList.add("on");
    updateAreaInfo();
  }
  function placeHandles(skip = -1, skipMover = false) {
    const b = box.getBounds();
    const corners = [b.getSouthWest(), b.getNorthWest(), b.getNorthEast(), b.getSouthEast()];
    handles.forEach((h, i) => i !== skip && h.setLatLng(corners[i]));
    if (!skipMover) mover.setLatLng(b.getCenter());
  }
  function hideBox() {
    [box, mover, ...handles].forEach((l) => l && map.removeLayer(l));
    box = mover = null; handles = [];
    boxBtn.classList.remove("on");
  }
  boxBtn.onclick = () => (box ? hideBox() : showBox());
  function updateAreaInfo() {
    if (!box) { $("#areaInfo").textContent = "Tap “Area box” to show the box."; return; }
    const b = box.getBounds();
    const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    const tiles = (Math.ceil(e / 0.25) - Math.floor(w / 0.25)) * (Math.ceil(n / 0.25) - Math.floor(s / 0.25));
    const wkm = map.distance([b.getCenter().lat, w], [b.getCenter().lat, e]) / 1000;
    const hkm = map.distance([s, w], [n, w]) / 1000;
    const mins = Math.ceil((tiles * 4) / 60);
    $("#areaInfo").textContent = `${wkm.toFixed(0)} × ${hkm.toFixed(0)} km · ${tiles} tiles · about ${mins < 60 ? mins + " min" : (mins / 60).toFixed(1) + " h"} for a first download`;
  }

  // ---------- browse / load trails ----------
  let lastTrails = [], waitingJob = null, loadT;
  map.on("moveend", () => {
    const c = map.getCenter();
    localStorageSet("view", JSON.stringify({ lat: c.lat, lng: c.lng, z: map.getZoom() }));
    clearTimeout(loadT);
    loadT = setTimeout(loadTrails, 350);
  });

  async function loadTrails() {
    const z = map.getZoom();
    const tol = z >= 14 ? 0.00003 : z >= 12 ? 0.0001 : z >= 10 ? 0.0003 : 0.001;
    try {
      const res = await api(`/api/trails?bbox=${bboxStr(map.getBounds())}&tol=${tol}&limit=${z < 9 ? 800 : 2000}`);
      lastTrails = res.trails;
      drawTrails();
      renderList();
      const cov = res.coverage;
      let msg = `${res.trails.length} trails here (local cache).`;
      if (cov && cov.cached < cov.tiles) {
        if (res.jobId) { msg += " Getting more trails from the internet…"; waitingJob = res.jobId; pollStatus(); }
        else msg += ` Zoom in to download this area, or use the Area box to import it (${cov.tiles} tiles).`;
      }
      $("#coverage").textContent = msg;
    } catch (e) {
      $("#coverage").textContent = "Cannot load trails: " + e.message + (navigator.onLine ? "" : " (offline)");
    }
  }

  function drawTrails() {
    trailLayer.clearLayers();
    for (const t of lastTrails) {
      if (!t.lines) continue;
      const pl = L.polyline(t.lines.map((l) => l.map(([x, y]) => [y, x])), { color: COLORS[t.status] || "#c05a00", weight: 3, opacity: 0.85 });
      pl.on("click", (e) => openTrail(t.id, e.latlng));
      pl.bindTooltip(esc(t.name), { sticky: true });
      trailLayer.addLayer(pl);
    }
  }

  function renderList() {
    const f = $("#filterInput").value.trim().toLowerCase();
    const st = $("#statusFilter").value;
    const items = lastTrails.filter((t) => (!f || t.name.toLowerCase().includes(f)) && (!st || t.status === st)).slice(0, 400);
    $("#trailList").innerHTML = items.map((t) => `
      <li data-id="${t.id}">
        <div class="grow"><div class="name">${esc(t.name)}</div>
        <div class="sub">${mi(t.length_m)} · ${km(t.length_m)} · ${SRC[t.source] || esc(t.source)}</div></div>
        <span class="badge ${esc(t.status)}">${STATUS[t.status] || esc(t.status)}</span>
      </li>`).join("") || `<li class="sub">No trails in view.</li>`;
  }
  $("#filterInput").oninput = renderList;
  $("#statusFilter").onchange = renderList;
  $("#trailList").onclick = (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const t = lastTrails.find((x) => x.id == li.dataset.id);
    if (t) { map.fitBounds([[t.bbox[1], t.bbox[0]], [t.bbox[3], t.bbox[2]]], { maxZoom: 15, padding: [30, 30] }); openTrail(t.id); }
  };

  async function openTrail(id, latlng) {
    const t = await api(`/api/trails/${id}`);
    const ll = latlng || L.latLng((t.bbox[1] + t.bbox[3]) / 2, (t.bbox[0] + t.bbox[2]) / 2);
    const meta = Object.entries(t.meta || {}).filter(([k, v]) => v && !["segments", "osm"].includes(k)).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>");
    const html = `<b>${esc(t.name)}</b><br>${mi(t.length_m)} · ${km(t.length_m)} · ${SRC[t.source] || esc(t.source)}<br>
      Status: ${STATUS[t.status] || esc(t.status)}${t.error ? `<br><span style="color:var(--err)">${esc(t.error)}</span>` : ""}
      ${meta ? `<div class="small" style="margin-top:4px">${meta}</div>` : ""}
      ${t.meta?.osm ? `<div class="small"><a href="${esc(t.meta.osm)}" target="_blank" rel="noopener">OpenStreetMap</a></div>` : ""}
      <div style="margin-top:6px;display:flex;gap:6px">
        <a class="btn" href="/api/trails/${t.id}/gpx">GPX</a>
        ${t.status !== "pushed" ? `<button class="btn primary" data-push="${t.id}">Push to Wanderer</button>` : ""}
      </div>`;
    L.popup().setLatLng(ll).setContent(html).openOn(map);
  }
  map.on("popupopen", (e) => {
    const b = e.popup.getElement().querySelector("[data-push]");
    if (b) b.onclick = async () => { await api(`/api/trails/${b.dataset.push}/push`, { method: "POST" }); toast("Queued for Wanderer"); map.closePopup(); pollStatus(); };
  });

  // ---------- search ----------
  const placeResults = $("#placeResults");
  $("#searchForm").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("#searchInput").value.trim();
    if (!q) return;
    placeResults.hidden = true;
    // 1) local trail names
    const local = await api(`/api/trails?q=${encodeURIComponent(q)}&geom=0&limit=8`).catch(() => ({ trails: [] }));
    // 2) places
    const places = await api(`/api/geocode?q=${encodeURIComponent(q)}`).catch((err) => { toast(err.message); return []; });
    const btns = [
      ...local.trails.map((t) => `<button data-bbox="${t.bbox.join(",")}" data-trail="${t.id}">🥾 ${esc(t.name)} <span class="small">${mi(t.length_m)}</span></button>`),
      ...places.map((p) => `<button data-bbox="${p.bbox.join(",")}" data-label="${esc(p.name.split(",")[0])}">📍 ${esc(p.name)}</button>`),
    ];
    placeResults.innerHTML = btns.join("") || `<button disabled>No results</button>`;
    placeResults.hidden = false;
  };
  placeResults.onclick = (e) => {
    const b = e.target.closest("button[data-bbox]");
    if (!b) return;
    const [w, s, ea, n] = b.dataset.bbox.split(",").map(Number);
    const bounds = L.latLngBounds([s, w], [n, ea]);
    map.fitBounds(bounds, { maxZoom: b.dataset.trail ? 15 : 13 });
    placeResults.hidden = true;
    if (b.dataset.label) {
      $("#areaLabel").value = b.dataset.label;
      showBox(bounds);
      const tiles = (Math.ceil(ea / 0.25) - Math.floor(w / 0.25)) * (Math.ceil(n / 0.25) - Math.floor(s / 0.25));
      if (tiles > 16) { switchTab("area"); toast("Large area. Use “Import trails in box” to get all trails."); }
    }
    if (b.dataset.trail) setTimeout(() => openTrail(b.dataset.trail), 600);
  };
  document.addEventListener("click", (e) => { if (!e.target.closest(".bar")) placeResults.hidden = true; });

  $("#locBtn").onclick = () => map.locate({ setView: true, maxZoom: 13 });
  map.on("locationerror", () => toast("Location not available"));

  // ---------- area import ----------
  $("#areaFitBtn").onclick = () => showBox(map.getBounds().pad(-0.05));
  $("#areaImportBtn").onclick = async () => {
    if (!box) showBox();
    try {
      const r = await api("/api/jobs", { method: "POST", body: JSON.stringify({ bbox: bboxStr(box.getBounds()), label: $("#areaLabel").value || "Area", push: $("#areaPush").checked }) });
      toast(`Import started (${r.tiles} tiles). See Jobs.`);
      switchTab("jobs");
      pollStatus();
    } catch (e) { toast(e.message, 8000); }
  };
  $("#areaPushBtn").onclick = async () => {
    if (!box) showBox();
    const r = await api("/api/push", { method: "POST", body: JSON.stringify({ bbox: bboxStr(box.getBounds()), retryErrors: true }) });
    toast(`${r.queued} trails queued for Wanderer`);
    pollStatus();
  };

  // ---------- jobs / status ----------
  let pollT = null;
  async function pollStatus() {
    clearTimeout(pollT);
    try {
      const [st, jobs] = await Promise.all([api("/api/status"), api("/api/jobs")]);
      const c = st.counts || {};
      $("#statusBox").innerHTML = `
        ${st.wanderer ? "" : `<b style="color:var(--warn)">Wanderer is not set up. Open Settings.</b><br>`}
        ${st.pushPaused ? `<b style="color:var(--err)">Push paused: ${esc(st.pushPaused)}</b><br>` : ""}
        Cache: ${Object.entries(st.bySource || {}).map(([k, v]) => `${SRC[k] || esc(k)} ${v}`).join(" · ") || "empty"}<br>
        Wanderer: ${c.pushed || 0} pushed · ${c.queued || 0} queued · ${c.duplicate || 0} duplicates · ${c.error || 0} errors
        ${st.pushRunning ? " · <i>pushing…</i>" : ""}
        ${c.error ? ` <button class="btn" id="retryErrBtn">Retry errors</button>` : ""}`;
      const rb = $("#retryErrBtn");
      if (rb) rb.onclick = async () => { await api("/api/push", { method: "POST", body: JSON.stringify({ retryErrors: true }) }); pollStatus(); };
      $("#jobList").innerHTML = jobs.map((j) => {
        const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
        const active = j.status === "running" || j.status === "queued";
        return `<li><div class="grow"><div class="name">${esc(j.label)} <span class="badge">${esc(j.status)}</span></div>
          <div class="sub">${j.status === "done" ? `${j.found} trails built` : `${j.done}/${j.total} tiles`} ${j.message ? "· " + esc(j.message) : ""}</div>
          ${active ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ""}</div>
          ${active ? `<button class="btn" data-cancel="${j.id}">Cancel</button>` : `<button class="btn" data-retry="${j.id}">Run again</button>`}</li>`;
      }).join("") || `<li class="sub">No jobs yet.</li>`;
      const busy = st.jobRunning || st.pushRunning;
      if (waitingJob) {
        const wj = jobs.find((j) => j.id === waitingJob);
        if (!wj || !["queued", "running"].includes(wj.status)) { waitingJob = null; loadTrails(); }
      } else if (st.pushRunning && document.querySelector('.tab.active')?.id === "tab-trails") {
        // refresh colors while pushing
        if (Math.random() < 0.3) loadTrails();
      }
      if (busy || waitingJob) pollT = setTimeout(pollStatus, 3000);
    } catch { pollT = setTimeout(pollStatus, 8000); }
  }
  $("#jobList").onclick = async (e) => {
    const c = e.target.dataset.cancel, r = e.target.dataset.retry;
    if (c) await api(`/api/jobs/${c}/cancel`, { method: "POST" });
    if (r) await api(`/api/jobs/${r}/retry`, { method: "POST" });
    pollStatus();
  };

  // ---------- upload ----------
  const drop = $("#dropZone"), fileInput = $("#fileInput");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));
  fileInput.onchange = () => uploadFiles(fileInput.files);
  async function uploadFiles(files) {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    $("#uploadList").innerHTML = `<li class="sub">Uploading ${files.length} file(s)…</li>`;
    try {
      const res = await api("/api/upload", { method: "POST", body: fd });
      $("#uploadList").innerHTML = res.map((r) => `<li><div class="grow"><div class="name">${esc(r.name || r.file)}</div>
        <div class="sub">${r.error ? `<span style="color:var(--err)">${esc(r.error)}</span>` : "Added"}</div></div></li>`).join("");
      fileInput.value = "";
      loadTrails(); pollStatus();
    } catch (e) { $("#uploadList").innerHTML = `<li style="color:var(--err)">${esc(e.message)}</li>`; }
  }

  // ---------- settings ----------
  const form = $("#settingsForm");
  async function loadSettings() {
    const s = await api("/api/settings");
    form.wanderer_url.value = s.wanderer_url || "";
    form.wanderer_user.value = s.wanderer_user || "";
    form.wanderer_api_key.placeholder = s.has_api_key ? "•••••••• (saved, type to replace)" : "wanderer_key_…  (Wanderer → Settings → API)";
    form.wanderer_password.placeholder = s.has_password ? "•••••••• (saved)" : "";
    form.sources.value = s.sources;
    form.auto_push.checked = s.auto_push === "true";
    form.min_length_m.value = s.min_length_m;
    form.cache_days.value = s.cache_days;
    if (!s.wanderer_url) { switchTab("settings"); $("#settingsMsg").textContent = "Add your Wanderer URL and API key to start."; }
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      wanderer_url: form.wanderer_url.value.trim(), wanderer_user: form.wanderer_user.value.trim(),
      sources: form.sources.value, auto_push: String(form.auto_push.checked),
      min_length_m: form.min_length_m.value, cache_days: form.cache_days.value,
    };
    if (form.wanderer_api_key.value) body.wanderer_api_key = form.wanderer_api_key.value.trim();
    if (form.wanderer_password.value) body.wanderer_password = form.wanderer_password.value;
    await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
    form.wanderer_api_key.value = ""; form.wanderer_password.value = "";
    $("#settingsMsg").textContent = "Saved.";
    loadSettings(); pollStatus();
  };
  $("#testBtn").onclick = async () => {
    $("#settingsMsg").textContent = "Testing…";
    try { await api("/api/settings/test", { method: "POST" }); $("#settingsMsg").textContent = "Connection OK."; }
    catch (e) { $("#settingsMsg").textContent = e.message; }
  };

  // ---------- tabs / bottom sheet ----------
  function switchTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    if (name === "jobs") pollStatus();
    if (name === "area") { updateAreaInfo(); if (!box) showBox(); }
    const p = $("#panel");
    if (p.classList.contains("min")) p.classList.remove("min");
  }
  document.querySelector(".tabs").onclick = (e) => { const b = e.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); };
  $("#grip").onclick = () => {
    const p = $("#panel");
    if (p.classList.contains("min")) p.classList.remove("min");
    else if (p.classList.contains("max")) { p.classList.remove("max"); p.classList.add("min"); }
    else p.classList.add("max");
    setTimeout(() => map.invalidateSize(), 250);
  };

  // ---------- start ----------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  loadSettings().catch(() => {});
  loadTrails();
  pollStatus();
})();
