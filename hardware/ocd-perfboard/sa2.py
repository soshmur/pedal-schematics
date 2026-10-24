import json, random, math, sys
import place
from place import ids, PADS, cells, netlist, rand_pos, LEN, PARTS, W, H, ORI
from route import route
def crowd(P):
    own = {}
    for pid in ids:
        for c in cells(pid, P[pid])[1]: own[c] = pid
    n = 0
    for (x,y),p in own.items():
        for q in ((x+1,y),(x,y+1)):
            o = own.get(q)
            if o and o != p: n += 1
    return n
def hp_cost(P):
    c, ov = place.cost(P)
    return c + 1.5*crowd(P), ov
def full_cost(P):
    f, hops, segs, over, occ, body, trace, jumps = route(P)
    f = int(f - 0.25*len(jumps))
    return 80*f + hops + 25*len(jumps) + 1.2*crowd(P) + 60*over, (f, len(jumps))
def perturb(P):
    pid = random.choice(ids); old = P[pid]
    if pid in PADS or pid=='U1' or random.random()<.3:
        if pid=='U1':
            x,y,r = old; P[pid] = (min(max(x+random.randint(-1,1),0),W-4), min(max(y+random.randint(-1,1),0),H-4), r if random.random()<.9 else not r)
        else: P[pid] = rand_pos(pid)
    else:
        x,y,d = old; n = LEN[PARTS[pid][0]]
        x += random.randint(-2,2); y += random.randint(-2,2)
        if random.random()<.25: d = random.choice(ORI)
        if d[0]=='h': x=min(max(x,0),W-n); y=min(max(y,0),H-1)
        else: x=min(max(x,0),W-1); y=min(max(y,0),H-n)
        P[pid] = (x,y,d)
    return pid, old
def sa(P, fn, iters, T0):
    c, f = fn(P); best = (c, dict(P), f)
    for i in range(iters):
        T = max(0.05, T0*(1-i/iters)**2)
        pid, old = perturb(P)
        nc, nf = fn(P)
        if nc <= c or random.random() < math.exp((c-nc)/T):
            c, f = nc, nf
            if c < best[0]: best = (c, dict(P), f)
        else: P[pid] = old
    return best
seed = int(sys.argv[1]); random.seed(seed)
if len(sys.argv) > 3:
    J = json.load(open(sys.argv[3]))
    P = {k:(tuple(v[:2]) if k in PADS else ((v[0],v[1],len(v)>2) if k=='U1' else tuple(v))) for k,v in J.items()}
    for k in ids:
        if k not in P: P[k] = rand_pos(k)
    T0 = float(sys.argv[4]) if len(sys.argv)>4 else 3
else:
    P = {pid: rand_pos(pid) for pid in ids}
    c, P, _ = sa(P, hp_cost, 60000, 30); T0 = 6
c, P, f = sa(dict(P), full_cost, int(sys.argv[2]), T0)
print(seed, round(c,1), 'failed', f, flush=True)
J = {k:(list(v[:2])+(['r'] if (k=='U1' and v[2]) else []) if (k in PADS or k=='U1') else list(v)) for k,v in P.items()}
json.dump({'cost':c,'failed':f,'P':J}, open(f'r{seed}.json','w'))
