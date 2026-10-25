# RAT perfboard layout

ProCo RAT distortion on an 18 × 24 hole perfboard, adapted to parts on hand:
a dual op-amp (TL072 / JRC4558; half B parked as a follower) instead of the LM308, and a
C1815 emitter follower instead of the 2N5458 JFET output buffer.
Kit swaps: R7 1.5k → 1k, C4 100p → two 220p in series; C3 (LM308 compensation) omitted.

Open `rat-perfboard.html`. `node boardsim.mjs` simulates the board's netlist with pots;
`python3 verify.py data.json` checks the drawn connections against the reference netlist.
