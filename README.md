# Packet Journey

An interactive visualization that demystifies how a single request is **wrapped,
shipped, and unwrapped** as it moves through a cloud network — encapsulation and
decapsulation made concrete.

It follows one `GET /api/users/12345` down the client's stack, across the underlay
network, and up the server's stack, along a **U-shaped path**. The packet grows a
coloured shell at every layer on the way down and sheds them on the way up.

> The long-form design rationale (and the more ambitious "someday" ideas) live in
> [`CONCEPT.md`](./CONCEPT.md). This app is the buildable first cut of that vision.

## Run it

No build step, no dependencies. Either:

```bash
# option A: just open it
open index.html            # macOS  (xdg-open on Linux)

# option B: serve it (recommended)
python3 -m http.server 8000
# then visit http://localhost:8000
```

## The layer model

We deliberately use the **practical TCP/IP model**, not the OSI 7-layer chart:

| Stop | Header | Cloud construct |
|------|--------|-----------------|
| **Application** | HTTP framing + payload — **TLS is an optional toggle** | gRPC/REST, TLS/mTLS |
| **Transport** | ports, sequence, flags | TCP socket (kernel) |
| **Network** | src/dst IP, TTL, protocol; kube-proxy DNAT | pod IP, VPC/CNI |
| **Overlay** *(not a numbered layer)* | outer node IPs, VNI | VXLAN/Geneve tunnel |

There is no OSI L5/L6. Session has no encapsulation artifact to draw, and "L6" in
the cloud is really just TLS — which is modelled as an encryption **transformation
inside Application** (flip the *TLS* toggle to seal the payload and watch every
downstream layer go blind). In production nobody debugs "a Layer 6 problem"; they
debug a TLS handshake, so the tool speaks that language.

## Two modes

- **Explore** — free-form. Hit **↻ New packet** to randomise the payload size and
  watch **Signal purity** swing from ~5 % (a tiny JSON blob is almost all envelope)
  to ~90 % (a full-MSS segment is almost all data). This is the honest lesson:
  per-packet overhead is roughly fixed, so efficiency is all about payload size.
  Flip **Round trip** on to send the response back too — the block bounces at the
  server and returns, and the big response reads far purer than the tiny request.
  Flip **Handshake** on to prepend the TCP three-way handshake: three payload-less
  segments at **0 % signal**, with each end's connection state advancing to
  ESTABLISHED before any data moves.
- **Diagnose** — pick a real production failure (connection refused via SYN→RST,
  a firewall silently dropping the SYN, mTLS expiry, MTU black hole, overlay black
  hole). Guess which layer breaks, then watch the packet fail at exactly that
  point — including mid-handshake, with the connection state shown on each pod —
  using the real `tcpdump` / `ss` / `openssl` output you'd use to find it and the fix.

## Controls

| Action | How |
|--------|-----|
| Advance / rewind | **Scroll** ↕/↔ over the stage, drag the **scrubber**, or press <kbd>←</kbd>/<kbd>→</kbd> |
| Auto-play | **▶** or <kbd>Space</kbd>; change **Speed** (0.5×–4×) |
| Jump to ends | ⏮ / ⏭ or <kbd>Home</kbd> / <kbd>End</kbd> |
| **Highlight readers** | Dims everything a component can't see — every layer is a blind courier reading only its own envelope |
| **Tool output** | Shows the real command output at each step |
| **TLS / Cross-node** | Toggle encryption and the inter-node VXLAN overlay |
| **Handshake** | Prepend the TCP three-way handshake (SYN/SYN-ACK/ACK) with live connection state |
| **Round trip** | Follow the response back from server to client, not just the request |
| **Reduce motion** | Honoured automatically from your OS setting; toggle to override |

## Accessibility

- Every layer is labelled with text, never colour alone.
- Full keyboard control; a live region announces each step and its purity.
- `prefers-reduced-motion` is respected (snaps instead of animating).
- The scroll-to-advance interaction is an enhancement — buttons, the scrubber, and
  the keyboard all do the same job for anyone who can't or doesn't want to scroll.

## Known simplifications / not yet built

- Diagnose scenarios stop at the first failure — a broken request never produces
  a response, which is itself the point (no answer comes back).
- Header byte sizes are representative, not exact per-packet (TLS/TCP options vary).
- L4 is modelled as TCP; QUIC/HTTP-3 over UDP is left for a later pass.

## Files

- `index.html` — structure
- `styles.css` — theme, the nested-shell block, layout, reduced-motion
- `data.js` — layer model, per-step narration, tool output, failure scenarios
- `app.js` — state, rendering, and all controls
