import json, sys
from place import PARTS, PADS, U1, cells, netlist, ids
from route import route
J = json.load(open(sys.argv[1]))['P']
P = {k:(tuple(v[:2]) if k in PADS else ((v[0],v[1],len(v)>2) if k=='U1' else tuple(v))) for k,v in J.items()}
import random
from route import build
_,_,terms,_ = build(P)
base = sorted(terms, key=lambda n: (-len(terms[n]), n))
best = None
random.seed(1)
for i in range(int(sys.argv[2]) if len(sys.argv)>2 else 150):
    order = base[:] if i == 0 else random.sample(base, len(base))
    r = route(P, order)
    key = (r[0] - 0.25*len(r[7]), len(r[7]), r[1])
    if best is None or key < best[0]: best = (key, r, order)
failed, hops, segs, over, occ, body, trace, jumps = best[1]
json.dump(best[2], open('order.json','w'))
assert over == 0
NETINFO = {
 'GND':'ground', 'V9':'+9 V after D2', 'VF':'filtered +9 V (op-amp supply)', 'VB':'4.5 V bias', 'VIN':'+9 V from the DC jack, before D2',
 'IN':'input', 'n1':'R3 → C2', 'P3':'op-amp pin 3 (+A)', 'P2':'op-amp pin 2 (−A)', 'P1':'op-amp pin 1 (gain stage out)',
 'n4':'R4 → C4', 'DRV':'R5 → Drive pot', 'CLIP':'clipping node (R7, Q1, D1, C5, R8)', 'X':'D1 → Q2',
 'P5':'op-amp pin 5 (+B)', 'P6':'op-amp pin 6 (−B)', 'P7':'op-amp pin 7 (second stage out)', 'n9':'R9 → C7',
 'T1':'after C8', 'T2':'tone/volume node', 'SWA':'R11 → HP/LP switch', 'TNC':'C9 → Tone pot',
}
JOB = {
 'R1':('Input pulldown, stops the pop when you switch on','Pulldown'), 'R3':('Input series resistor','Input'),
 'R6':('Biases op-amp pin 3 at 4.5 V (470k in the original)','Pin 3 bias'),
 'R4':('Gain leg: with C4 sets how much bass gets amplified','Gain leg'), 'R5':('Minimum gain, in series with the Drive pot (18k in the original)','Drive min'),
 'R7':('Feeds the clipping MOSFETs','To clipping'), 'R8':('Into the second stage','Stage 2 in'),
 'R9':('Stage 2 gain leg (39k in the original)','Stage 2 gain'), 'R10':('Stage 2 feedback (150k in the original)','Stage 2 feedback'),
 'R11':('HP/LP: switched in parallel with R12 for High Peak','HP/LP'), 'R12':('Series resistor into tone and volume (33k in the original)','Output series'),
 'R13':('Supply filter resistor','Supply filter'), 'R14':('Top half of the 4.5 V divider','Bias divider'), 'R15':('Bottom half of the 4.5 V divider','Bias divider'),
 'C2':('Input coupling cap','Input cap'), 'C4':('Gain leg: bass cut before clipping','Gain leg'), 'C3':('Stage 1 treble limit','Feedback cap'),
 'C5':('Softens the clipping edge','Clip filter'), 'C7':('Stage 2 bass corner (100n in the original)','Stage 2 gain'),
 'C6':('Stage 2 treble limit (220p in the original)','Feedback cap'), 'C9':('Tone: treble bleed through the Tone pot','Tone'),
 'C11':('Supply decoupling','Supply filter'), 'C8':('Output coupling, + toward the op-amp','Output cap'),
 'C10':('Supply filter','Supply filter'), 'C12':('Smooths the 4.5 V bias','Bias filter'),
 'D1':('Germanium-style clipping in series with Q2 (1N34A in the original)','Clipping'), 'D2':('Reverse-polarity protection','Protection'),
 'Q1':('Clipping MOSFET: gate and drain to the clip node, source to the bias','Clipping'),
 'Q2':('Clipping MOSFET: gate and drain to the bias, source to D1','Clipping'),
 'U1':('Dual op-amp: A = gain stage, B = second stage','Op-amp'),
}
KIND = {'R':'Resistor','C':'Film capacitor','E':'Electrolytic capacitor','D':'Diode','Q':'MOSFET (2N7000)'}
TIP = {
 'R':'Resistors have no direction.', 'C':'Film caps have no direction.',
 'E':'Long leg (+) goes in the hole marked +. The stripe on the can is the − side.',
 'D':'The stripe (cathode) goes at the end shown with a band.',
 'Q':'Flat face toward the side drawn flat. S, G and D are marked on the holes.',
}
PADTXT = {
 'IN':('IN','3PDT lug 5 (see the wiring diagram)'), '9V':('9V','DC socket +9 V (outer sleeve lug)'),
 'G':('GND','Ground: DC socket centre pin, both jack sleeves, 3PDT lugs 3 and 8'),
 'DR1':('DR1','Drive pot (1M A) lug 1'), 'DR2':('DR2','Drive pot lugs 2 and 3, joined'),
 'TN1':('TN1','Tone pot (10k B) lug 1'), 'TN2':('TN2','Tone pot lugs 2 and 3, joined (ground)'),
 'VL3':('VL3','Volume pot (500k A) lug 3. Lug 2 (wiper) goes to 3PDT lug 1'), 'VL1':('VL1','Volume pot lug 1 (ground)'),
 'SW1':('SW1','HP/LP toggle switch, one lug'), 'SW2':('SW2','HP/LP toggle switch, the other lug'),
}
CODES = {k:k for k in PADTXT}
parts = []
for pid in ids:
    pins, cs = cells(pid, P[pid])
    nets = netlist(pid)
    if pid in PADS:
        code = 'G' if pid == 'G' else CODES[pid]
        parts.append({'id':pid,'code':code,'type':'PAD','value':'','pins':pins,'cells':cs,'nets':nets,'kind':'Wire pad',
                      'short':PADTXT[pid][0],'job':PADTXT[pid][1]})
        continue
    if pid == 'U1':
        parts.append({'id':'U1','type':'U','value':'TL082 / TL072','pins':pins,'cells':cs,'nets':nets,'kind':'Op-amp (DIP-8 socket)',
                      'pinNames':[f'pin {i}' for i in range(1,9)],'job':JOB['U1'][0],'short':JOB['U1'][1],
                      'tip':'Solder a socket, not the chip. The notch marks the pin 1 end.'})
        continue
    t, val, _ = PARTS[pid]
    d = {'id':pid,'type':t,'value':val+('Ω' if t=='R' and not val[-1].isalpha() else ''),'pins':pins,'cells':cs,'nets':nets,
         'kind':KIND[t],'job':JOB[pid][0],'short':JOB[pid][1],'tip':TIP[t]}
    if t=='R': d['value'] = val.replace('k','k')
    if t=='E': d['pinNames'] = ['+ leg','− leg']; d['cells'] = pins
    if t=='D': d['pinNames'] = ['anode','cathode (stripe)']
    if t=='Q':
        d['pinNames'] = ['S','G','D']; d['legs'] = ['S','G','D']
        x,y,o = P[pid]
        # flat face: pick the side with more free room (perpendicular to the row of legs)
        from place import qface
        d['face'] = list(qface(o))
        d['cells'] = [c for c in cs if c in pins] if False else pins
    parts.append(d)
wires = []
for net, ss in segs.items():
    for a,b in ss:
        wires.append({'net':net,'a':a,'b':b,'jump':abs(a[0]-b[0])+abs(a[1]-b[1])>1})
data = {'W':18,'H':24,'parts':parts,'wires':wires,'netinfo':NETINFO}
json.dump(data, open('data.json','w'))
html = open('template.html').read().replace('/*DATA*/null', json.dumps(data))
open('ocd-perfboard.html','w').write(html)
print('failed', failed - 0.25*len(jumps), 'hops', hops, 'jumpers', len(jumps), [ (j[0], j[1], j[2]) for j in jumps])
