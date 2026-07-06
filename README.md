# Packet Journey

An interactive visualization that makes **encapsulation** intuitive: follow one
request as it travels left → right and gets wrapped, layer by layer, for delivery.

The packet is a big blob of concentric **colour rings**. The bright core is the
real application data; each stop it passes wraps it in one more header — a new
ring whose **area is proportional to that header's bytes**. Watch the core shrink
to a sliver as delivery metadata piles on. That ratio — tiny signal, huge
envelope — is the whole point.

> The long-form design rationale lives in [`CONCEPT.md`](./CONCEPT.md).

## Run it

No build step, no dependencies:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
# or just open index.html
```

## How it works

- **Scroll or swipe** to move the packet along its track (a camera follows it;
  layer nodes slide in from the right and out to the left). Arrow keys step
  between nodes; the dots at the bottom jump to any layer.
- **Each node's colour is the ring it adds** — the node is the legend. No labels
  on the blob itself; meaning is carried by colour and proportion.
- **Tap the packet** to open the inspector: a Wireshark-style nested dissection
  of every header currently on the wire, plus the real `tcpdump` / `ss` line you'd
  run to see it. The indentation *is* the encapsulation.

## Layers

Practical TCP/IP cloud view — no OSI L5/L6:

| Ring | Header | Bytes |
|------|--------|-------|
| core | application data | the payload |
| HTTP | request framing | 80 |
| TLS  | encryption | 29 |
| TCP  | transport (ports, seq) | 20 |
| IP   | network (addresses, TTL) | 20 |
| VXLAN | overlay tunnel | 50 |

## Accessibility

Colour-blind-safe palette (Okabe–Ito derived); meaning never rests on hue alone —
nodes carry icons and labels, and the inspector spells out every field in text.
Full keyboard control; `prefers-reduced-motion` is honoured.

## Files

- `index.html` — structure
- `styles.css` — theme, the blob, nodes, inspector
- `data.js` — the ordered list of layer-nodes (colour, bytes, header fields, tool output)
- `app.js` — the camera, the ring blob, input, and the inspector

## Not yet built

- The **return leg**: the packet decapsulating up the server's stack and the
  response travelling back. This prototype covers the encapsulation descent.
