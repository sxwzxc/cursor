import sys, re, json

html = sys.stdin.read()
print('=== raw HTML length:', len(html), '===')

# 1) Case-insensitive search in RAW html (no decoding) for pricing keywords.
print('\n--- raw HTML keyword search (case-insensitive) ---')
lower = html.lower()
for kw in ['claude', 'sonnet', 'gpt-5', 'gemini', '$3', '$15', 'per million',
           'per 1m', 'cache write', 'cache read', 'model pricing', 'api pool',
           'composer 2.5', 'claude 4.6', 'claude 4.7']:
    n = lower.count(kw)
    print(f'  {kw!r}: {n}')

# 2) ALL __next_f.push payloads, any array shape, JSON-decoded.
print('\n--- all __next_f.push payloads ---')
all_pushes = re.findall(r'self\.__next_f\.push\(\[(.*?)\]\);?</script>', html, re.S)
print(f'  total push blocks: {len(all_pushes)}')
# Concatenate the string-literal portions properly.
pushes = re.findall(r'self\.__next_f\.push\(\[\d+,\s*"((?:[^"\\]|\\.)*)"\]', html)
print(f'  string-literal pushes: {len(pushes)}')
joined = ''
for p in pushes:
    try:
        joined += json.loads('"' + p + '"')
    except Exception:
        joined += p.encode('utf-8','ignore').decode('unicode_escape','ignore')
print(f'  joined payload length: {len(joined)}')
lj = joined.lower()
print('  keyword counts in joined payload:')
for kw in ['claude', 'sonnet', 'gpt', 'gemini', '$3', '$15', 'per million',
           'cache write', 'composer 2.5', 'claude 4.6', 'claude 4.7', 'grok 4.3']:
    print(f'    {kw!r}: {lj.count(kw)}')

# 3) Are there <script type="application/json"> data blocks?
print('\n--- script type="application/json" blocks ---')
json_blocks = re.findall(r'<script[^>]*type=["\']application/json["\'][^>]*>(.*?)</script>', html, re.S)
print(f'  count: {len(json_blocks)}')
for i, b in enumerate(json_blocks[:3]):
    print(f'  block {i} (len {len(b)}): {b[:200]}')

# 4) List all script srcs (JS chunks) referenced — the data may be statically
#    embedded in a chunk.
print('\n--- script srcs (JS chunks) ---')
srcs = re.findall(r'<script[^>]*src=["\']([^"\']+)["\']', html)
print(f'  count: {len(srcs)}')
for s in srcs[:20]:
    print(f'    {s}')

# 5) Look for any fetch/endpoint hints in inline scripts (e.g. /api/..., .json, _rsc).
print('\n--- endpoint hints in inline scripts ---')
inline = re.findall(r'<script(?![^>]*src=)[^>]*>(.*?)</script>', html, re.S | re.I)
print(f'  inline script count: {len(inline)}')
joined_inline = ' '.join(inline)
for pat in [r'/api/[a-z0-9_/-]+', r'["_a-z0-9]+\.(?:json|mdx|md)', r'_rsc=', r'fetch\(', r'\.json']:
    found = re.findall(pat, joined_inline, re.I)
    uniq = list(dict.fromkeys(found))[:10]
    print(f'  pattern {pat!r}: {len(found)} hits, sample: {uniq}')
