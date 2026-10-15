import heapq
from place import cells, netlist, ids, PADS, W, H
DIRS = [(1,0),(0,1),(-1,0),(0,-1)]
def build(P):
    occ = {}; body = set(); terms = {}; over = 0
    for pid in ids:
        pins, cs = cells(pid, P[pid])
        for c in cs:
            if c in occ or c in body or not (0<=c[0]<W and 0<=c[1]<H): over += 1
        for net, c in zip(netlist(pid), pins):
            occ[c] = net; terms.setdefault(net, []).append(c)
        for c in cs:
            if c not in pins: body.add(c)
    return occ, body, terms, over
def route(P, order=None, JUMP=12):
    occ, body, terms, over = build(P)
    trace = {}; segs = {}; failed = 0; hops = 0; jumps = []
    nets = order or sorted(terms, key=lambda n: (-len(terms[n]), n))
    for net in nets:
        ts = terms.get(net, [])
        if len(ts) < 2: continue
        tree = {ts[0]}; rest = set(ts[1:]); segs[net] = []
        while rest:
            pq = [(0, c, -1) for c in tree]; heapq.heapify(pq)
            best = {(c,-1):0 for c in tree}; prev = {}; goal = None
            while pq:
                cost, c, d = heapq.heappop(pq)
                if best.get((c,d), 1e9) < cost: continue
                if c in rest: goal = (c,d); break
                for nd,(dx,dy) in enumerate(DIRS):
                    n = (c[0]+dx, c[1]+dy)
                    if not (0<=n[0]<W and 0<=n[1]<H): continue
                    o = occ.get(n)
                    if o is not None and o != net: continue
                    t = trace.get(n)
                    if t is not None and t != net: continue
                    if o == net and n not in rest and n not in tree: continue  # don't run through other own pins blindly? allow
                    nc = cost + 1 + (0.5 if (d!=-1 and nd!=d) else 0) + (0.4 if n in body else 0)
                    # discourage running right next to other nets' pins (solder bridges)
                    for ex,ey in DIRS:
                        q = occ.get((n[0]+ex, n[1]+ey))
                        if q is not None and q != net: nc += 0.15
                    if nc < best.get((n,nd), 1e9):
                        best[(n,nd)] = nc; prev[(n,nd)] = (c,d)
                        heapq.heappush(pq, (nc, n, nd))
                # insulated jumper wire: straight hop of 2..8 holes over anything
                if JUMP:
                    for nd,(dx,dy) in enumerate(DIRS):
                        for L in range(2, 9):
                            n = (c[0]+dx*L, c[1]+dy*L)
                            if not (0<=n[0]<W and 0<=n[1]<H): break
                            o = occ.get(n); t = trace.get(n)
                            if (o is not None and o != net) or (t is not None and t != net): continue
                            if n in body: continue
                            nc = cost + JUMP + L
                            if nc < best.get((n,4), 1e9):
                                best[(n,4)] = nc; prev[(n,4)] = (c,d)
                                heapq.heappush(pq, (nc, n, 4))
            if not goal:
                failed += len(rest); break
            k = goal; path = [k[0]]
            while k in prev: k = prev[k]; path.append(k[0])
            for a,b in zip(path, path[1:]):
                L = abs(a[0]-b[0])+abs(a[1]-b[1])
                segs[net].append((a,b)); hops += L
                if L > 1: jumps.append((net,a,b)); failed += 0.25

            for c in path:
                tree.add(c)
                if c not in occ: trace[c] = net
            rest.discard(goal[0])
    return failed, hops, segs, over, occ, body, trace, jumps
