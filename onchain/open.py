#!/usr/bin/env python3
"""Open a leveraged position via the carrier-order flow (IntentBootstrap7).
Usage: open.py <ownerKeyFile> <equityWei> <leverageX1000>   e.g. open.py key.json 10000000000000000 2000
Funds the user (from deployer) if needed, signs ONE carrier order, submits, waits for Safe deploy +
leverage fill. Prints the Safe address."""
import json, subprocess, sys, time, urllib.request, urllib.error
from eth_utils import keccak
from eth_account import Account

RPC = "https://rpc.gnosischain.com"
BARN = "https://barn.api.cow.fi/xdai/api/v1"
IB7 = "0x0795ec54A7C79403C2CD6BE77C738bf298670Da5"
SETTLEMENT = "0xf553d092b50bdcbddeD1A99aF2cA29FBE5E2CB13"
RELAYER = "0xC7242d167563352E2BCA4d71C043fbe542DB8FB2"
WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"
WETH = "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1"
DEPLOYER_KEY = json.load(open("/home/ubuntu/code/twap/.deployer/key.json"))[0]["private_key"]
INTENT_T = "(address,uint256,uint256,uint256,uint256,uint256,uint32,uint256)"

def cast(*a): return subprocess.run(["cast", *map(str, a)], capture_output=True, text=True).stdout.strip()
def send(*a): return json.loads(cast("send", *a, "--rpc-url", RPC, "--json"))
def bal(t, w): return int(cast("call", t, "balanceOf(address)(uint256)", w, "--rpc-url", RPC).split()[0] or 0)
def quote(sell, buy, frm, amt):
    body = json.dumps({"sellToken": sell, "buyToken": buy, "from": frm, "kind": "sell", "sellAmountBeforeFee": str(amt), "signingScheme": "eip1271"}).encode()
    return int(json.load(urllib.request.urlopen(urllib.request.Request(BARN + "/quote", body, {"content-type": "application/json"})))["quote"]["buyAmount"])
def put(h, doc):
    try: urllib.request.urlopen(urllib.request.Request(f"{BARN}/app_data/{h}", json.dumps({"fullAppData": doc}).encode(), {"content-type": "application/json"}, method="PUT"))
    except urllib.error.HTTPError: pass
def post(path, body):
    try: return 200, json.load(urllib.request.urlopen(urllib.request.Request(BARN + path, json.dumps(body).encode(), {"content-type": "application/json"})))
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
def status(uid):
    try: return json.load(urllib.request.urlopen(f"{BARN}/orders/{uid}"))["status"]
    except Exception: return "open"

owner_key = json.load(open(sys.argv[1]))[0]["private_key"]
owner = Account.from_key(owner_key).address
equity = int(sys.argv[2]); levx = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
flash = equity * levx // 1000
repay = flash * 10006 // 10000
borrow = repay - equity
buyMin = quote(WXDAI, WETH, "0x25a9A92F3bD7Ce47cFD48a896C5590Cf8F5A03Fb", flash) * 80 // 100
validTo = int(time.time()) + 86400
intent = (owner, equity, flash, buyMin, borrow, repay, validTo, 1)
itup = "(" + ",".join(str(x) for x in intent) + ")"
safe = cast("call", IB7, f"safeOf({INTENT_T})(address)", itup, "--rpc-url", RPC)

# fund the owner (equity*1.05 + gas) and set the relayer allowance
need = equity * 105 // 100
if bal(WXDAI, owner) < need:
    send(WXDAI, "transfer(address,uint256)", owner, need, "--private-key", DEPLOYER_KEY); time.sleep(2)
if int(cast("balance", owner, "--rpc-url", RPC)) < 3 * 10**15:
    send(owner, "--value", 3 * 10**15, "--private-key", DEPLOYER_KEY); time.sleep(2)
if int(cast("call", WXDAI, "allowance(address,address)(uint256)", owner, RELAYER, "--rpc-url", RPC).split()[0] or 0) < need:
    send(WXDAI, "approve(address,uint256)", RELAYER, need, "--private-key", owner_key); time.sleep(2)

lev_json, lev_hash = cast("call", IB7, f"appData({INTENT_T},address)(string,bytes32)", itup, safe, "--rpc-url", RPC).split("\n")
lev_json = lev_json.strip().strip('"').replace('\\"', '"')
boot = cast("calldata", f"bootstrap({INTENT_T})", itup)

cv = int(time.time()) + 3600
carrier_doc = json.dumps({"appCode": "koeppelmann/cowswap_wrapper", "environment": "barn",
    "metadata": {"hooks": {"pre": [{"target": IB7, "callData": boot, "gasLimit": "3000000"}], "post": []}}, "version": "1.6.0"}, separators=(",", ":"))
ch = "0x" + keccak(text=carrier_doc).hex()
sell = equity * 105 // 100
order = {"sellToken": WXDAI, "buyToken": WXDAI, "receiver": safe, "sellAmount": str(sell), "buyAmount": str(equity), "validTo": cv,
         "appData": ch, "feeAmount": "0", "kind": "sell", "partiallyFillable": False, "sellTokenBalance": "erc20", "buyTokenBalance": "erc20"}
typed = {"types": {"EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"}, {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
    "Order": [{"name": n, "type": t} for n, t in [("sellToken", "address"), ("buyToken", "address"), ("receiver", "address"), ("sellAmount", "uint256"), ("buyAmount", "uint256"), ("validTo", "uint32"), ("appData", "bytes32"), ("feeAmount", "uint256"), ("kind", "string"), ("partiallyFillable", "bool"), ("sellTokenBalance", "string"), ("buyTokenBalance", "string")]]},
    "primaryType": "Order", "domain": {"name": "Gnosis Protocol", "version": "v2", "chainId": 100, "verifyingContract": SETTLEMENT},
    "message": {**{k: int(order[k]) if k in ("sellAmount", "buyAmount", "feeAmount") else order[k] for k in order if k != "validTo"}, "validTo": cv}}
sig = Account.sign_typed_data(owner_key, full_message=typed)
put(ch, carrier_doc)
c, resp = post("/orders", {**order, "signingScheme": "eip712", "signature": "0x" + sig.signature.hex(), "from": owner})
print("carrier:", c, str(resp)[:80]); cuid = resp if c == 200 else None
while status(cuid) == "open": time.sleep(12)
print("carrier", status(cuid), "| safe code:", len(cast("code", safe, "--rpc-url", RPC)))

# submit leverage order
put(lev_hash, lev_json)
lev = {"sellToken": WXDAI, "buyToken": WETH, "receiver": safe, "sellAmount": str(flash), "buyAmount": str(buyMin), "validTo": validTo,
       "appData": lev_hash, "feeAmount": "0", "kind": "sell", "partiallyFillable": False, "sellTokenBalance": "erc20", "buyTokenBalance": "erc20",
       "signingScheme": "eip1271", "signature": "0x", "from": safe}
c, resp = post("/orders", lev)
print("leverage:", c, str(resp)[:80]); luid = resp if c == 200 else None
while status(luid) == "open": time.sleep(12)
print("leverage", status(luid))
print("SAFE", safe)
