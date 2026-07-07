# Encapsulation

An interactive visualization that makes **encapsulation** intuitive: follow one
request as it travels left → right — down the client's stack getting wrapped layer
by layer, across the underlay at the bottom, then back up the server's stack getting
unwrapped, until the bare payload reaches the application.

The data is a big **byte-grid blob**. The bright core is the real application data;
each stop it passes wraps it in one more header — a new coloured block whose **area
is proportional to that header's bytes**. Watch the core shrink to a sliver as
delivery metadata piles on. That ratio — tiny signal, huge envelope — is the whole
point.

> The long-form design rationale lives in [`CONCEPT.md`](./CONCEPT.md).

## Run it

No build step, no dependencies:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
# or just open index.html
```

## How it works

- **Scroll or swipe** to move the data along its track (a camera follows it;
  layer nodes slide in from the right and out to the left). Arrow keys step
  between nodes; the dots at the bottom jump to any layer.
- **Each node's colour is the header it adds** — the node is the legend. No labels
  on the blob itself; meaning is carried by colour and proportion.
- **Tap the data** to open the inspector: a Wireshark-style nested dissection
  of every header currently on the wire, plus the real `tcpdump` / `ss` line you'd
  run to see it. The indentation *is* the encapsulation.

## Layers

Practical TCP/IP cloud view — no OSI L5/L6:

| Block | Header | Bytes |
|-------|--------|-------|
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
- `app.js` — the camera, the data blob, input, and the inspector

## Not yet built

- The **response**: a second packet travelling back from the server to the client.
  This build covers one full delivery — down the client stack, across the underlay,
  and back up to the server application.
