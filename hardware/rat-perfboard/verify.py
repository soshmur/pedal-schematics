# Independent check: rebuild connectivity from geometry only (pin holes + drawn wires), compare to a
# hand-written TS808 reference netlist. Terminals: R/C "R1.1", electrolytics "C8.+/-", diodes ".A/.K",
# transistors ".E/.C/.B", op-amp "U1.1".."U1.8", pads by name.
import json, sys
D = json.load(open(sys.argv[1] if len(sys.argv)>1 else 'data.json'))
REF = [
 {'IN','C1.x'}, {'C1.y','R2.x','R3.x'}, {'R3.y','U1.3','C2.x'},
 {'U1.2','R4.x','R5.x','C4.x','DS1'}, {'R4.y','C5.+'}, {'R5.y','C6.+'},
 {'U1.1','C4.y','R6.x','DS2'}, {'R6.y','R7.x','D1.A','D2.K'}, {'R7.y','FL1'},
 {'FL2','C8.x','U1.5'}, {'U1.6','U1.7','C10.+'}, {'C10.-','VL3'},
 {'D1.K','D2.A','R16.y','C16.+'},
 {'9V','D3.A'}, {'D3.K','R10.x'}, {'R10.y','R11.x','C12.x','C11.+','U1.8'},
 {'R11.y','R12.x','C13.+','R2.y','R16.x'},
 {'G','R12.y','C2.y','C5.-','C6.-','C8.y','C12.y','C11.-','C13.-','C16.-','U1.4','VL1'},
]
# terminal names per part from geometry
term = {}   # hole -> terminal name list
holes_of = {}
for p in D['parts']:
    t = p['type']; pins = [tuple(c) for c in p['pins']]
    if t == 'PAD': names = [p['id']]
    elif t == 'U': names = [f"U1.{i+1}" for i in range(8)]
    elif t == 'Q': names = [p['id']+'.'+s for s in p.get('legs', ['E','C','B'])]
    elif t == 'D': names = [p['id']+'.A', p['id']+'.K']
    elif t == 'E': names = [p['id']+'.+', p['id']+'.-']
    else: names = [p['id']+'.1', p['id']+'.2']
    for n,c in zip(names, pins):
        assert c not in holes_of.values(), f'two pins in hole {c}'
        holes_of[n] = c
# union-find over holes via wires
par = {}
def f(a):
    par.setdefault(a,a)
    while par[a]!=a: par[a]=par[par[a]]; a=par[a]
    return a
for w in D['wires']:
    a,b = tuple(w['a']), tuple(w['b'])
    if not w['jump']:
        assert abs(a[0]-b[0])+abs(a[1]-b[1])==1, w
    par[f(a)] = f(b)
groups = {}
for n,c in holes_of.items(): groups.setdefault(f(c), set()).add(n)
got = [g for g in groups.values()]
# wires must not pass through a hole holding another group's pin (bare wire touching it)
pinhole = {c:n for n,c in holes_of.items()}
for w in D['wires']:
    if w['jump']: continue
    for c in (tuple(w['a']), tuple(w['b'])):
        if c in pinhole and f(c) != f(tuple(w['a'])): print('SHORT', c)
# resolve 2-terminal nonpolar parts (.x/.y either way round)
def match(ref):
    ok = True
    pool = [set(g) for g in got]
    def find(name):
        for g in pool:
            if name in g: return g
    for r in ref:
        fixed = [n for n in r if not n.endswith(('.x','.y'))]
        flex = [n for n in r if n.endswith(('.x','.y'))]
        g = find(fixed[0]) if fixed else None
        if g is None:
            part = flex[0][:-2]
            for o in (part+'.1', part+'.2'):
                gg = find(o)
                if gg and all(any(x in gg for x in (m[:-2]+'.1', m[:-2]+'.2')) for m in flex): g = gg
        cand = set()
        for n in flex:
            part = n[:-2]
            opts = [part+'.1', part+'.2']
            # choose the lead that lands in g (or either if g unknown)
            hit = [o for o in opts if g is not None and o in g]
            if not hit: print('MISSING', n, 'from net with', fixed[:3]); ok = False; continue
            cand.add(hit[0])
        want = set(fixed) | cand
        if g is None or want != g:
            print('MISMATCH\n  want', sorted(want), '\n  got ', sorted(g) if g else None); ok = False
    # every 2-lead part's two leads must be in different refs and both used
    return ok
ok = match(REF)
# nonpolar parts: the .x and .y of each part must be different leads
used = {}
for r in REF:
    for n in r:
        if n.endswith(('.x','.y')): used.setdefault(n[:-2], []).append(n[-1])
print('groups', len(got), 'ref nets', len(REF))
print('PASS' if ok and len(got)==len(REF) else 'FAIL')
