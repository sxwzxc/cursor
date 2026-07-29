import sys, re, json

js = sys.stdin.read()

# Anchor on `name:"..."` — each model record's fields live between its name
# and the next name (or end). Robust to nested object boundaries.
name_iter = list(re.finditer(r'name:"((?:[^"\\]|\\.)*)"', js))
print(f'found {len(name_iter)} "name:" occurrences\n')

def fld(seg, key, cast=float):
    # value is a number (possibly .3), !0/!1, or "string"
    m = re.search(re.escape(key) + r':(!0|!1|true|false|"-?[^"]*"|\d+\.?\d*|\[[^\]]*\])', seg)
    if not m:
        return None
    v = m.group(1)
    if v in ('!0', 'true'): return True
    if v in ('!1', 'false'): return False
    if v.startswith('"'): return v[1:-1]
    if v.startswith('['):
        try: return json.loads(v)
        except: return v
    try: return cast(v)
    except: return v

rows = []
for i, nm in enumerate(name_iter):
    name = nm.group(1).encode().decode('unicode_escape')
    seg_start = nm.end()
    seg_end = name_iter[i+1].start() if i+1 < len(name_iter) else len(js)
    seg = js[seg_start:seg_end]
    # only records that are actual models (have tokenInput)
    if 'tokenInput' not in seg:
        # maybe fields precede name; look back to previous name
        prev_end = name_iter[i-1].end() if i > 0 else 0
        seg = js[prev_end:seg_end]
        if 'tokenInput' not in seg:
            continue
    ti = fld(seg, 'tokenInput')
    if ti is None:
        continue
    rows.append({
        'name': name,
        'provider': fld(seg, 'provider', str),
        'tokenInput': ti,
        'cacheWrite': fld(seg, 'cacheWrite'),
        'cacheRead': fld(seg, 'cacheRead'),
        'tokenOutput': fld(seg, 'tokenOutput'),
        'contextWindow': fld(seg, 'contextWindow', str),
        'maxContextWindow': fld(seg, 'maxContextWindow', str),
        'isAgent': fld(seg, 'isAgent', str),
        'thinking': fld(seg, 'thinking', str),
        'hidden': fld(seg, 'hidden', str),
        'tagline': fld(seg, 'tagline', str),
    })

print(f'{len(rows)} models with token pricing:\n')
print(f'{"Name":<26} {"Provider":<10} {"In":>5} {"CW":>6} {"CR":>5} {"Out":>5} {"Ctx":>6} {"Max":>5} {"Ag":>4} {"Th":>4} {"Hi":>4}')
for r in rows:
    def s(v): return '' if v is None else str(v)
    print(f'{r["name"][:26]:<26} {s(r["provider"])[:10]:<10} {s(r["tokenInput"]):>5} {s(r["cacheWrite"]):>6} {s(r["cacheRead"]):>5} {s(r["tokenOutput"]):>5} {s(r["contextWindow"]):>6} {s(r["maxContextWindow"]):>5} {s(r["isAgent"]):>4} {s(r["thinking"]):>4} {s(r["hidden"]):>4}')

print('\n--- sample JSON (first 3) ---')
for r in rows[:3]:
    print(json.dumps(r, ensure_ascii=False))
