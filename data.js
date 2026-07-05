/* ============================================================
   data.js — all content: layer model, per-step narration,
   realistic tool output, and failure scenarios.
   Exposes a single global: window.OSI
   ============================================================ */
(function () {
  "use strict";

  // ---- Layer model (TCP/IP practical view; no OSI L5/L6) ----
  const LAYERS = {
    body:  { name: "App data", desc: "the actual request",        varColor: "--l-body"  },
    http:  { name: "HTTP",     desc: "method, path, headers",      varColor: "--l-http"  },
    tls:   { name: "TLS",      desc: "encryption + record header", varColor: "--l-tls"   },
    tcp:   { name: "TCP",      desc: "ports, sequence, flags",     varColor: "--l-tcp"   },
    ip:    { name: "IP",       desc: "host addresses, TTL",        varColor: "--l-ip"    },
    vxlan: { name: "VXLAN",    desc: "node-to-node tunnel",        varColor: "--l-vxlan" }
  };

  // Fixed header sizes in bytes (body is the variable payload).
  const SIZES = { http: 80, tls: 29, tcp: 20, ip: 20, vxlan: 50 };

  // Mono field text shown on each shell tab.
  const FIELDS = {
    http:  () => "GET /api/users/12345 · application/json",
    tls:   () => "TLSv1.3 · AES-128-GCM · AppData(23)",
    tcp:   () => ":52134 → :443 · seq 1001 · [ACK,PSH]",
    ip:    (ttl) => "10.244.1.5 → 10.244.2.10 · TTL " + ttl + " · TCP",
    vxlan: () => "192.168.1.10 → .11 · UDP4789 · VNI 42"
  };

  // ---- Per-step narration + tool output ----
  const STEP = {
    body: {
      chip: "Application", title: "The application writes its data",
      why: "This is the entire point of the request — the actual bytes the service cares about. Everything that follows is delivery machinery wrapped around it.",
      reader: { who: "Application code", sees: "the raw payload" },
      tool: { cmd: "# what the application handed to the socket", out: null } // filled from payload
    },
    http: {
      chip: "Application", title: "HTTP frames the request",
      why: "HTTP adds a method, path and headers so the server knows what is being asked. Notice the framing is already bigger than the data it carries.",
      reader: { who: "HTTP library", sees: "method, path, headers + body" },
      tool: { cmd: "curl -v https://api-service/api/users/12345", out:
        "> GET /api/users/12345 HTTP/2\n> :authority: api-service.default.svc\n> content-type: application/json" }
    },
    tls: {
      chip: "Application", title: "TLS encrypts everything above Transport",
      why: "The payload and its HTTP framing are sealed into ciphertext. From here down, no one — not the kernel, not a single router — can read what the request actually says.",
      reader: { who: "TLS library", sees: "plaintext in, ciphertext out" },
      tool: { cmd: "openssl s_client -connect api-service:443 -tls1_3", out:
        "SSL-Session: Protocol TLSv1.3\n  Cipher: TLS_AES_128_GCM_SHA256\nwrite: Application Data (23), len 74   # your request — now ciphertext" }
    },
    tcp: {
      chip: "Transport", title: "TCP adds ports and sequencing",
      why: "Ports pick the right process (443 → the server's listener); sequence numbers make the byte stream reliable and ordered. TCP has no idea what the bytes mean.",
      reader: { who: "Kernel (TCP)", sees: "ports, seq/ack, flags — not the payload" },
      tool: { cmd: "ss -tiep dst 10.244.2.10", out:
        "ESTAB 0 0 10.244.1.5:52134 10.244.2.10:443\n  cubic wscale:7,7 rtt:0.42/0.11 mss:1460\n  bytes_sent:74 segs_out:1" }
    },
    ip: {
      chip: "Network", title: "IP adds source & destination addresses",
      why: "IP is the host-to-host address label. kube-proxy also rewrites the Service ClusterIP to the real pod IP here (DNAT). Routers read this label and nothing inside.",
      reader: { who: "Kernel routing / kube-proxy", sees: "src/dst IP, TTL — inside is opaque" },
      tool: { cmd: "ip route get 10.244.2.10", out:
        "10.244.2.10 via 10.244.1.1 dev eth0 src 10.244.1.5\n# kube-proxy DNAT: 10.100.200.42 (ClusterIP) -> 10.244.2.10 (pod)" }
    },
    vxlan: {
      chip: "Overlay", title: "The CNI wraps the whole packet in VXLAN",
      why: "To cross between nodes, the entire packet becomes cargo inside a new UDP packet addressed node-to-node. The pod IPs are now a sealed manifest the physical network never opens.",
      reader: { who: "CNI / node", sees: "outer node IPs, VNI" },
      tool: { cmd: "tcpdump -ni eth0 'udp port 4789'", out:
        "IP 192.168.1.10.51002 > 192.168.1.11.4789: VXLAN, vni 42\n    IP 10.244.1.5.52134 > 10.244.2.10.443: tcp 74   <-- whole inner packet, as cargo" }
    },
    transit: {
      chip: "Overlay", title: "The underlay routes on the outer label only",
      why: "Every router between the nodes reads just the outer VXLAN/IP header. Your pod IP, your TCP ports, your ciphertext — one indistinguishable blob of cargo. TTL ticks down each hop.",
      reader: { who: "Underlay router", sees: "only the outer node-to-node header" },
      tool: { cmd: "mtr -zbw 192.168.1.11", out:
        "1. 192.168.1.10   0.0%   0.3ms\n2. 10.0.0.1       0.0%   0.6ms   # sees only node IPs\n3. 192.168.1.11   0.0%   0.5ms   # TTL 64 -> 61" }
    },
    local: {
      chip: "Network", title: "The packet crosses node-local (veth → bridge)",
      why: "Both pods live on the same node, so there's no tunnel — the packet hops across a virtual bridge between veth pairs. No VXLAN overhead at all.",
      reader: { who: "Node bridge", sees: "the IP header" },
      tool: { cmd: "bridge fdb show | grep 10.244", out:
        "# same node: veth -> cbr0 -> veth, no tunnel\nIP 10.244.1.5.52134 > 10.244.1.9.443: tcp 74" }
    },
    "vxlan-strip": {
      chip: "Overlay", title: "The destination node strips VXLAN",
      why: "worker-2 recognises its own address on the outer header, peels the tunnel away, and hands the original inner packet to its kernel.",
      reader: { who: "Destination node", sees: "outer header, then discards it" },
      tool: { cmd: "tcpdump -ni vxlan.calico", out:
        "IP 10.244.1.5.52134 > 10.244.2.10.443: tcp 74   # decapsulated: outer header gone" }
    },
    "ip-strip": {
      chip: "Network", title: "The kernel checks the destination IP",
      why: "The IP header's destination matches this pod, so the kernel accepts the packet and removes the IP label.",
      reader: { who: "Kernel (IP)", sees: "dst IP matches — strip" },
      tool: { cmd: "conntrack -L -d 10.244.2.10", out:
        "tcp 6 ESTABLISHED src=10.244.1.5 dst=10.244.2.10\n  sport=52134 dport=443 [ASSURED]" }
    },
    "tcp-strip": {
      chip: "Transport", title: "TCP delivers to the listening socket",
      why: "Destination port 443 maps to the process listening there. TCP places the bytes in that socket's buffer and acknowledges receipt to the sender.",
      reader: { who: "Kernel (socket)", sees: "dst port → socket, sends ACK" },
      tool: { cmd: "ss -tlnp 'sport = :443'", out:
        "LISTEN 0 4096 *:443  users:((\"envoy\",pid=1,fd=18))\n# port 443 -> envoy: bytes handed to the socket, ACK sent" }
    },
    "tls-decrypt": {
      chip: "Application", title: "TLS decrypts the payload",
      why: "Only now, after every delivery layer has done its job, is the ciphertext turned back into a readable request. This is the first point anything can see the content again.",
      reader: { who: "TLS library", sees: "ciphertext in, plaintext out" },
      tool: { cmd: "# envoy access log", out:
        "[info] TLS handshake complete, SNI=api-service\n[info] decrypted 74B application data" }
    },
    "app-consume": {
      chip: "Application", title: "The application reads the request",
      why: "The HTTP framing is parsed and the handler runs against the original payload — delivered intact. 100% signal again; every wrapper has been shed.",
      reader: { who: "Application code", sees: "the raw payload — delivered" },
      tool: { cmd: "# application log", out:
        "GET /api/users/12345 200  handler=getUser  dur=1.2ms\n# payload delivered intact — 100% signal" }
    }
  };

  const SEND_IDS = ["body", "http", "tls", "tcp", "ip"];
  const RECV_IDS = ["vxlan-strip", "ip-strip", "tcp-strip", "tls-decrypt", "app-consume"];

  function legFor(id) {
    if (SEND_IDS.indexOf(id) !== -1) return "L";
    if (id === "vxlan" || id === "transit" || id === "local") return "B";
    return "R";
  }

  function shellsFor(id, tls) {
    const base = tls ? ["body", "http", "tls"] : ["body", "http"];
    const withTcp = base.concat("tcp");
    const withIp = withTcp.concat("ip");
    const withVx = withIp.concat("vxlan");
    switch (id) {
      case "body": return ["body"];
      case "http": return ["body", "http"];
      case "tls":  return base.slice();
      case "tcp":  return withTcp;
      case "ip":   return withIp;
      case "vxlan":
      case "transit": return withVx;
      case "local":
      case "vxlan-strip": return withIp;
      case "ip-strip": return withTcp;
      case "tcp-strip": return base.slice();
      case "tls-decrypt": return ["body", "http"];
      case "app-consume": return ["body"];
      default: return ["body"];
    }
  }

  // Build the ordered list of step ids for a given configuration.
  function buildStepIds(opts) {
    const send = ["body", "http", opts.tls ? "tls" : null, "tcp", "ip"].filter(Boolean);
    const net = opts.crossNode ? ["vxlan", "transit"] : ["local"];
    const recv = [
      opts.crossNode ? "vxlan-strip" : null,
      "ip-strip", "tcp-strip",
      opts.tls ? "tls-decrypt" : null,
      "app-consume"
    ].filter(Boolean);
    return send.concat(net, recv);
  }

  // Full step objects (geometry + shell state). Narration merged in app.js.
  function buildSteps(opts) {
    const ids = buildStepIds(opts);
    let seenTransit = false;
    return ids.map(function (id) {
      if (id === "transit" || legFor(id) === "R") seenTransit = true;
      const shells = shellsFor(id, opts.tls);
      return {
        id: id,
        leg: legFor(id),
        shells: shells,
        ciphered: shells.indexOf("tls") !== -1,
        ttl: seenTransit ? 61 : 64
      };
    });
  }

  // ---- Failure scenarios (Diagnose mode) ----
  const SCENARIOS = [
    {
      key: "refused",
      label: "Connection refused — nothing listening on the port",
      opts: { tls: false, crossNode: true },
      payload: { bytes: 17, text: '{"user_id": 12345}' },
      breakId: "tcp-strip",
      quiz: { options: ["Application", "Transport", "Network", "Overlay"], answer: "Transport" },
      failLabel: "RST",
      verdict: {
        symptom: "curl: (7) Failed to connect — Connection refused, instantly.",
        cause: "The packet reached the server, but nothing is listening on port 443. The kernel answers the SYN with a TCP RST. Encapsulation never even reaches the application.",
        fix: "Compare the Service targetPort with the container's listening port (`ss -tlnp`). Start the process or fix the port mapping."
      },
      tool: { cmd: "ss -tlnp 'sport = :443'", out:
        "# (no rows) — nothing is listening on :443\ntcpdump: 10.244.1.5.52134 > 10.244.2.10.443: Flags [S]\n         10.244.2.10.443 > 10.244.1.5.52134: Flags [R.]   <-- RST" }
    },
    {
      key: "mtls",
      label: "mTLS handshake failure — expired certificate",
      opts: { tls: true, crossNode: true },
      payload: { bytes: 17, text: '{"user_id": 12345}' },
      breakId: "tls-decrypt",
      quiz: { options: ["Application", "Transport", "Network", "Overlay"], answer: "Application" },
      failLabel: "🔒✗",
      verdict: {
        symptom: "upstream connect error: TLS_error: certificate has expired.",
        cause: "Transport and Network did their jobs — the bytes arrived at the socket. But the server's sidecar certificate is expired, so the handshake fails and the payload is never decrypted. This is NOT a port or routing problem.",
        fix: "Rotate the sidecar cert / check cert-manager: `openssl s_client -connect … | openssl x509 -noout -dates`."
      },
      tool: { cmd: "openssl s_client -connect api-service:443", out:
        "verify error:num=10:certificate has expired\nnotAfter=Jun 30 00:00:00 2026 GMT\n--- handshake failed, payload never decrypted" }
    },
    {
      key: "mtu",
      label: "MTU black hole — large response times out",
      opts: { tls: true, crossNode: true },
      payload: { bytes: 1460, text: '{"records":[ …1,460 B… ]}' },
      breakId: "transit",
      quiz: { options: ["Application", "Transport", "Network", "Overlay"], answer: "Overlay" },
      failLabel: "✂ MTU",
      verdict: {
        symptom: "Small requests fine; the big JSON blob hangs and times out. Pings work.",
        cause: "The full-size packet plus the 50-byte VXLAN header exceeds the path MTU. The DF bit forbids fragmentation, so the router drops it — and the ICMP 'fragmentation needed' reply is blocked by a firewall. You see it only by the absence of large packets.",
        fix: "Clamp MSS on the tunnel (e.g. MSS 1360) or raise the underlay MTU; allow ICMP type 3 code 4."
      },
      tool: { cmd: "ping -M do -s 1472 10.244.2.10", out:
        "# small packets succeed:\n64 bytes from 10.244.2.10: seq=1 ttl=63 time=0.5 ms\n# with DF + full size:\nping: local error: message too long, mtu=1450\ntcpdump: large frames leave, none return" }
    },
    {
      key: "overlay",
      label: "Overlay black hole — missing CNI route",
      opts: { tls: true, crossNode: true },
      payload: { bytes: 17, text: '{"user_id": 12345}' },
      breakId: "transit",
      quiz: { options: ["Application", "Transport", "Network", "Overlay"], answer: "Overlay" },
      failLabel: "⦸ dropped",
      verdict: {
        symptom: "Same-node pod traffic works; cross-node traffic to 10.244.2.0/24 vanishes.",
        cause: "The VXLAN packet is built and sent, but the underlay has no route (or a blocked UDP 4789 / broken BGP peering) to worker-2's tunnel endpoint. The packet drops into the void between nodes.",
        fix: "Check `ip route`, CNI status (calicoctl / cilium status), VPC route tables for the pod CIDR, and security-group rules for UDP 4789."
      },
      tool: { cmd: "ip route get 192.168.1.11", out:
        "RTNETLINK answers: Network is unreachable\ncalico-node: BIRD: BGP peer 192.168.1.11 Idle" }
    }
  ];

  // ---- Random payloads for Explore mode ----
  const PAYLOAD_TIERS = [
    { w: 3, min: 8,    max: 40,   make: function (b) {
        const opts = ['{"ok":true}', '{"id":7}', '{"user_id":12345}', '{"ping":1}', '{"q":"cats"}'];
        return opts[Math.floor(Math.random() * opts.length)];
      } },
    { w: 2, min: 180,  max: 620,  make: function (b) { return '{"user":{ …profile, ' + b + ' B… }}'; } },
    { w: 2, min: 1200, max: 1460, make: function (b) { return '{"records":[ …' + b.toLocaleString() + ' B, full segment… ]}'; } }
  ];

  function newPayload() {
    const total = PAYLOAD_TIERS.reduce(function (s, t) { return s + t.w; }, 0);
    let r = Math.random() * total, tier = PAYLOAD_TIERS[0];
    for (let i = 0; i < PAYLOAD_TIERS.length; i++) {
      r -= PAYLOAD_TIERS[i].w;
      if (r <= 0) { tier = PAYLOAD_TIERS[i]; break; }
    }
    const bytes = Math.floor(tier.min + Math.random() * (tier.max - tier.min));
    return { bytes: bytes, text: tier.make(bytes) };
  }

  window.OSI = {
    LAYERS: LAYERS, SIZES: SIZES, FIELDS: FIELDS, STEP: STEP,
    SCENARIOS: SCENARIOS,
    buildSteps: buildSteps, buildStepIds: buildStepIds,
    shellsFor: shellsFor, newPayload: newPayload
  };
})();
