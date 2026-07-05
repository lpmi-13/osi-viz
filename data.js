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

  // Mono field text shown on each shell tab. `s` is the step (reads .ttl, .dir);
  // on the response leg the source/destination fields are swapped.
  const FIELDS = {
    http:  (s) => s.dir === "resp" ? "HTTP/2 200 OK · application/json" : "GET /api/users/12345 · application/json",
    tls:   (s) => "TLSv1.3 · AES-128-GCM · AppData(23)",
    tcp:   (s) => {
      const ports = s.dir === "resp" ? ":443 → :52134" : ":52134 → :443";
      if (s.ctl) return "[" + s.ctl.replace("·", ",") + "] " + ports + " · seq 0";
      return ports + (s.dir === "resp" ? " · seq 5001 · [ACK,PSH]" : " · seq 1001 · [ACK,PSH]");
    },
    ip:    (s) => s.dir === "resp"
      ? "10.244.2.10 → 10.244.1.5 · TTL " + s.ttl + " · TCP"
      : "10.244.1.5 → 10.244.2.10 · TTL " + s.ttl + " · TCP",
    vxlan: (s) => s.dir === "resp" ? "192.168.1.11 → .10 · UDP4789 · VNI 42" : "192.168.1.10 → .11 · UDP4789 · VNI 42"
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
    },

    // ---- Response leg (server → client) ----
    "r-body": {
      chip: "Application", title: "The handler builds the response",
      why: "The server's code produces the answer the client asked for. A response usually carries far more data than the tiny request that triggered it — watch the signal purity climb.",
      reader: { who: "Application code (server)", sees: "the response payload" },
      tool: { cmd: "# handler return value", out: null }
    },
    "r-http": {
      chip: "Application", title: "HTTP frames the 200 response",
      why: "A status line and headers are added so the client knows the request succeeded and how to read the body.",
      reader: { who: "HTTP library", sees: "status, headers + body" },
      tool: { cmd: "# response head", out:
        "< HTTP/2 200 OK\n< content-type: application/json\n< content-length: 48" }
    },
    "r-tls": {
      chip: "Application", title: "TLS encrypts the response",
      why: "The same session key seals the response into ciphertext. The client is the only party that can read it.",
      reader: { who: "TLS library", sees: "plaintext → ciphertext" },
      tool: { cmd: "# envoy", out: "[info] encrypting application data on session api-service" }
    },
    "r-tcp": {
      chip: "Transport", title: "TCP sends from :443 back to the client",
      why: "Source and destination ports are swapped: the response leaves 443 for the client's ephemeral 52134, on the very same connection.",
      reader: { who: "Kernel (TCP)", sees: "ports swapped, seq/ack advance" },
      tool: { cmd: "ss -tiep sport = :443", out:
        "ESTAB 0 0 10.244.2.10:443 10.244.1.5:52134\n  bytes_acked:74 bytes_sent:48" }
    },
    "r-ip": {
      chip: "Network", title: "IP addresses it back to the client pod",
      why: "Source and destination IPs swap; the packet is routed back toward 10.244.1.5.",
      reader: { who: "Kernel routing", sees: "src/dst IP swapped" },
      tool: { cmd: "ip route get 10.244.1.5", out:
        "10.244.1.5 via 10.244.2.1 dev eth0 src 10.244.2.10" }
    },
    "r-vxlan": {
      chip: "Overlay", title: "The CNI tunnels the response back to worker-1",
      why: "Cross-node again, the other way: the response becomes cargo in a node-to-node VXLAN packet, worker-2 → worker-1.",
      reader: { who: "CNI / node", sees: "outer node IPs (swapped)" },
      tool: { cmd: "tcpdump -ni eth0 'udp port 4789'", out:
        "IP 192.168.1.11.51002 > 192.168.1.10.4789: VXLAN, vni 42\n    IP 10.244.2.10.443 > 10.244.1.5.52134: tcp 48" }
    },
    "r-transit": {
      chip: "Overlay", title: "The underlay routes the response back",
      why: "Same blind couriers, opposite direction: routers see only the outer worker-node header.",
      reader: { who: "Underlay router", sees: "outer node-to-node header only" },
      tool: { cmd: "mtr -zbw 192.168.1.10", out:
        "1. 192.168.1.11   0.0%   0.3ms\n2. 10.0.0.1       0.0%   0.5ms\n3. 192.168.1.10   0.0%   0.4ms" }
    },
    "r-vxlan-strip": {
      chip: "Overlay", title: "worker-1 strips the VXLAN header",
      why: "The client's node recognises its own outer address and peels the tunnel away.",
      reader: { who: "Destination node (worker-1)", sees: "outer header, then discards it" },
      tool: { cmd: "tcpdump -ni vxlan.calico", out:
        "IP 10.244.2.10.443 > 10.244.1.5.52134: tcp 48   # decapsulated" }
    },
    "r-ip-strip": {
      chip: "Network", title: "The client kernel checks the destination IP",
      why: "Destination 10.244.1.5 matches the client pod, so the kernel accepts it and removes the IP header.",
      reader: { who: "Kernel (IP)", sees: "dst IP matches — strip" },
      tool: { cmd: "conntrack -L -s 10.244.2.10", out:
        "tcp 6 ESTABLISHED src=10.244.1.5 dst=10.244.2.10 [ASSURED]" }
    },
    "r-tcp-strip": {
      chip: "Transport", title: "TCP hands the bytes to the waiting socket",
      why: "Destination port 52134 is the socket the client has been blocked on. The bytes go into its receive buffer.",
      reader: { who: "Kernel (socket)", sees: "dst port → the open connection" },
      tool: { cmd: "ss -tiep dst 10.244.2.10", out:
        "ESTAB 0 0 10.244.1.5:52134 10.244.2.10:443\n  bytes_received:48" }
    },
    "r-tls-decrypt": {
      chip: "Application", title: "TLS decrypts the response",
      why: "The client turns the ciphertext back into readable JSON — the first point the client can see the answer.",
      reader: { who: "TLS library", sees: "ciphertext → plaintext" },
      tool: { cmd: "# client tls", out: "[info] decrypted application data" }
    },
    "r-app-consume": {
      chip: "Application", title: "The client receives the response",
      why: "The round trip is complete: the frontend has the data it asked for and can render it. Full circle — back where we started, top-left.",
      reader: { who: "Application code (client)", sees: "the response payload — delivered" },
      tool: { cmd: "# frontend", out: "200 OK — response rendered\n# full round trip complete" }
    },

    // ---- TCP three-way handshake (before any data) ----
    "h-syn-send": {
      chip: "Transport", title: "Client sends SYN",
      why: "Before a single byte of data, TCP opens the connection. The client sends a segment with only the SYN flag set and no application payload — 0% signal, 100% control.",
      reader: { who: "Kernel (TCP)", sees: "SYN flag, initial sequence number" },
      tool: { cmd: "ss -tan state syn-sent", out:
        "SYN-SENT 0 1 10.244.1.5:52134 10.244.2.10:443\ntcpdump: 10.244.1.5 > 10.244.2.10: Flags [S], seq 0" }
    },
    "h-syn-net": {
      chip: "Overlay", title: "SYN crosses the network",
      why: "The SYN is wrapped in IP (and VXLAN) and routed to the server just like a data packet — but it carries nothing to deliver.",
      reader: { who: "Underlay router", sees: "an ordinary packet — 40 bytes, no data" },
      tool: { cmd: "tcpdump -ni eth0 'tcp[tcpflags] & tcp-syn != 0'", out:
        "IP 192.168.1.10 > 192.168.1.11: VXLAN vni 42\n  IP 10.244.1.5.52134 > 10.244.2.10.443: Flags [S]" }
    },
    "h-syn-recv": {
      chip: "Transport", title: "Server receives SYN",
      why: "The server's kernel sees a SYN arrive on a listening port (443) and records a half-open connection in the SYN backlog.",
      reader: { who: "Kernel (socket)", sees: "SYN on a LISTEN socket → SYN-RCVD" },
      tool: { cmd: "ss -tan state listening", out:
        "LISTEN 0 4096 *:443\n# half-open connection queued (SYN-RECV)" }
    },
    "h-sa-send": {
      chip: "Transport", title: "Server replies SYN-ACK",
      why: "The server agrees to the connection: it sends back a segment with both SYN and ACK set, and its own initial sequence number.",
      reader: { who: "Kernel (TCP)", sees: "SYN+ACK flags" },
      tool: { cmd: "tcpdump -ni any 'port 443'", out:
        "IP 10.244.2.10.443 > 10.244.1.5.52134: Flags [S.], seq 0, ack 1" }
    },
    "h-sa-net": {
      chip: "Overlay", title: "SYN-ACK crosses back",
      why: "The acknowledgement is tunnelled back toward the client, worker-2 → worker-1.",
      reader: { who: "Underlay router", sees: "outer node-to-node header only" },
      tool: { cmd: "tcpdump -ni eth0 'udp port 4789'", out:
        "IP 192.168.1.11 > 192.168.1.10: VXLAN vni 42\n  IP 10.244.2.10.443 > 10.244.1.5.52134: Flags [S.]" }
    },
    "h-sa-recv": {
      chip: "Transport", title: "Client receives SYN-ACK",
      why: "The client now considers the connection ESTABLISHED — from its point of view it can start sending data immediately.",
      reader: { who: "Kernel (TCP)", sees: "SYN-ACK → ESTABLISHED (client side)" },
      tool: { cmd: "ss -tan state established dst 10.244.2.10", out:
        "ESTAB 0 0 10.244.1.5:52134 10.244.2.10:443" }
    },
    "h-ack-send": {
      chip: "Transport", title: "Client sends ACK",
      why: "The client acknowledges the server's SYN. This third segment completes the three-way handshake.",
      reader: { who: "Kernel (TCP)", sees: "ACK flag" },
      tool: { cmd: "tcpdump -ni any 'port 443'", out:
        "IP 10.244.1.5.52134 > 10.244.2.10.443: Flags [.], ack 1" }
    },
    "h-ack-net": {
      chip: "Overlay", title: "ACK crosses to the server",
      why: "The final ACK is tunnelled across to the server node.",
      reader: { who: "Underlay router", sees: "an ordinary 40-byte packet" },
      tool: { cmd: "tcpdump -ni eth0 'udp port 4789'", out:
        "IP 192.168.1.10 > 192.168.1.11: VXLAN vni 42\n  IP 10.244.1.5.52134 > 10.244.2.10.443: Flags [.]" }
    },
    "h-ack-recv": {
      chip: "Transport", title: "Handshake complete — ESTABLISHED",
      why: "The server receives the final ACK. Both ends are now ESTABLISHED; only now can the request data actually flow.",
      reader: { who: "Kernel (socket)", sees: "ACK → ESTABLISHED (server side)" },
      tool: { cmd: "ss -tanp state established sport = :443", out:
        "ESTAB 0 0 10.244.2.10:443 10.244.1.5:52134  users:((\"envoy\"))" }
    }
  };

  const SEND_IDS = ["body", "http", "tls", "tcp", "ip"];
  const NET_IDS  = ["vxlan", "transit", "local"];

  function role(base) {
    if (SEND_IDS.indexOf(base) !== -1) return "send";
    if (NET_IDS.indexOf(base) !== -1) return "net";
    return "recv";
  }
  // Which visual leg a step sits on. Legs map to sides, not to direction:
  // the client stack is always the left leg (L), the server stack the right (R).
  function legFor(base, dir) {
    const r = role(base);
    if (r === "net") return "B";
    if (dir === "resp") return r === "send" ? "R" : "L"; // server encapsulates down R, client decaps up L
    return r === "send" ? "L" : "R";                     // request: client down L, server up R
  }
  // Segment 1-6 around the U: request = 1(L↓) 2(B→) 3(R↑); response = 4(R↓) 5(B←) 6(L↑).
  function segFor(base, dir) {
    const r = role(base);
    if (dir === "resp") return r === "send" ? 4 : r === "net" ? 5 : 6;
    return r === "send" ? 1 : r === "net" ? 2 : 3;
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

  const SEGLEG = { 1: "L", 2: "B", 3: "R", 4: "R", 5: "B", 6: "L" };

  // Spread a phase's steps evenly along each of its segments (frac 0..1).
  function assignFracs(steps) {
    const bySeg = {};
    steps.forEach(function (s) { (bySeg[s.seg] = bySeg[s.seg] || []).push(s); });
    Object.keys(bySeg).forEach(function (seg) {
      const g = bySeg[seg];
      g.forEach(function (s, k) { s.frac = g.length > 1 ? k / (g.length - 1) : 0.5; });
    });
    return steps;
  }

  // Build data-carrying step objects for one direction (geometry + shell state).
  function legSteps(opts, dir) {
    const baseIds = buildStepIds(opts);
    let seenTransit = false;
    const steps = baseIds.map(function (base) {
      if (base === "transit" || base === "local" || role(base) === "recv") seenTransit = true;
      const shells = shellsFor(base, opts.tls);
      return {
        id: dir === "resp" ? "r-" + base : base,
        dir: dir, phase: dir,
        leg: legFor(base, dir),
        seg: segFor(base, dir),
        shells: shells,
        ciphered: shells.indexOf("tls") !== -1,
        ttl: seenTransit ? 61 : 64
      };
    });
    return assignFracs(steps);
  }

  // The TCP three-way handshake: three tiny, payload-less segments. Compact
  // (send → transit → receive per packet) so it doesn't dwarf the data journey.
  function buildHandshake(opts) {
    const wrapSend = ["body", "tcp", "ip"];
    const wrapNet = opts.crossNode ? ["body", "tcp", "ip", "vxlan"] : ["body", "tcp", "ip"];
    function S(id, dir, seg, frac, ctl, shells, c, s) {
      return { id: id, dir: dir, phase: "hs", ctl: ctl, seg: seg, frac: frac,
        leg: SEGLEG[seg], shells: shells, ciphered: false, ttl: 64, state: { c: c, s: s } };
    }
    return [
      S("h-syn-send", "req", 1, 0.20, "SYN", wrapSend, "SYN-SENT", "LISTEN"),
      S("h-syn-net",  "req", 2, 0.50, "SYN", wrapNet,  "SYN-SENT", "LISTEN"),
      S("h-syn-recv", "req", 3, 0.85, "SYN", wrapSend, "SYN-SENT", "SYN-RCVD"),
      S("h-sa-send",  "resp", 4, 0.20, "SYN·ACK", wrapSend, "SYN-SENT", "SYN-RCVD"),
      S("h-sa-net",   "resp", 5, 0.50, "SYN·ACK", wrapNet,  "SYN-SENT", "SYN-RCVD"),
      S("h-sa-recv",  "resp", 6, 0.85, "SYN·ACK", wrapSend, "ESTABLISHED", "SYN-RCVD"),
      S("h-ack-send", "req", 1, 0.20, "ACK", wrapSend, "ESTABLISHED", "SYN-RCVD"),
      S("h-ack-net",  "req", 2, 0.50, "ACK", wrapNet,  "ESTABLISHED", "SYN-RCVD"),
      S("h-ack-recv", "req", 3, 0.85, "ACK", wrapSend, "ESTABLISHED", "ESTABLISHED")
    ];
  }

  // Full journey: optional handshake, then the request, then the optional response.
  function buildSteps(opts) {
    let steps = [];
    if (opts.handshake) steps = steps.concat(buildHandshake(opts));
    steps = steps.concat(legSteps(opts, "req"));
    if (opts.roundTrip) steps = steps.concat(legSteps(opts, "resp"));
    return steps;
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

  function pick(tiers) {
    const total = tiers.reduce(function (s, t) { return s + t.w; }, 0);
    let r = Math.random() * total, tier = tiers[0];
    for (let i = 0; i < tiers.length; i++) { r -= tiers[i].w; if (r <= 0) { tier = tiers[i]; break; } }
    const bytes = Math.floor(tier.min + Math.random() * (tier.max - tier.min));
    return { bytes: bytes, text: tier.make(bytes) };
  }
  function newPayload() { return pick(PAYLOAD_TIERS); }

  // Responses return data, so they skew larger than the request that asked for
  // them — which makes the request/response purity contrast land on its own.
  const RESP_TIERS = [
    { w: 3, min: 120,  max: 560,  make: function (b) { return '{"id":12345,"name":"Ada Lovelace","role":"admin"}'; } },
    { w: 2, min: 900,  max: 1400, make: function (b) { return '{"users":[ …' + b.toLocaleString() + ' B, full segment… ]}'; } }
  ];
  function newResponse() { return pick(RESP_TIERS); }

  window.OSI = {
    LAYERS: LAYERS, SIZES: SIZES, FIELDS: FIELDS, STEP: STEP,
    SCENARIOS: SCENARIOS,
    buildSteps: buildSteps, buildStepIds: buildStepIds,
    shellsFor: shellsFor, newPayload: newPayload, newResponse: newResponse
  };
})();
