/* ============================================================
   data.js — model for the full journey (client L7 → overlay → server L7).

   A "request" is an L7 story (method, path, optional body) wrapped in the
   fixed transport / network / overlay headers. Requests are generated on
   demand so the visual can show real variety:
     • GET / DELETE / OPTIONS carry NO body — every byte is metadata.
     • POST / PUT / PATCH carry a JSON body — that body is the bright core.

   ORDER  : the six-layer stack for the current request, inner → outer.
            layer[0] = app (the body, may be 0 bytes), layer[5] = VXLAN.
   nodes  : the 12 stations along the valley. `n` = how many layers are
            on the data at that station (1..6); depth = n - 1 drives the
            gentle down-then-up slope.
   ============================================================ */
window.OSI = (function () {
  "use strict";

  const enc = new TextEncoder();
  const byteLen = function (s) { return s ? enc.encode(s).length : 0; };   // real UTF-8 length
  const rint = function (a, b) { return a + Math.floor(Math.random() * (b - a + 1)); };
  const pick = function (a) { return a[Math.floor(Math.random() * a.length)]; };

  const HOST = "api-service";
  const NAMES = ["ada", "grace", "lin", "kofi", "mira", "sam", "yuki", "noor"];
  const ROLES = ["engineer", "admin", "analyst", "viewer", "operator"];
  const TEAMS = ["platform", "payments", "growth", "infra", "data"];

  // ---- L7 request catalogue --------------------------------------------
  // Each returns { method, path, body|null, headers[], note?, tool:{cmd,out} }.
  function get() {
    const path = "/api/users/" + rint(1000, 99999);
    return {
      method: "GET", path: path, body: null,
      note: "A GET has no request body — the resource is named entirely in the path, so every byte on the wire is delivery metadata.",
      headers: ["GET " + path + " HTTP/2", "host: " + HOST, "accept: application/json"],
      tool: { cmd: "curl -v https://" + HOST + path,
        out: "> GET " + path + " HTTP/2\n> accept: application/json\n<\n< HTTP/2 200\n< content-type: application/json" } };
  }
  function del() {
    const path = "/api/users/" + rint(1000, 99999);
    return {
      method: "DELETE", path: path, body: null,
      note: "DELETE carries no body — the target is named in the path.",
      headers: ["DELETE " + path + " HTTP/2", "host: " + HOST, "authorization: Bearer …"],
      tool: { cmd: "curl -X DELETE https://" + HOST + path + " -H 'Authorization: Bearer …'",
        out: "> DELETE " + path + " HTTP/2\n<\n< HTTP/2 204 No Content" } };
  }
  function options() {
    const path = "/api/users";
    return {
      method: "OPTIONS", path: path, body: null,
      note: "A CORS preflight: before the real request, the browser asks the server which methods and origins are allowed. No body — it's all headers.",
      headers: ["OPTIONS " + path + " HTTP/2", "origin: https://app.example.com", "access-control-request-method: POST"],
      tool: { cmd: "curl -X OPTIONS https://" + HOST + path + " \\\n    -H 'Origin: https://app.example.com' \\\n    -H 'Access-Control-Request-Method: POST'",
        out: "<\n< HTTP/2 204 No Content\n< access-control-allow-origin: https://app.example.com\n< access-control-allow-methods: GET, POST, PUT, DELETE" } };
  }
  // small bodies (≈5 rows)
  function post() {
    const body = JSON.stringify({ name: pick(NAMES), role: pick(ROLES) });
    return withBody("POST", "/api/users", body, "201 Created");
  }
  function patch() {
    const body = JSON.stringify({ status: pick(["active", "suspended", "invited"]) });
    return withBody("PATCH", "/api/users/" + rint(1000, 99999), body, "200 OK");
  }
  // medium bodies (≈6 rows)
  function postProfile() {
    const body = JSON.stringify({ name: pick(NAMES), email: pick(NAMES) + "@example.com", role: pick(ROLES), team: pick(TEAMS) });
    return withBody("POST", "/api/users", body, "201 Created");
  }
  function putConfig() {
    const body = JSON.stringify({ replicas: rint(2, 9), image: "api:" + rint(1, 40) + ".2", env: pick(["prod", "staging", "dev"]), team: pick(TEAMS) });
    return withBody("PUT", "/api/deployments/" + pick(TEAMS) + "-api", body, "200 OK");
  }
  // the big one — a batch create that reaches the box's 7-row cap. Kept rare.
  function postBatch() {
    const users = [{ name: pick(NAMES), role: pick(ROLES), team: pick(TEAMS) },
      { name: pick(NAMES), role: pick(ROLES), team: pick(TEAMS) }];
    return withBody("POST", "/api/users:batchCreate", JSON.stringify({ users: users }), "201 Created");
  }
  function withBody(method, path, body, status) {
    return {
      method: method, path: path, body: body,
      headers: [method + " " + path + " HTTP/2", "host: " + HOST,
        "content-type: application/json", "content-length: " + byteLen(body)],
      tool: { cmd: "curl -X " + method + " https://" + HOST + path + " \\\n    -H 'content-type: application/json' -d '" + body + "'",
        out: "> " + method + " " + path + " HTTP/2\n> content-length: " + byteLen(body) + "\n" + body + "\n<\n< HTTP/2 " + status } };
  }

  // GET/DELETE/OPTIONS carry no body; the rest span small → large payloads.
  // The largest (postBatch, ~7 rows) appears once, so it stays comparatively rare.
  const CATALOG = [get, get, del, options, post, post, patch, patch, postProfile, putConfig, putConfig, postBatch];

  // ---- wrap an L7 request in the fixed lower-layer headers --------------
  // TLS/TCP/IP/VXLAN header sizes are real and fixed; only the app (body) and
  // HTTP framing sizes track the actual request. Ports/seq vary per request.
  function buildORDER(r) {
    const sport = rint(49152, 65535);
    const seq = rint(1000, 9999999);
    const bodyBytes = byteLen(r.body);
    const httpBytes = byteLen(r.headers.join("\r\n") + "\r\n\r\n");
    const tlsBytes = 29;
    const l4payload = tlsBytes + httpBytes + bodyBytes;   // bytes TCP carries

    const app = r.body
      ? { key: "app", color: "--c-app", bytes: bodyBytes,
          caption: "The request itself — the only bytes the app actually cares about.",
          fields: [r.body + "   (" + bodyBytes + " bytes — the application payload)"],
          tool: { cmd: "# what the app handed to the socket", out: r.body } }
      : { key: "app", color: "--c-app", bytes: 0,
          caption: "A " + r.method + " has no body — the request is just the method and path.",
          fields: [r.note || ("A " + r.method + " request has no body — 0 application bytes.")],
          tool: { cmd: "# a " + r.method + " has no request body", out: "(no body)" } };

    const http = { key: "http", color: "--c-http", bytes: httpBytes,
      caption: "The method, path and headers — what you're asking the server to do.",
      fields: r.headers.concat(r.body ? [] : ["(no body)"]),
      tool: r.tool };

    const tls = { key: "tls", color: "--c-tls", bytes: tlsBytes,
      caption: "Encrypts everything above so nothing on the network can read it.",
      fields: ["TLSv1.3 · AES-128-GCM", "record: Application Data (23)", "wraps the HTTP request above"],
      tool: { cmd: "openssl s_client -connect " + HOST + ":443",
        out: "Cipher: TLS_AES_128_GCM_SHA256\nApplication Data (23), len " + (httpBytes + bodyBytes) + "   # ciphertext" } };

    const tcp = { key: "tcp", color: "--c-tcp", bytes: 20,
      caption: "Ports and sequence numbers so the bytes arrive complete and in order.",
      fields: ["sport " + sport + " → dport 443", "seq " + seq, "flags [ACK,PSH]"],
      tool: { cmd: "ss -tiep dst 10.244.2.10",
        out: "ESTAB 10.244.1.5:" + sport + " 10.244.2.10:443\n  mss:1460 bytes_sent:" + l4payload } };

    const ip = { key: "ip", color: "--c-ip", bytes: 20,
      caption: "Source and destination IP addresses so routers know where to send it.",
      fields: ["src 10.244.1.5 → dst 10.244.2.10", "ttl 64 · proto TCP(6)"],
      tool: { cmd: "ip route get 10.244.2.10",
        out: "10.244.2.10 via 10.244.1.1 dev eth0 src 10.244.1.5" } };

    const vxlan = { key: "vxlan", color: "--c-vxlan", bytes: 50, tag: "overlay only",
      caption: "Overlay networks only (Kubernetes, Tailscale…): the CNI wraps the whole frame in an outer packet so it can cross the physical underlay. Plain host-to-host traffic has no VXLAN.",
      fields: ["outer 192.168.1.10 → 192.168.1.11", "udp 4789 · vni 42 (inner L2 frame over the underlay)", "added by the pod's CNI (Calico / Cilium / Flannel …)"],
      tool: { cmd: "tcpdump -ni eth0 'udp port 4789'",
        out: "IP 192.168.1.10 > 192.168.1.11: VXLAN vni 42\n  IP 10.244.1.5." + sport + " > 10.244.2.10.443: tcp " + l4payload } };

    return [app, http, tls, tcp, ip, vxlan];
  }

  function model(r) {
    return { method: r.method, path: r.path, hasBody: !!r.body, ORDER: buildORDER(r) };
  }

  // A fixed, accurate POST for first load — a real body, stable across reloads.
  function defaultRequest() {
    const body = '{"name":"ada","role":"engineer"}';
    return model(withBody("POST", "/api/users", body, "201 Created"));
  }
  function randomRequest() { return model(pick(CATALOG)()); }

  // ---- nodes ------------------------------------------------------------
  // The valley: down the client stack, across the underlay (flat bottom
  // between the two VXLAN nodes), then up the server stack.
  // `layer` = the OSI-ish number of the node's outermost layer (app & HTTP
  // both live at L7; TLS at L6; TCP L4; IP L3; the VXLAN overlay frame at L2).
  const nodes = [
    { name: "Client",  sub: "frontend pod · 10.244.1.5",  icon: "🖥️", n: 1, layer: "L7" },
    { name: "HTTP",    sub: "request framing",            icon: "🌐", n: 2, layer: "L7" },
    { name: "TLS",     sub: "encryption",                 icon: "🔒", n: 3, layer: "L6" },
    { name: "TCP",     sub: "transport",                  icon: "🔌", n: 4, layer: "L4" },
    { name: "IP",      sub: "network",                    icon: "🧭", n: 5, layer: "L3" },
    { name: "VXLAN",   sub: "overlay · client CNI",       icon: "🛰️", n: 6, layer: "L2" },
    { name: "VXLAN",   sub: "overlay · server CNI",       icon: "🛰️", n: 6, layer: "L2" },
    { name: "IP",      sub: "kernel routing",             icon: "🧭", n: 5, layer: "L3" },
    { name: "TCP",     sub: "socket",                     icon: "🔌", n: 4, layer: "L4" },
    { name: "TLS",     sub: "decrypt",                    icon: "🔒", n: 3, layer: "L6" },
    { name: "HTTP",    sub: "parse",                      icon: "🌐", n: 2, layer: "L7" },
    { name: "Server",  sub: "api-service pod · 10.244.2.10", icon: "🖥️", n: 1, layer: "L7" }
  ];

  // ---- header anatomy ---------------------------------------------------
  // Static field layouts for the "Headers & metadata" tab. Each row's cells
  // flex by `w` (relative bit/byte width), so rows read like the classic RFC
  // header diagrams. `flags` renders the control-bit boxes; `variable` marks
  // stretchy trailers; `text` layers (HTTP) are shown as request/header lines.
  const names = { app: "body", http: "HTTP", tls: "TLS", tcp: "TCP", ip: "IP", vxlan: "VXLAN" };

  const formats = {
    http: { name: "HTTP/2 message", text: true },
    tls: { name: "TLS 1.3 record", rows: [
      { cells: [ { label: "Content type", w: 8, sub: "1 B · 23" }, { label: "Legacy version", w: 16, sub: "2 B" }, { label: "Length", w: 16, sub: "2 B" } ] },
      { cells: [ { label: "AEAD nonce + authentication tag", w: 40, sub: "~24 B", variable: true } ] }
    ] },
    tcp: { name: "TCP header", rows: [
      { cells: [ { label: "Source port", w: 16, sub: "16 bits" }, { label: "Destination port", w: 16, sub: "16 bits" } ] },
      { cells: [ { label: "Sequence number", w: 32, sub: "32 bits" } ] },
      { cells: [ { label: "Acknowledgement number", w: 32, sub: "32 bits" } ] },
      { cells: [ { label: "Data offset", w: 4, sub: "4b" }, { label: "Reserved", w: 4, sub: "4b" }, { label: "Flags", w: 8, flags: ["URG", "ACK", "PSH", "RST", "SYN", "FIN"] }, { label: "Window", w: 16, sub: "16 bits" } ] },
      { cells: [ { label: "Checksum", w: 16, sub: "16 bits" }, { label: "Urgent pointer", w: 16, sub: "16 bits" } ] },
      { cells: [ { label: "Options and padding", w: 32, sub: "variable", variable: true } ] }
    ] },
    ip: { name: "IPv4 header", rows: [
      { cells: [ { label: "Version", w: 4, sub: "4b" }, { label: "IHL", w: 4, sub: "4b" }, { label: "DSCP·ECN", w: 8, sub: "8b" }, { label: "Total length", w: 16, sub: "16 bits" } ] },
      { cells: [ { label: "Identification", w: 16, sub: "16 bits" }, { label: "Flags", w: 3, sub: "3b" }, { label: "Fragment offset", w: 13, sub: "13b" } ] },
      { cells: [ { label: "TTL", w: 8, sub: "8b" }, { label: "Protocol", w: 8, sub: "8b" }, { label: "Header checksum", w: 16, sub: "16 bits" } ] },
      { cells: [ { label: "Source address", w: 32, sub: "32 bits" } ] },
      { cells: [ { label: "Destination address", w: 32, sub: "32 bits" } ] },
      { cells: [ { label: "Options and padding", w: 32, sub: "variable", variable: true } ] }
    ] },
    vxlan: { name: "VXLAN encapsulation", rows: [
      { cells: [ { label: "Outer Ethernet", w: 14, sub: "14 B", variable: true } ] },
      { cells: [ { label: "Outer IPv4", w: 20, sub: "20 B", variable: true } ] },
      { cells: [ { label: "Outer UDP · dport 4789", w: 8, sub: "8 B", variable: true } ] },
      { cells: [ { label: "VXLAN flags", w: 8, sub: "8b" }, { label: "Reserved", w: 24, sub: "24b" } ] },
      { cells: [ { label: "VNI · 42", w: 24, sub: "24b" }, { label: "Reserved", w: 8, sub: "8b" } ] }
    ] }
  };

  return { nodes: nodes, defaultRequest: defaultRequest, randomRequest: randomRequest,
    formats: formats, names: names };
})();
