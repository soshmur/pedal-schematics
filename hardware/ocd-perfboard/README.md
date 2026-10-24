# OCD perfboard layout

Fulltone OCD style overdrive (from the YouSpice schematic) on an 18 × 24 hole perfboard.
Open `ocd-perfboard.html` in a browser: component side, solder side, parts list, and a wiring
diagram for the pots, HP/LP toggle, jacks, DC socket and 3PDT footswitch.

Kit substitutions (original → used): R6 470k → 1M, R5 18k → 22k, R9 39k → 22k, R10 150k → 100k,
C6 220p → 330p, C7 100n → 150n, R12 33k → 47k, D1 1N34A → 1N5819. Simulated within 1–2 dB of the
original at every Drive setting.

- `node boardsim.mjs` (from this folder) simulates the board's own netlist with pots and switch
- `python3 verify.py data.json` rebuilds the connections from the drawing and checks them
  against the reference netlist
