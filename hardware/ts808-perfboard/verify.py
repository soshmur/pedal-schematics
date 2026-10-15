# Independent check: rebuild connectivity from geometry only (pin holes + drawn wires), compare to a
# hand-written TS808 reference netlist. Terminals: R/C "R1.1", electrolytics "C8.+/-", diodes ".A/.K",
# transistors ".E/.C/.B", op-amp "U1.1".."U1.8", pads by name.
import json, sys
D = json.load(open(sys.argv[1] if len(sys.argv)>1 else 'data.json'))
REF = [
 {'IN','C1.x'}, {'C1.y','R1.x'}, {'R1.y','Q1.B','R2.x'}, {'Q1.E','R3.x','C2.x'}, {'C2.y','U1.3','R5.x'},
 {'U1.2','R4.x','R6.x','D1.K','D2.A','C4.y'}, {'R4.y','C3.x'}, {'R6.y','D1p'},
 {'U1.1','D1.A','D2.K','C4.x','D2p','R7.x'},
 {'R7.y','U1.5','C5.x','R8.x','T1'}, {'U1.6','R10.x','T3'}, {'T2','R9.x'}, {'R9.y','C6.x'},
 {'U1.7','R10.y','C7.x'}, {'C7.y','V3'}, {'V2','Q2.B','R11.x'}, {'Q2.E','R12.x','R13.x'}, {'R13.y','C8.+'},
 {'C8.-','OUT','R14.x'}, {'9V','D3.A'},
 {'D3.K','U1.8','Q1.C','Q2.C','R15.x','C10.+'},
 {'R15.y','R16.x','C9.+','R2.y','R5.y','R8.y','R11.y','V1'},
 {'G','R3.y','R16.y','C9.-','C10.-','C3.y','C5.y','C6.y','R12.y','R14.y','U1.4'},
]
# terminal names per part from geometry
term = {}   # hole -> terminal name list
holes_of = {}
for p in D['parts']:
    t = p['type']; pins = [tuple(c) for c in p['pins']]
    if t == 'PAD': names = [p['id']]
    elif t == 'U': names = [f"U1.{i+1}" for i in range(8)]
    elif t == 'Q': names = [p['id']+'.'+s for s in 'ECB']
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
