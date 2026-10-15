import json, heapq, sys
W, H = 18, 24
LEN = {'R':6,'C':4,'E':2,'D':4,'Q':3}

# ---- circuit: part -> pin nets -------------------------------------------
# film caps 'C', electrolytic 'E' (pin1 = +), diode 'D' (pin1 = anode, pin2 = cathode)
# transistor 'Q' 2SC1815 pins in hole order E, C, B
PARTS = {
 # id: (type, value, nets in pin order)
 'R1': ('R','1k',   ['n1','B1']),
 'R2': ('R','510k', ['B1','VB']),
 'R3': ('R','10k',  ['E1','GND']),
 'R4': ('R','4.7k', ['P2','n4']),
 'R5': ('R','10k',  ['P3','VB']),
 'R6': ('R','51k',  ['P2','DRV']),
 'R7': ('R','1k',   ['P1','P5']),
 'R8': ('R','10k',  ['P5','VB']),
 'R9': ('R','220',  ['TW','n9']),
 'R10':('R','1k',   ['P6','P7']),
 'R11':('R','510k', ['B2','VB']),
 'R12':('R','10k',  ['E2','GND']),
 'R13':('R','100',  ['E2','n13']),
 'R14':('R','10k',  ['OUT','GND']),
 'R15':('R','10k',  ['V9','VB']),
 'R16':('R','10k',  ['VB','GND']),
 'C1': ('C','22n',  ['IN','n1']),
 'C2': ('C','1µ',   ['E1','P3']),
 'C3': ('C','47n',  ['n4','GND']),
 'C4': ('C','51p',  ['P1','P2']),
 'C5': ('C','220n', ['P5','GND']),
 'C6': ('C','220n', ['n9','GND']),
 'C7': ('C','1µ',   ['P7','VH']),
 'C8': ('E','10µ',  ['n13','OUT']),
 'C9': ('E','47µ',  ['VB','GND']),
 'C10':('E','100µ', ['V9','GND']),
 'D1': ('D','1N4148',['P1','P2']),
 'D2': ('D','1N4148',['P2','P1']),
 'D3': ('D','1N4001',['VIN','V9']),
 'Q1': ('Q','C1815',['E1','V9','B1']),
 'Q2': ('Q','C1815',['E2','V9','B2']),
}
# op-amp pins 1..8
U1 = {1:'P1',2:'P2',3:'P3',4:'GND',5:'P5',6:'P6',7:'P7',8:'V9'}
PADS = {  # off-board wire pads: id -> (net, label)
 'IN':('IN','Input'), '9V':('VIN','+9V'), 'G':('GND','Ground'), 'OUT':('OUT','Output'),
 'D1p':('DRV','Drive lug 1'), 'D2p':('P1','Drive lug 2'),
 'T1':('P5','Tone lug 1'), 'T2':('TW','Tone lug 2'), 'T3':('P6','Tone lug 3'),
 'V3':('VH','Volume lug 3'), 'V2':('B2','Volume lug 2'), 'V1':('VB','Volume lug 1'),
}

# ---- placement -----------------------------------------------------------
# (x, y, dir) dir 'h' = pins go right, 'v' = pins go down; pins reversed with '-' suffix
PLACE = json.load(open(sys.argv[1]))

def part_holes(pid):
    if pid == 'U1':
        x, y = PLACE['U1'][:2]
        if len(PLACE['U1'])>2 and PLACE['U1'][2]=='r':   # rotated 180: pin 1 bottom-right
            pins = {i+1:(x+3, y+3-i) for i in range(4)}
            pins.update({5+i:(x, y+i) for i in range(4)})
        else:
            pins = {i+1:(x, y+i) for i in range(4)}
            pins.update({8-i:(x+3, y+i) for i in range(4)})
        body = [(x+dx, y+dy) for dx in (1,2) for dy in range(4)]
        return pins, body
    if pid in PADS:
        x, y = PLACE[pid][:2]; return {1:(x,y)}, []
    t = PARTS[pid][0]; n = LEN[t]
    x, y, d = PLACE[pid]
    rev = d.endswith('-'); d = d[0]
    step = (1,0) if d=='h' else (0,1)
    cells = [(x+step[0]*i, y+step[1]*i) for i in range(n)]
    if t == 'Q': pinc = cells
    else: pinc = [cells[0], cells[-1]]
    if rev: pinc = pinc[::-1]
    body = [c for c in cells if c not in pinc]
    return {i+1:c for i,c in enumerate(pinc)}, body

