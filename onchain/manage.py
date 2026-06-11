#!/usr/bin/env python3
"""Sign a LevManagerModule Retarget intent (EIP-712), relay execute(), submit the CoW order.
Usage: manage.py <reduce|increase> <safe> <ownerKeyFile> [extra json]
Reads live position; builds a fresh quote; signs as owner; calls module.execute via the relay EOA;
parses the Registered event for appData+uid; PUTs appData; POSTs the order. Prints the order uid."""
import json, subprocess, sys, time, urllib.request
from eth_utils import keccak
from eth_account import Account
from eth_abi import encode as abi_encode, decode as abi_decode

RPC = "https://rpc.gnosischain.com"
BARN = "https://barn.api.cow.fi/xdai/api/v1"
MODULE = "0xd504138eD8d6bF01A6C2c3e6f83298aE7242E985"
POOL = "0xb50201558B00496A145fE76f7424749556E326D8"
AWETH = "0xa818F1B57c201E092C4A2017A91815034326Efd1"
VDEBT = "0x281963D7471eCdC3A2Bd4503e24e89691cfe420D"
WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"
WETH = "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1"
RELAY_KEY = json.load(open("/home/ubuntu/.relay-key/safe-relay.json"))[0]["private_key"]

def cast(*args):
    return subprocess.run(["cast", *args], capture_output=True, text=True).stdout.strip()

def call(to, sig, *args):
    return cast("call", to, sig, *map(str, args), "--rpc-url", RPC)

def bal(token, who):
    return int(call(token, "balanceOf(address)(uint256)", who).split()[0])

def quote(sell, buy, frm, amt):
    body = json.dumps({"sellToken": sell, "buyToken": buy, "from": frm, "kind": "sell",
                       "sellAmountBeforeFee": str(amt), "signingScheme": "eip1271"}).encode()
    r = urllib.request.urlopen(urllib.request.Request(BARN + "/quote", body, {"content-type": "application/json"}))
    return int(json.load(r)["quote"]["buyAmount"])

def post(path, body):
    req = urllib.request.Request(BARN + path, json.dumps(body).encode(), {"content-type": "application/json"})
    try:
        return 200, json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def put_appdata(h, doc):
    req = urllib.request.Request(f"{BARN}/app_data/{h}", json.dumps({"fullAppData": doc}).encode(), {"content-type": "application/json"}, method="PUT")
    try:
        urllib.request.urlopen(req); return True
    except urllib.error.HTTPError as e:
        return e.code == 400  # 400 "already exists" is fine

RETARGET_TYPE = ("Retarget(address safe,uint256 nonce,uint256 deadline,uint8 mode,address collateral,"
                 "address debt,uint256 sellAmount,uint256 repayAmount,uint256 minBuy,uint256 flash,"
                 "uint32 orderValidTo,uint256 minHealthFactor)")

def build_retarget(mode, safe, slippage_bps=2000, fraction_bps=10000, extra=None):
    """REDUCE: sell `fraction` of collateral, repay proportional debt (MAX if fraction==100%).
    INCREASE: borrow + sell `extra` debt (default = current debt) for collateral, supply it."""
    coll = bal(AWETH, safe); debt = bal(VDEBT, safe)
    validTo = int(time.time()) + 1800
    deadline = int(time.time()) + 3600
    if mode == 0:  # REDUCE (close / partial / decrease-lev)
        full = fraction_bps >= 10000
        sellAmount = coll if full else coll * fraction_bps // 10000
        # proportional debt to repay keeps HF ~constant; full close repays MAX
        repayAmount = (2**256 - 1) if full else debt * fraction_bps // 10000
        flashBase = debt if full else repayAmount
        flash = flashBase * 103 // 100
        minBuy = quote(WETH, WXDAI, safe, sellAmount) * (10000 - slippage_bps) // 10000
        r = dict(safe=safe, nonce=int(time.time()), deadline=deadline, mode=0, collateral=WETH, debt=WXDAI,
                 sellAmount=sellAmount, repayAmount=repayAmount, minBuy=minBuy, flash=flash,
                 orderValidTo=validTo, minHealthFactor=0)
    else:  # INCREASE (no flash → borrow is capped by CURRENT Aave capacity, since the new collateral
           # is only supplied in `post`, after the borrow). Bigger increases need a flash-assisted flow.
        acct = call(POOL, "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)", safe).split("\n")
        availBase = int(acct[2].split()[0])         # availableBorrowsBase, 8-dec USD; WXDAI ~ $1
        capacity = availBase * 10**10 * 80 // 100    # -> WXDAI (18 dec), 80% safety margin
        borrowAmt = min(extra, capacity) if extra else capacity
        minBuy = quote(WXDAI, WETH, safe, borrowAmt) * (10000 - slippage_bps) // 10000
        r = dict(safe=safe, nonce=int(time.time()), deadline=deadline, mode=1, collateral=WETH, debt=WXDAI,
                 sellAmount=borrowAmt, repayAmount=0, minBuy=minBuy, flash=0,
                 orderValidTo=validTo, minHealthFactor=1050000000000000000)  # HF >= 1.05 postcondition
    return r

