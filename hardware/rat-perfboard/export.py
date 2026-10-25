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
 'GND':'ground', 'V9':'+9 V after D3', 'VF':'filtered +9 V (op-amp and Q1 supply)', 'VB':'4.5 V bias', 'VIN':'+9 V from the DC jack, before D3',
 'IN':'input', 'A':'C1 → R2/R3', 'P3':'op-amp pin 3 (+)', 'P2':'op-amp pin 2 (−)', 'P1':'op-amp pin 1 (out)',
 'g1':'R4 → C5', 'g2':'R5 → C6', 'K':'C7 → R6', 'D':'clipping diodes', 'FL':'R7 → Filter pot', 'F':'filter node (C8, C9)',
 'G':'Q1 base', 'E':'Q1 emitter (output)', 'VH':'C10 → Volume pot', 'P7':'unused op-amp half (pins 6 and 7 joined)',
}
JOB = {
 'R1':('Input pulldown, stops the pop when you switch on','Pulldown'), 'R2':('Biases the op-amp input at 4.5 V','Input bias'),
 'R3':('Input series resistor','Input'), 'R4':('Gain leg with C5: sets the top of the gain','Gain leg'),
 'R5':('Gain leg with C6: sets how much bass gets amplified','Gain leg'), 'R6':('Limits current into the clipping diodes','To diodes'),
 'R7':('Filter: brightest setting (1.5k in the original)','Filter'), 'R8':('Biases the output transistor','Buffer bias'),
 'R9':('Output transistor emitter load','Buffer'), 'R10':('Supply filter resistor','Supply filter'),
 'R11':('Top half of the 4.5 V divider','Bias divider'), 'R12':('Bottom half of the 4.5 V divider','Bias divider'),
 'C1':('Input coupling cap','Input cap'), 'C2':('Removes radio-frequency hiss at the input','RF filter'),
 'C4':('Treble limit across the Distortion pot: two 220p in series (100p in the original)','Feedback cap'),
 'C8':('Filter capacitor','Filter'), 'C9':('Couples the filter into the output transistor','Coupling'), 'C12':('Supply decoupling','Supply filter'),
 'C5':('Gain leg cap, + toward R4','Gain leg'), 'C6':('Gain leg cap, + toward R5','Gain leg'), 'C7':('Couples the op-amp to the diodes, + toward the op-amp','Coupling'),
 'C10':('Output coupling, + toward Q1','Output cap'), 'C11':('Supply filter','Supply filter'), 'C13':('Smooths the 4.5 V bias','Bias filter'),
 'D1':('Clipping diode to ground','Clipping'), 'D2':('Clipping diode, the other way round','Clipping'), 'D3':('Reverse-polarity protection','Protection'),
 'Q1':('Output buffer (emitter follower), in place of the original 2N5458 JFET','Output buffer'),
 'U1':('Dual op-amp: half A is the RAT gain stage, half B is parked (pin 5 to bias, pins 6–7 joined)','Op-amp'),
}
KIND = {'R':'Resistor','C':'Film capacitor','E':'Electrolytic capacitor','D':'Diode','Q':'NPN transistor'}
TIP = {
 'R':'Resistors have no direction.', 'C':'Film caps have no direction.',
 'E':'Long leg (+) goes in the hole marked +. The stripe on the can is the − side.',
 'D':'The stripe (cathode) goes at the end shown with a band.',
 'Q':'Flat face toward the side drawn flat. E, C and B are marked on the holes.',
}
PADTXT = {
 'IN':('IN','3PDT lug 5 (see the wiring diagram)'), '9V':('9V','DC socket +9 V (outer sleeve lug)'),
 'G':('GND','Ground: DC socket centre pin, both jack sleeves, 3PDT lugs 3 and 8'),
 'DS1':('DS1','Distortion pot (100k A) lug 1'), 'DS2':('DS2','Distortion pot lugs 2 and 3, joined'),
 'FL1':('FL1','Filter pot (100k A) lug 1'), 'FL2':('FL2','Filter pot lugs 2 and 3, joined'),
 'VL3':('VL3','Volume pot (100k A) lug 3. Lug 2 (wiper) goes to 3PDT lug 1'), 'VL1':('VL1','Volume pot lug 1 (ground)'),
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
        parts.append({'id':'U1','type':'U','value':'TL072 / JRC4558','pins':pins,'cells':cs,'nets':nets,'kind':'Op-amp (DIP-8 socket)',
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
        d['pinNames'] = ['E','C','B']; d['legs'] = ['E','C','B']
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
open('rat-perfboard.html','w').write(html)
print('failed', failed - 0.25*len(jumps), 'hops', hops, 'jumpers', len(jumps), [ (j[0], j[1], j[2]) for j in jumps])
