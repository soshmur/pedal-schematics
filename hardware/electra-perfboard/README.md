# Electra perfboard layout

One-transistor distortion (Electra style) on the top 15 rows of an 18 × 24 perfboard.
Open `electra-perfboard.html` in a browser.

Parts: 2SC1815, 2.2M, 470, 4.7k, 1M, 2 × 100n film, 100µ electrolytic, 2 × 1N5819
(clipping), 1N5817 (protection), plus a 100k A Volume pot off the board.

`export.py electra.json` routes the hand placement and writes the page;
`verify.py data.json` checks the drawn connections against the reference netlist.
