/* ============================================================
   data.js — the whole model for the simplified Packet Journey.
   A single ordered list of layer-nodes the packet passes, each
   adding a header (a colour + a byte count + real header fields).
   Exposes window.OSI = { payload, nodes }.
   ============================================================ */
window.OSI = (function () {
  "use strict";

  // The one thing the application actually cares about.
  const payload = { bytes: 17, text: '{"user_id":12345}' };

  // Encapsulation order, left → right. Index 0 is the origin (the app data
  // core); every node after it wraps the packet in one more header.
  const nodes = [
    {
      id: "app", name: "Client", sub: "frontend · 10.244.1.5",
      icon: "🖥️", color: "--c-app", layer: "app", bytes: payload.bytes,
      decode: "payload  " + payload.text,
      fields: [payload.text + "   (" + payload.bytes + " bytes — the whole point of the request)"],
      tool: { cmd: "# what the app handed to the socket", out: payload.text }
    },
    {
      id: "http", name: "HTTP", sub: "request framing",
      icon: "🌐", color: "--c-http", layer: "http", bytes: 80,
      decode: "HTTP  GET /api/users/12345",
      fields: ["GET /api/users/12345 HTTP/2", "content-type: application/json"],
      tool: { cmd: "curl -v https://api-service/api/users/12345",
        out: "> GET /api/users/12345 HTTP/2\n> content-type: application/json" }
    },
    {
      id: "tls", name: "TLS", sub: "encryption",
      icon: "🔒", color: "--c-tls", layer: "tls", bytes: 29,
      decode: "TLS 1.3  Application Data (encrypted)",
      fields: ["TLSv1.3 · AES-128-GCM", "record: Application Data (23)"],
      tool: { cmd: "openssl s_client -connect api-service:443",
        out: "Cipher: TLS_AES_128_GCM_SHA256\nApplication Data (23), len 74   # now ciphertext" }
    },
    {
      id: "tcp", name: "TCP", sub: "transport",
      icon: "🔌", color: "--c-tcp", layer: "tcp", bytes: 20,
      decode: "TCP  52134 → 443  seq 1001  [ACK,PSH]",
      fields: ["sport 52134 → dport 443", "seq 1001 · ack 5001", "flags [ACK,PSH]"],
      tool: { cmd: "ss -tiep dst 10.244.2.10",
        out: "ESTAB 10.244.1.5:52134 10.244.2.10:443\n  mss:1460 bytes_sent:74" }
    },
    {
      id: "ip", name: "IP", sub: "network",
      icon: "🧭", color: "--c-ip", layer: "ip", bytes: 20,
      decode: "IP  10.244.1.5 → 10.244.2.10  ttl 64",
      fields: ["src 10.244.1.5 → dst 10.244.2.10", "ttl 64 · proto TCP(6)"],
      tool: { cmd: "ip route get 10.244.2.10",
        out: "10.244.2.10 via 10.244.1.1 dev eth0 src 10.244.1.5" }
    },
    {
      id: "vxlan", name: "VXLAN", sub: "overlay tunnel",
      icon: "🛰️", color: "--c-vxlan", layer: "vxlan", bytes: 50,
      decode: "VXLAN  192.168.1.10 → .11  udp 4789  vni 42",
      fields: ["outer 192.168.1.10 → 192.168.1.11", "udp 4789 · vni 42"],
      tool: { cmd: "tcpdump -ni eth0 'udp port 4789'",
        out: "IP 192.168.1.10 > 192.168.1.11: VXLAN vni 42\n  IP 10.244.1.5.52134 > 10.244.2.10.443: tcp 74" }
    }
  ];

  return { payload: payload, nodes: nodes };
})();
