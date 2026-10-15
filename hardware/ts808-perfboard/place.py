import json, random, math, subprocess, sys, importlib.util
exec(open('layout.py').read().split('# ---- placement')[0])   # PARTS, U1, PADS, LEN, W, H
ids = list(PARTS) + ['U1'] + list(PADS)
ORI = ['h','h-','v','v-']
# pad zones: (xmin,xmax,ymin,ymax)
EDGE_L=[(0,0,0,23)]; EDGE_R=[(17,17,0,23)]; TOP=[(0,17,0,0)]; BOT=[(0,17,23,23)]
ZONE = {
 'IN':EDGE_L+BOT, '9V':EDGE_L+BOT, 'G':EDGE_L+BOT, 'OUT':EDGE_R+BOT,
 'D1p':TOP, 'D2p':TOP, 'T1':TOP+EDGE_R,'T2':TOP+EDGE_R,'T3':TOP+EDGE_R,
 'V3':TOP+EDGE_R,'V2':TOP+EDGE_R,'V1':TOP+EDGE_R,
}
def cells(pid, p):
    if pid in PADS: return [(p[0],p[1])], [(p[0],p[1])]
    if pid == 'U1':
        x,y,r = p
        if r: pins = [(x+3,y+3-i) for i in range(4)] + [(x,y+i) for i in range(4)]
        else: pins = [(x,y+i) for i in range(4)] + [(x+3,y+3-i) for i in range(4)]
        return pins, pins+[(x+dx,y+dy) for dx in (1,2) for dy in range(4)]
    t = PARTS[pid][0]; n = LEN[t]; x,y,d = p
    st = (1,0) if d[0]=='h' else (0,1)
    cs = [(x+st[0]*i, y+st[1]*i) for i in range(n)]
    pins = cs if t=='Q' else [cs[0], cs[-1]]
    if d.endswith('-'): pins = pins[::-1]
    if t == 'Q':
        # flat face is fixed by pin order (E-C-B left to right when the flat faces you); the round back
        # takes the row of holes behind the legs
        bx, by = qback(d)
        cs = cs + [(c[0]+bx, c[1]+by) for c in cs]
    return pins, cs
def qface(d):
    return {'h':(0,1), 'h-':(0,-1), 'v':(-1,0), 'v-':(1,0)}[d]
def qback(d):
    f = qface(d); return (-f[0], -f[1])
def netlist(pid):
    if pid=='U1': return [U1[i] for i in range(1,9)]
    if pid in PADS: return [PADS[pid][0]]
    return PARTS[pid][2]
def rand_pos(pid):
    if pid in PADS:
        z = random.choice(ZONE[pid]); return (random.randint(z[0],z[1]), random.randint(z[2],z[3]))
    if pid=='U1': return (random.randint(0,W-4), random.randint(0,H-4), random.random()<.5)
    d = random.choice(ORI); n = LEN[PARTS[pid][0]]
    if d[0]=='h': return (random.randint(0,W-n), random.randint(0,H-1), d)
    return (random.randint(0,W-1), random.randint(0,H-n), d)
def cost(P):
    occ = {}; over = 0; pinpos = {}
    for pid in ids:
        pins, cs = cells(pid, P[pid])
        for c in cs:
            # keep one free hole around film caps' and resistors' bodies? only count overlaps
            if c in occ: over += 1
            occ[c] = 1
        for net, c in zip(netlist(pid), pins):
            pinpos.setdefault(net, []).append(c)
    wl = 0
    for net, ps in pinpos.items():
        xs = [p[0] for p in ps]; ys = [p[1] for p in ps]
        w = (max(xs)-min(xs)) + (max(ys)-min(ys))
        wl += w * (0.5 if net in ('GND','V9','VB') else 1.0)
    # pads for the same pot should sit together
    for grp in (['D1p','D2p'],['T1','T2','T3'],['V1','V2','V3']):
        xs = [P[g][0] for g in grp]
        wl += 2*(max(xs)-min(xs) - (len(grp)-1))
    return wl + 40*over, over
def anneal(seed, iters=60000):
    random.seed(seed)
    P = {pid: rand_pos(pid) for pid in ids}
    c, ov = cost(P); T = 30.0
    for i in range(iters):
        pid = random.choice(ids); old = P[pid]
        r = random.random()
        if r < .5 and pid not in PADS and pid!='U1':
            x,y,d = old; n = LEN[PARTS[pid][0]]
            x += random.randint(-2,2); y += random.randint(-2,2)
            if random.random()<.2: d = random.choice(ORI)
            if d[0]=='h': x = min(max(x,0),W-n); y=min(max(y,0),H-1)
            else: x=min(max(x,0),W-1); y=min(max(y,0),H-n)
            P[pid] = (x,y,d)
        else:
            P[pid] = rand_pos(pid)
        nc, nov = cost(P)
        if nc <= c or random.random() < math.exp((c-nc)/T): c, ov = nc, nov
        else: P[pid] = old
        T = max(0.05, 30.0*(1-i/iters)**3)
    return P, c, ov
if __name__ == '__main__':
    out = []
    for s in range(int(sys.argv[1]), int(sys.argv[2])):
        P, c, ov = anneal(s)
        if ov: continue
        J = {k:(list(v[:2])+(['r'] if (k=='U1' and v[2]) else []) if (k in PADS or k=='U1') else list(v)) for k,v in P.items()}
        json.dump(J, open(f'cand{s}.json','w'))
        out.append((c, s))
        print(s, round(c,1), flush=True)
