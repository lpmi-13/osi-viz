/* ============================================================
   data.js — model for the full journey (client L7 → overlay → server L7).
   ORDER  : the canonical layer stack, inner → outer (app is the core).
   nodes  : the 12 stations along the valley. `n` = how many layers are
            on the data at that station (1..6); depth = n - 1 drives the
            gentle down-then-up slope.
   ============================================================ */
window.OSI = (function () {
  "use strict";

  const payload = { bytes: 17, text: '{"user_id":12345}' };

  // Canonical encapsulation order. Block area ∝ bytes; colour = the node
  // that adds/strips it. Fields + tool output feed the tap inspector.
  const ORDER = [
    { key: "app", color: "--c-app", bytes: payload.bytes,
      decode: "payload  " + payload.text,
      fields: [payload.text + "   (" + payload.bytes + " bytes — the whole point of the request)"],
      tool: { cmd: "# what the app handed to the socket", out: payload.text } },
    { key: "http", color: "--c-http", bytes: 80,
      decode: "HTTP  GET /api/users/12345",
      fields: ["GET /api/users/12345 HTTP/2", "content-type: application/json"],
      tool: { cmd: "curl -v https://api-service/api/users/12345",
        out: "> GET /api/users/12345 HTTP/2\n> content-type: application/json" } },
    { key: "tls", color: "--c-tls", bytes: 29,
      decode: "TLS 1.3  Application Data (encrypted)",
      fields: ["TLSv1.3 · AES-128-GCM", "record: Application Data (23)"],
      tool: { cmd: "openssl s_client -connect api-service:443",
        out: "Cipher: TLS_AES_128_GCM_SHA256\nApplication Data (23), len 74   # ciphertext" } },
    { key: "tcp", color: "--c-tcp", bytes: 20,
      decode: "TCP  52134 → 443  seq 1001  [ACK,PSH]",
      fields: ["sport 52134 → dport 443", "seq 1001 · ack 5001", "flags [ACK,PSH]"],
      tool: { cmd: "ss -tiep dst 10.244.2.10",
        out: "ESTAB 10.244.1.5:52134 10.244.2.10:443\n  mss:1460 bytes_sent:74" } },
    { key: "ip", color: "--c-ip", bytes: 20,
      decode: "IP  10.244.1.5 → 10.244.2.10  ttl 64",
      fields: ["src 10.244.1.5 → dst 10.244.2.10", "ttl 64 · proto TCP(6)"],
      tool: { cmd: "ip route get 10.244.2.10",
        out: "10.244.2.10 via 10.244.1.1 dev eth0 src 10.244.1.5" } },
    { key: "vxlan", color: "--c-vxlan", bytes: 50,
      decode: "VXLAN  192.168.1.10 → .11  udp 4789  vni 42",
      fields: ["outer 192.168.1.10 → 192.168.1.11", "udp 4789 · vni 42 (L2 frame over the underlay)"],
      tool: { cmd: "tcpdump -ni eth0 'udp port 4789'",
        out: "IP 192.168.1.10 > 192.168.1.11: VXLAN vni 42\n  IP 10.244.1.5.52134 > 10.244.2.10.443: tcp 74" } }
  ];

  // The valley: down the client stack, across the underlay (flat bottom
  // between the two VXLAN nodes), then up the server stack.
  const nodes = [
    { name: "Client",  sub: "frontend · 10.244.1.5",     icon: "🖥️", n: 1 },
    { name: "HTTP",    sub: "request framing",            icon: "🌐", n: 2 },
    { name: "TLS",     sub: "encryption",                 icon: "🔒", n: 3 },
    { name: "TCP",     sub: "transport",                  icon: "🔌", n: 4 },
    { name: "IP",      sub: "network",                    icon: "🧭", n: 5 },
    { name: "VXLAN",   sub: "overlay · client CNI",       icon: "🛰️", n: 6 },
    { name: "VXLAN",   sub: "overlay · server CNI",       icon: "🛰️", n: 6 },
    { name: "IP",      sub: "kernel routing",             icon: "🧭", n: 5 },
    { name: "TCP",     sub: "socket",                     icon: "🔌", n: 4 },
    { name: "TLS",     sub: "decrypt",                    icon: "🔒", n: 3 },
    { name: "HTTP",    sub: "parse",                      icon: "🌐", n: 2 },
    { name: "Server",  sub: "api-service · 10.244.2.10",  icon: "🖥️", n: 1 }
  ];

  return { payload: payload, ORDER: ORDER, nodes: nodes };
})();
