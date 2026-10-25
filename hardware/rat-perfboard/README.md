# RAT perfboard layout (low-value resistors)

ProCo RAT distortion on an 18 × 24 hole perfboard using only resistors of 1k and below plus
one 1M (the input bias). Half A of a dual op-amp (TL072 / JRC4558) is the RAT gain stage;
half B replaces the JFET output buffer. The clipping diodes return to their own filtered
reference (R16 1k + C16 100 µF): returning them straight to the bias rail lets the clipped
current shake the bias that also feeds the op-amp input, and the simulation shows that loop
latching up. The input pulldown is omitted because the 3PDT grounds the board input in bypass.
The 1k/1k bias divider draws ~4 mA (fine on an adapter).

Open `rat-perfboard.html`. `node boardsim.mjs` simulates the board's netlist
(`VARIANT=ideal|sep|dsep` reproduce the bias-coupling experiments);
`python3 verify.py data.json` checks the drawn connections.

The earlier version with a C1815 output buffer and the original resistor values is in
`../rat-perfboard-transistor-buffer/`.
