# Pedal Schematics

A guitar pedal simulator where the schematic *is* the pedal. Tap any resistor,
capacitor, diode, transistor or op-amp, change it, and hear the result through
a real circuit simulation running in your browser.

**Live:** https://soshmur.github.io/pedal-schematics/

Seven circuits to start from:

| Pedal | Based on | Try changing |
|---|---|---|
| Booster | EHX LPB-1 | R4 (emitter resistor) sets the gain; C1 sets the bass |
| Fuzz Face | Dallas Arbiter Fuzz Face | hFE, germanium vs silicon, the Bias trimmer |
| Electra | Electra / Mike Matthews one-transistor distortion | R2 for gain, D1/D2 Schottky vs silicon |
| Screamer | Ibanez TS808 clipping stage | D1/D2 → LEDs or germanium; R3/C2 move the mid hump |
| Rodent | ProCo RAT | the op-amp chip (slew rate!), R2/R3 gain legs, clipping diodes |
| Analog Delay | Boss DM-2 | the BBD chip (1024–4096 stages), its clock, R5 for runaway repeats |
| Chorus | Boss CE-2 | C4 / R7 for LFO speed, R5/R6 for sweep width, BBD clock for the centre delay |

They are "-style" circuits: the stages that shape the sound, without the input
and output buffers.

## Playing your guitar through it

Live input is the default source. Plug your guitar into an audio interface
(or use any mic), press **Start** and allow microphone access.

- **Input level** — aim for peaks around −12 dBFS on the meter. If it says
  CLIP, turn the gain down on the interface itself.
- **Pickup level** — how many volts a full-scale digital signal stands for.
  Real pickups give roughly 0.1–1 V peak, so this decides how hard you hit the
  circuit, like a hotter or weaker pickup.
- The app uses the system's default input and output, so pick your interface
  there. A guitar on either input of a two-input interface works.
  Use headphones: speakers next to a mic will feed back.

Browsers can't use ASIO, so expect roughly 10–30 ms on Windows (WASAPI) and less
on macOS. Setting the interface to 48 kHz with a small buffer in its own control
panel helps. Live input needs https or localhost; GitHub Pages is https.

## Low-latency native app (Windows, ASIO)

Browsers can't use ASIO, so in the browser expect 15–30 ms between playing and
hearing. For a delay you can't feel (about 3–8 ms), run the native engine and
keep using this page as the control panel:

1. Install your interface's own driver (it includes ASIO). Check it's there in
   PowerShell: `Get-ChildItem HKLM:\SOFTWARE\ASIO | Select-Object -ExpandProperty PSChildName`
2. In the driver's control panel set **48 kHz** and a buffer of **64 or 128** samples.
3. Download **pedal-engine.exe** from the
   [native-latest release](https://github.com/soshmur/pedal-schematics/releases/tag/native-latest)
   and run it. Windows may warn that it's unrecognised: More info → Run anyway.
   It opens a console window that shows the driver, buffer size and expected delay.
4. Open the page (`npm start`, then http://localhost:8000). The input switches to
   **Native app (ASIO, low latency)** by itself. Press **Start**.

Everything on the page (pedal choice, part edits, knobs, bypass, levels,
oversampling) is mirrored to the app. Close the console window to stop it.
Options: `pedal-engine --list`, `--device NAME`, `--buffer 64`, `--host wasapi`.

The app is `native/`: a line-by-line Rust port of `js/engine.js`'s solver.
`node native/tests/make_fixtures.mjs && cd native && cargo test --release`
checks it against the JS engine sample for sample on every pedal.

## How it works

There's no hand-written DSP per pedal. Each pedal is only a drawing — parts
placed on a 20 px grid and wires between pins (`js/pedals.js`). Everything else
is derived from that:

1. **Netlist extraction** (`js/schematic.js`) — union-find over pin positions
   and wire segments, using normal schematic rules: touching ends and
   T-junctions connect, wires crossing mid-segment don't. GND / +9V / Vr labels
   name the global nets. Pots become two resistors split by the knob position
   (A taper = log, B = linear).
2. **Circuit solver** (`js/engine.js`) — modified nodal analysis:
   - capacitors as trapezoidal companion models,
   - diodes (Shockley) and BJTs (Ebers–Moll) linearised by Newton–Raphson with
     SPICE-style junction voltage limiting,
   - op-amps as a macro-model with gain-bandwidth, slew rate and soft rail
     clipping (so swapping a TL072 for an LM308 in the Rodent actually changes
     the sound),
   - bucket-brigade delay chips as a clocked delay line: delay = stages ÷
     (2 × clock), with the clock set by a voltage on its `clk` pin. A slow
     clock gives a long delay but a darker, grittier one, as on the real chip.
     The surrounding filters, mixer, feedback loop and the chorus's op-amp
     LFO are ordinary circuit,
   - a sparse LU with a fixed pivot order (the matrix structure never changes,
     only its values), and
   - when Newton fails to converge, the sample is retried in smaller time
     steps, like SPICE's timestep control.
3. **Analyses** — DC operating point (with source stepping), small-signal AC
   sweep for the frequency-response plot, and sample-by-sample transient
   simulation in an `AudioWorklet` at 1× or 2× oversampling.

Because the same netlist drives everything, the "DC voltages" panel, the
frequency response and the sound always agree with each other and with the
drawing. **Export SPICE netlist** writes the circuit out so you can check it in
LTspice or ngspice.

## Run it locally

No build step and no dependencies. ES modules need to be served over HTTP:

```sh
npm start            # http://localhost:8000
# open http://localhost:8000
```

Tests (Node 20+):

```sh
npm test
```

The tests check that every schematic is fully wired, that bias points and gains
match the textbook formulas (e.g. the Screamer's 1 + (R2 + Drive)/R3), that
awkward builds still converge, and that every pedal simulates faster than real
time.

## Adding a pedal

Add an entry to `PEDALS` in `js/pedals.js`:

```js
{
  key: 'mypedal',
  name: 'My Pedal',
  parts: [
    { id: 'IN', type: 'IN', x: 0, y: 8 },
    { id: 'R1', type: 'R', x: 2, y: 8, value: 10e3 },          // pins at (2,8) and (6,8)
    { id: 'D1', type: 'D', x: 6, y: 8, rot: 90, model: '1N914' }, // anode (6,8), cathode (6,12)
    { id: 'G1', type: 'GND', x: 6, y: 12 },
    { id: 'OUT', type: 'OUT', x: 9, y: 8 },
  ],
  wires: [[[6, 8], [9, 8]]],
}
```

Part types: `R`, `C` (`polar: true` for electrolytics), `D`, `Q` (NPN),
`OA` (op-amp; `comparator: true` for a Schmitt trigger), `BBD` (`chip`,
`value` = clock at 4.5 V, `vOct`), `POT` (`knob: 'Name'` puts it on the enclosure, `trim: true`
keeps it on the board), plus `IN`, `OUT`, `GND`, `VCC` (+9 V) and `VREF`
(4.5 V). Run `npm test` — it will tell you about any pin that isn't connected.

## Ideas for next

- BBD compander (NE570) and clock noise for a more authentic delay
- PNP germanium Fuzz Face (positive ground) and JFETs
- Big Muff (four transistor stages and the tone stack)
- chaining pedals, and a drag-and-drop schematic editor
