# OSI Viz

An interactive visualization that makes **encapsulation** intuitive. It shows a
single request as a stack of layers, **all at once**: the bright core is the real
application data; wrapped around it are the HTTP, TLS, TCP, IP and VXLAN headers
that exist only to deliver it.

A proportion bar makes the whole point obvious at a glance — how little of what's
on the wire is the thing you actually asked for. Watch a POST body of a few dozen
bytes sit inside hundreds of bytes of envelope, or a GET that's *pure* envelope
because it carries no body at all.

> The long-form design rationale lives in [`CONCEPT.md`](./CONCEPT.md).

## Run it

No build step, no dependencies:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
# or just open index.html
```

## How it works

- **Every layer is shown at once**, outermost header → data core, each with its
  colour, its byte size and a one-line explanation of what it adds and why.
- **Tap any layer** to expand it in place: its real header fields, a boxy
  RFC-style diagram of the header format, and the actual `tcpdump` / `ss` / `curl`
  line you'd run to see it. Colour is consistent everywhere — the layer's colour
  in the stack, the bar and its expanded detail all match.
- **Prev / Next** (or the ← → arrow keys) step through the story: the client
  wrapping the request layer by layer, and the server unwrapping it. **Replay**
  plays the wrapping as an animation. Nothing is gated behind a gesture.
- **🎲 New request** generates a fresh POST, GET, PUT, PATCH, DELETE or CORS
  preflight — bodies, ports and byte counts all update honestly.

## Layers

Practical TCP/IP cloud view:

| Layer | Adds | Bytes |
|-------|------|-------|
| Data (L7) | the application payload | the body |
| HTTP (L7) | method, path, headers | ~60–120 |
| TLS (L6) | encryption | 29 |
| TCP (L4) | transport (ports, seq) | 20 |
| IP (L3) | network (addresses, TTL) | 20 |
| VXLAN (L2) | overlay tunnel | 50 |

## Accessibility

Colour-blind-safe palette (Okabe–Ito derived); meaning never rests on hue alone —
every layer carries a name, layer number and a plain-language caption, and each
field is spelled out in text. Full keyboard control (arrows step, Home/End jump);
`prefers-reduced-motion` is honoured. A tight Content-Security-Policy and the usual
hardening headers ship in [`_headers`](./_headers).

## Files

- `index.html` — structure
- `styles.css` — theme, the stack, the proportion bar, the layer detail
- `data.js` — the six-layer model + request generator (colour, bytes, captions, header fields, tool output)
- `app.js` — the anatomy render, the step-through, and per-layer expansion

## Not yet built

- The **response**: a second packet travelling back from the server to the client.
  This build covers one full request, wrapped at the client and unwrapped at the server.