def nets_of(pid):
    if pid == 'U1': return U1
    if pid in PADS: return {1:PADS[pid][0]}
    return {i+1:n for i,n in enumerate(PARTS[pid][2])}

occ = {}   # hole -> (net, owner)
bodies = set()
terms = {}
errs = []
for pid in list(PARTS)+['U1']+list(PADS):
    if pid not in PLACE: errs.append('unplaced '+pid); continue
    pins, body = part_holes(pid)
    nets = nets_of(pid)
    for k,c in pins.items():
        if not (0<=c[0]<W and 0<=c[1]<H): errs.append(f'{pid} off board {c}')
        if c in occ or c in bodies: errs.append(f'{pid} pin clash at {c} with {occ.get(c)}')
        occ[c] = (nets[k], pid); terms.setdefault(nets[k], []).append(c)
    for c in body:
        if c in occ: errs.append(f'{pid} body over pin {c} {occ[c]}')
        if c in bodies: errs.append(f'{pid} body over body {c}')
        bodies.add(c)
    for k,c in pins.items():
        if c in bodies and c not in body: errs.append(f'{pid} pin under a body {c}')
if errs: print('\n'.join(errs)); sys.exit(1)

# ---- routing (back side, orthogonal, one net per hole) -------------------
trace = {}  # hole -> net
segs = {}   # net -> list of (a,b)
order = sorted(terms, key=lambda n: -len(terms[n]))
order = PLACE.get('_order', []) + [n for n in order if n not in PLACE.get('_order', [])]
fails = []
def free(c, net):
    if not (0<=c[0]<W and 0<=c[1]<H): return False
    o = occ.get(c)
    if o and o[0] != net: return False
    t = trace.get(c)
    if t and t != net: return False
    return True
for net in order:
    ts = terms[net]
    if len(ts) < 2: continue
    tree = {ts[0]}
    rest = ts[1:]
    segs[net] = []
    while rest:
        # Dijkstra from tree to any remaining terminal, cost: step 1, turn 0.6, body 0.3, near-other-net 0.4
        pq = []; best = {}
        for c in tree:
            for d in range(4):
                heapq.heappush(pq, (0, c, d, None)); best[(c,d)] = 0
        prev = {}
        goal = None
        DIRS = [(1,0),(0,1),(-1,0),(0,-1)]
        while pq:
            cost, c, d, p = heapq.heappop(pq)
            if c in rest: goal = (c,d); break
            for nd,(dx,dy) in enumerate(DIRS):
                n = (c[0]+dx, c[1]+dy)
                if not free(n, net): continue
                o = occ.get(n)
                if o and o[0]==net and n not in rest and n not in tree: pass
                nc = cost + 1 + (0.6 if nd != d else 0) + (0.3 if n in bodies else 0)
                if (n,nd) not in best or nc < best[(n,nd)] - 1e-9:
                    best[(n,nd)] = nc; prev[(n,nd)] = (c,d)
                    heapq.heappush(pq, (nc, n, nd, None))
        if not goal: fails.append(net); break
        k = goal; path = [k[0]]
        while k in prev:
            k = prev[k]; path.append(k[0])
        for a,b in zip(path, path[1:]): segs[net].append((a,b))
        for c in path: tree.add(c); trace.setdefault(c, net) if c not in occ else None
        rest.remove(goal[0])
print('FAILED:', fails) if fails else print('routed all')
total = sum(len(v) for v in segs.values()); print('wire hops', total)
# ascii
grid = [['.']*W for _ in range(H)]
for c in bodies: grid[c[1]][c[0]] = '='
for c,n in trace.items(): grid[c[1]][c[0]] = '+'
for c,(n,p) in occ.items(): grid[c[1]][c[0]] = 'o'
print('   '+''.join(f'{x%10}' for x in range(W)))
for y,r in enumerate(grid): print(f'{y:2} '+''.join(r))
json.dump({'W':W,'H':H,'place':PLACE,'segs':{k:v for k,v in segs.items()},'fails':fails}, open('routed.json','w'))
