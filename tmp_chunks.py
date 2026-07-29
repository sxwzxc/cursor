import sys, re, subprocess, concurrent.futures, json

html = sys.stdin.read()
srcs = re.findall(r'<script[^>]*src=["\']([^"\']+)["\']', html)
base = "https://cursor.com"
urls = [s if s.startswith("http") else base + s for s in srcs]
print(f"probing {len(urls)} JS chunks for pricing data...")

def probe(url):
    try:
        r = subprocess.run(
            ["curl", "-sL", "--max-time", "10", "-A",
             "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36", url],
            capture_output=True, text=True, timeout=15,
        )
        body = r.stdout
        # search for decisive pricing tokens that only appear in the model-pricing table
        has_sonnet = "Sonnet" in body
        has_price = ("$3.75" in body) or ("\"3.75\"" in body) or ("3.75" in body and "Sonnet" in body)
        has_cache_write = "Cache Write" in body or "cache_write" in body.lower() or "cacheWrite" in body
        has_per_million = "per million" in body.lower() or "perMillion" in body
        score = sum([has_sonnet, has_price, has_cache_write, has_per_million])
        name = url.split("/")[-1].split("?")[0]
        return (score, name, url, len(body), has_sonnet, has_price, has_cache_write, has_per_million)
    except Exception as e:
        return (0, url.split("/")[-1], url, 0, False, False, False, False)

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
    for r in ex.map(probe, urls):
        results.append(r)

results.sort(key=lambda x: -x[0])
print("\nTOP candidates (by pricing-token score):")
for r in results[:8]:
    print(f"  score={r[0]} size={r[3]} sonnet={r[4]} price={r[5]} cacheWrite={r[6]} perMillion={r[7]}")
    print(f"    {r[1]}  ->  {r[2]}")
