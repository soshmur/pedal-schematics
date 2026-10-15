# TS808 perfboard layout

Full Tube Screamer (input buffer, clipping stage, tone stage, output buffer) on an
18 × 24 hole perfboard. Pots, jacks and DC socket are wired off the board.

Open `ts808-perfboard.html` in a browser. It shows the component side, a mirrored
solder side, a parts checklist and the off-board wiring.

Lead spacing used (holes occupied, leads in the end holes): resistor 6, film cap 4,
electrolytic 3, diode 3, transistor 3 (2SC1815, E-C-B), DIP-8 socket.

- `place.py`, `sa2.py`: placement search (annealing) seeded from a hand floorplan
- `route.py`: back-side wiring router (one net per hole; insulated jumper wires when needed)
- `export.py placement.json`: routes and writes `data.json` and the HTML page
- `verify.py data.json`: rebuilds connectivity from the drawn geometry alone and
  checks it against a hand-written TS808 netlist
