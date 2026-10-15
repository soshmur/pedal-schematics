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
 'GND':'ground', 'V9':'+9 V', 'VB':'4.5 V bias', 'VIN':'+9 V from the DC jack, before D3',
 'IN':'input jack', 'n1':'C1 → R1', 'B1':'Q1 base', 'E1':'Q1 emitter (buffered input)',
 'P3':'op-amp pin 3 (+A)', 'P2':'op-amp pin 2 (−A)', 'P1':'op-amp pin 1 (clipped output)', 'n4':'R4 → C3',
 'DRV':'R6 → Drive pot', 'P5':'op-amp pin 5 (+B)', 'P6':'op-amp pin 6 (−B)', 'P7':'op-amp pin 7 (tone output)',
 'TW':'Tone pot wiper', 'n9':'R9 → C6', 'VH':'C7 → Level pot', 'B2':'Q2 base (Level wiper)',
 'E2':'Q2 emitter', 'n13':'R13 → C8', 'OUT':'output jack',
}
JOB = {
 'R1':('Input series resistor','Input'), 'R2':('Biases Q1 base at 4.5 V; sets the ~500k input impedance','Q1 bias'),
 'R3':('Q1 emitter load','Q1 emitter'), 'R4':('With C3 sets the mid hump and how much bass gets distorted','Gain leg'),
 'R5':('Biases op-amp pin 3 at 4.5 V','Pin 3 bias'), 'R6':('Minimum gain; in series with the Drive pot','Drive min'),
 'R7':('With C5, the fixed treble cut after clipping','Treble cut'), 'R8':('Biases op-amp pin 5','Pin 5 bias'),
 'R9':('Tone network with C6','Tone'), 'R10':('Tone stage feedback','Tone feedback'),
 'R11':('Keeps Q2 biased if the Level wiper lifts','Q2 bias'), 'R12':('Q2 emitter load','Q2 emitter'),
 'R13':('Output series resistor','Output'), 'R14':('Output pulldown, stops pops','Output pulldown'),
 'R15':('Top half of the 4.5 V divider','Bias divider'), 'R16':('Bottom half of the 4.5 V divider','Bias divider'),
 'C1':('Input coupling cap (0.02 µF in the original)','Input cap'), 'C2':('Couples the buffer into the op-amp','Coupling'),
 'C3':('With R4 sets the mid hump (~720 Hz)','Gain leg'), 'C4':('Treble cut in the clipping loop; keeps high drive smooth','Feedback cap'),
 'C5':('With R7, the fixed treble cut','Treble cut'), 'C6':('Tone network with R9','Tone'),
 'C7':('Couples tone stage to the Level pot','Coupling'), 'C8':('Output coupling, + toward R13','Output cap'),
 'C9':('Smooths the 4.5 V bias','Bias filter'), 'C10':('Supply filter','Supply filter'),
 'D1':('Clipping diode','Clipping'), 'D2':('Clipping diode, the other way round','Clipping'),
 'D3':('Reverse-polarity protection','Protection'), 'Q1':('Input buffer (emitter follower)','Input buffer'),
 'Q2':('Output buffer (emitter follower)','Output buffer'), 'U1':('Dual op-amp: A = clipping stage, B = tone stage','Op-amp'),
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
 'G':('GND','Ground: DC jack centre pin (−), input and output jack sleeves'), 'OUT':('OUT','Output jack tip'),
 'D1p':('DRV 1','Drive pot (500k) lug 1'), 'D2p':('DRV 2','Drive pot lug 2 (wiper). Leave lug 3 unconnected or tie it to lug 2'),
 'T1':('TONE 1','Tone pot (20k B) lug 1'), 'T2':('TONE 2','Tone pot lug 2 (wiper)'), 'T3':('TONE 3','Tone pot lug 3'),
 'V3':('LVL 3','Level pot (100k A) lug 3'), 'V2':('LVL 2','Level pot lug 2 (wiper)'), 'V1':('LVL 1','Level pot lug 1'),
}
parts = []
for pid in ids:
    pins, cs = cells(pid, P[pid])
    nets = netlist(pid)
    if pid in PADS:
        code = {'IN':'IN','9V':'9V','G':'G','OUT':'OUT','D1p':'DR1','D2p':'DR2','T1':'TN1','T2':'TN2','T3':'TN3','V1':'LV1','V2':'LV2','V3':'LV3'}[pid]
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
open('ts808-perfboard.html','w').write(html)
print('failed', failed - 0.25*len(jumps), 'hops', hops, 'jumpers', len(jumps), [ (j[0], j[1], j[2]) for j in jumps])
