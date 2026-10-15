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
 'GND':'ground', 'V9':'+9 V', 'VIN':'+9 V from the DC jack, before D3', 'IN':'input jack',
 'B':'Q1 base', 'COL':'Q1 collector', 'E':'Q1 emitter', 'DOUT':'clipped output → Volume pot',
}
JOB = {
 'R1':('Biases Q1 from its own collector. Bigger = collector sits lower, more gain and earlier breakup','Q1 bias'),
 'R2':('Emitter resistor. Gain ≈ R3 / R2: drop it to 330 Ω for more distortion','Gain'),
 'R3':('Collector load','Collector'),
 'R4':('Input pulldown, stops the click when you switch on','Pulldown'),
 'C1':('Input coupling cap','Input cap'), 'C2':('Output coupling cap into the diodes','Output cap'),
 'C3':('Supply filter','Supply filter'),
 'D1':('Clipping diode to ground','Clipping'), 'D2':('Clipping diode, the other way round','Clipping'),
 'D3':('Reverse-polarity protection (Schottky, so it only drops ~0.3 V)','Protection'),
 'Q1':('The single gain stage','Gain stage'),
}
KIND = {'R':'Resistor','C':'Film capacitor','E':'Electrolytic capacitor','D':'Diode','Q':'NPN transistor'}
TIP = {
 'R':'Resistors have no direction.', 'C':'Film caps have no direction.',
 'E':'Long leg (+) goes in the hole marked +. The stripe on the can is the − side.',
 'D':'The stripe (cathode) goes at the end shown with a band.',
 'Q':'Flat face toward the side drawn flat. E, C and B are marked on the holes.',
}
PADTXT = {
 'IN':('IN','Input jack tip (sleeve to ground)'), '9V':('9V','DC jack +9 V (the sleeve lug on a centre-negative jack)'),
 'G':('GND','Ground: DC jack centre pin (−), input and output jack sleeves'),
 'V3':('LV3','Volume pot (100k A) lug 3. Lug 2 (wiper) goes straight to the output jack tip'),
 'V1':('LV1','Volume pot lug 1'),
}
CODES = {'IN':'IN','9V':'9V','G':'G','V3':'LV3','V1':'LV1'}
parts = []
for pid in ids:
    pins, cs = cells(pid, P[pid])
    nets = netlist(pid)
    if pid in PADS:
        code = CODES[pid]
        parts.append({'id':pid,'code':code,'type':'PAD','value':'','pins':pins,'cells':cs,'nets':nets,'kind':'Wire pad',
                      'short':PADTXT[pid][0],'job':PADTXT[pid][1]})
        continue
    if pid == 'U1':
        parts.append({'id':'U1','type':'U','value':'JRC4558 / TL072','pins':pins,'cells':cs,'nets':nets,'kind':'Op-amp (DIP-8 socket)',
                      'pinNames':[f'pin {i}' for i in range(1,9)],'job':JOB['U1'][0],'short':JOB['U1'][1],
                      'tip':'Solder a socket, not the chip. The notch marks the pin 1 end.'})
        continue
    t, val, _ = PARTS[pid]
    d = {'id':pid,'type':t,'value':val+('Ω' if t=='R' and not val[-1].isalpha() else ''),'pins':pins,'cells':cs,'nets':nets,
         'kind':KIND[t],'job':JOB[pid][0],'short':JOB[pid][1],'tip':TIP[t]}
    if t=='R': d['value'] = val.replace('k','k')
    if t=='E': d['pinNames'] = ['+ leg','− leg']
    if t=='D': d['pinNames'] = ['anode','cathode (stripe)']
    if t=='Q':
        d['pinNames'] = ['E','C','B']
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
open('electra-perfboard.html','w').write(html)
print('failed', failed - 0.25*len(jumps), 'hops', hops, 'jumpers', len(jumps), [ (j[0], j[1], j[2]) for j in jumps])
