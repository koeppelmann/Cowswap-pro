#!/usr/bin/env python3
"""Exercise the WEBAPP's exact increase/decrease intent math against the live module.
Usage: test_adjust.py <increase|decrease> <safe> <ownerKeyFile> <targetLevX10>
Mirrors web/src/app/leverage/page.tsx doAdjust() so we test the page's code path, not manage.py's."""
import json, sys, time, urllib.request
import manage as M  # reuse helpers (quote, sign_intent, cast_tuple, put_appdata, post, bal, call, etc.)

RPC, BARN, MODULE, RELAY_KEY = M.RPC, M.BARN, M.MODULE, M.RELAY_KEY
AWETH, VDEBT, WETH, WXDAI, POOL = M.AWETH, M.VDEBT, M.WETH, M.WXDAI, M.POOL
SLIP_BPS = 200  # page uses max(slippagePct,2)% for manage

def status(uid):
    try: return json.load(urllib.request.urlopen(f"{BARN}/orders/{uid}"))["status"]
    except Exception: return "?"

def position(safe):
    acct = M.call(POOL, "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)", safe).split("\n")
    collBase = int(acct[0].split()[0]); debtBase = int(acct[1].split()[0]); availBase = int(acct[2].split()[0])
    coll = M.bal(AWETH, safe); debt = M.bal(VDEBT, safe)
    collUsd = collBase/1e8; debtUsd = debtBase/1e8; equityUsd = collUsd-debtUsd
    L = collUsd/equityUsd if equityUsd>0 else 0
    collQty = coll/1e18; price = collUsd/collQty if collQty>0 else 0
    return dict(coll=coll, debt=debt, availBase=availBase, equityUsd=equityUsd, L=L, price=price)

def relay_and_fill(r, owner_key, label):
    sig = "0x" + M.sign_intent(r, owner_key)
    print(f"  intent: {json.dumps({k:str(v) for k,v in r.items()})}")
    T = "(address,uint256,uint256,uint8,address,address,uint256,uint256,uint256,uint256,uint32,uint256)"
    rec = json.loads(M.cast("send", MODULE, f"execute({T},bytes)", M.cast_tuple(r), sig, "--private-key", RELAY_KEY, "--rpc-url", RPC, "--json"))
    print(f"  relay execute: status={rec['status']} tx={rec['transactionHash']}")
    if rec["status"] not in ("0x1", 1): print("  RELAY REVERTED"); return None
    log = [l for l in rec["logs"] if l["address"].lower()==MODULE.lower()][0]
    from eth_abi import decode as abi_decode
    _,_,uid_,apphash_,jsondoc = abi_decode(["uint256","uint8","bytes","bytes32","string"], bytes.fromhex(log["data"][2:]))
    uid="0x"+uid_.hex(); apphash="0x"+apphash_.hex()
    for _ in range(6):
        if M.put_appdata(apphash, jsondoc): break
        time.sleep(1)
    time.sleep(1)
    sellTok, buyTok = (WETH, WXDAI) if r["mode"]==0 else (WXDAI, WETH)
    order = {"sellToken":sellTok,"buyToken":buyTok,"receiver":r["safe"],"sellAmount":str(r["sellAmount"]),
             "buyAmount":str(r["minBuy"]),"validTo":r["orderValidTo"],"appData":apphash,"feeAmount":"0",
             "kind":"sell","partiallyFillable":False,"sellTokenBalance":"erc20","buyTokenBalance":"erc20",
             "signingScheme":"eip1271","signature":"0x","from":r["safe"]}
    code, body = M.post("/orders", order)
    print(f"  submit order: {code} {str(body)[:80]}")
    if code != 200: return None
    uid2 = body
    for _ in range(40):
        st = status(uid2)
        if st == "fulfilled": print(f"  {label}: FILLED ✅"); return uid2
        if st in ("cancelled","expired"): print(f"  {label}: {st}"); return None
        time.sleep(8)
    print(f"  {label}: timeout"); return None

def build(action, safe, target):
    p = position(safe); L = p["L"]; E = p["equityUsd"]; price = p["price"]
    validTo = int(time.time())+1800; deadline = int(time.time())+3600
    print(f"  current L={L:.3f} equity={E:.5f} WXDAI price={price:.2f}")
    if action == "increase":
        delta = (target - L) * E
        sellAmount = int(delta * 1e18)
        cap = p["availBase"] * 10**10 * 90 // 100
        if sellAmount > cap: print(f"  exceeds capacity {cap}"); sys.exit(1)
        minBuy = M.quote(WXDAI, WETH, safe, sellAmount) * (10000-SLIP_BPS)//10000
        return dict(safe=safe,nonce=int(time.time()),deadline=deadline,mode=1,collateral=WETH,debt=WXDAI,
                    sellAmount=sellAmount,repayAmount=0,minBuy=minBuy,flash=0,orderValidTo=validTo,
                    minHealthFactor=1050000000000000000)
    else:
        delta = (L - target) * E
        repayAmount = int(delta * 1e18)
        sellAmount = int((delta/price)*1.05 * 1e18)
        flash = repayAmount * 103 // 100
        minBuy = M.quote(WETH, WXDAI, safe, sellAmount) * (10000-SLIP_BPS)//10000
        return dict(safe=safe,nonce=int(time.time()),deadline=deadline,mode=0,collateral=WETH,debt=WXDAI,
                    sellAmount=sellAmount,repayAmount=repayAmount,minBuy=minBuy,flash=flash,orderValidTo=validTo,
                    minHealthFactor=0)

if __name__ == "__main__":
    action, safe, keyfile, targetX10 = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    target = targetX10/10.0
    owner_key = json.load(open(keyfile))[0]["private_key"]
    print(f"== {action} -> {target}x on {safe} ==")
    r = build(action, safe, target)
    relay_and_fill(r, owner_key, action)
    p = position(safe)
    print(f"  after: L={p['L']:.3f} coll={p['coll']} debt={p['debt']} equity={p['equityUsd']:.5f}")