def domain_separator():
    return keccak(abi_encode(["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [keccak(text="EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
         keccak(text="LevManagerModule"), keccak(text="1"), 100, bytes.fromhex(MODULE[2:])]))

def sign_intent(r, owner_key):
    struct_hash = keccak(abi_encode(
        ["bytes32","address","uint256","uint256","uint8","address","address","uint256","uint256","uint256","uint256","uint32","uint256"],
        [keccak(text=RETARGET_TYPE), r["safe"], r["nonce"], r["deadline"], r["mode"], r["collateral"], r["debt"],
         r["sellAmount"], r["repayAmount"], r["minBuy"], r["flash"], r["orderValidTo"], r["minHealthFactor"]]))
    digest = keccak(b"\x19\x01" + domain_separator() + struct_hash)
    return Account._sign_hash(digest, owner_key).signature.hex()

def tuple_of(r):
    return (r["safe"], r["nonce"], r["deadline"], r["mode"], r["collateral"], r["debt"], r["sellAmount"],
            r["repayAmount"], r["minBuy"], r["flash"], r["orderValidTo"], r["minHealthFactor"])

def cast_tuple(r):
    """cast-CLI tuple literal: addresses unquoted, ints decimal."""
    return "(" + ",".join(str(x) for x in tuple_of(r)) + ")"

if __name__ == "__main__":
    mode = 0 if sys.argv[1] == "reduce" else 1
    safe = sys.argv[2]
    owner_key = json.load(open(sys.argv[3]))[0]["private_key"]
    arg4 = int(sys.argv[4]) if len(sys.argv) > 4 else None
    r = build_retarget(mode, safe, fraction_bps=(arg4 or 10000) if mode == 0 else 10000, extra=arg4 if mode == 1 else None)
    sig = "0x" + sign_intent(r, owner_key)
    print("intent:", json.dumps({k: str(v) for k, v in r.items()}))
    # relay execute()
    T = "(address,uint256,uint256,uint8,address,address,uint256,uint256,uint256,uint256,uint32,uint256)"
    txt = cast("send", MODULE, f"execute({T},bytes)", cast_tuple(r), sig,
               "--private-key", RELAY_KEY, "--rpc-url", RPC, "--json")
    rec = json.loads(txt)
    print("relay execute:", rec["status"], rec["transactionHash"])
    # parse Registered(safe, nonce, mode, uid, appDataHash, fullAppData) from logs
    log = [l for l in rec["logs"] if l["address"].lower() == MODULE.lower()][0]
    data = bytes.fromhex(log["data"][2:])
    # non-indexed: nonce(uint256), mode(uint8), uid(bytes), appDataHash(bytes32), fullAppData(string)
    nonce_, mode_, uid_, apphash_, json_ = abi_decode(["uint256","uint8","bytes","bytes32","string"], data)
    uid = "0x" + uid_.hex(); apphash = "0x" + apphash_.hex()
    print("registered uid:", uid)
    # PUT appData (retry until stored, then a brief beat before submit)
    for _ in range(6):
        if put_appdata(apphash, json_): break
        time.sleep(1)
    time.sleep(1)
    # order token sides per mode: REDUCE sells collateral->debt; INCREASE sells debt->collateral
    sellTok, buyTok = (WETH, WXDAI) if mode == 0 else (WXDAI, WETH)
    order = {"sellToken": sellTok, "buyToken": buyTok, "receiver": safe, "sellAmount": str(r["sellAmount"]),
             "buyAmount": str(r["minBuy"]), "validTo": r["orderValidTo"], "appData": apphash, "feeAmount": "0",
             "kind": "sell", "partiallyFillable": False, "sellTokenBalance": "erc20", "buyTokenBalance": "erc20",
             "signingScheme": "eip1271", "signature": "0x", "from": safe}
    code, resp = post("/orders", order)
    print("submit order:", code, resp)
    print("ORDER_UID", uid)
